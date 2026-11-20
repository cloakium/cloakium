// Permission descriptor semantics without hardware capture.
//
// The probe queries descriptors, checks state stability and the PermissionStatus
// shape, then exercises a context-level grant/clear transition for geolocation.
// It never calls getUserMedia, getDisplayMedia or a notification prompt.

import { acquirePage, closeQuietly, finish, recorder } from "./support.mjs";

const DESCRIPTORS = [
  { name: "geolocation" },
  { name: "notifications" },
  { name: "camera" },
  { name: "microphone" },
  { name: "clipboard-read" },
  { name: "midi" },
  { name: "push", userVisibleOnly: true },
  { name: "persistent-storage" },
];

const probe = {
  id: "permissions/descriptor-semantics",
  family: "permissions",
  timeoutMs: 30_000,
  contextOptions: {},
  async run({ page, context, origin }) {
    const rec = recorder();
    const owned = await acquirePage({ page, context, origin });
    try {
      const queried = await owned.page.evaluate(async (descriptors) => {
        if (!navigator.permissions || typeof navigator.permissions.query !== "function") {
          return { available: false };
        }
        const rows = [];
        for (const descriptor of descriptors) {
          try {
            const first = await navigator.permissions.query(descriptor);
            const second = await navigator.permissions.query(descriptor);
            rows.push({
              descriptor: descriptor.name,
              supported: true,
              state: first.state,
              repeatState: second.state,
              statusName: first.name,
              stateEnum: ["granted", "denied", "prompt"].includes(first.state),
              hasOnChange: "onchange" in first,
              hasAddEventListener: typeof first.addEventListener === "function",
              hasRemoveEventListener: typeof first.removeEventListener === "function",
              distinctObjects: first !== second,
            });
          } catch (error) {
            rows.push({ descriptor: descriptor.name, supported: false, error: error.name, message: error.message });
          }
        }
        let invalid = null;
        try {
          await navigator.permissions.query({ name: "cloakium-not-a-permission" });
          invalid = "resolved";
        } catch (error) {
          invalid = error.name;
        }
        return { available: true, rows, invalid };
      }, DESCRIPTORS);

      if (!queried.available) {
        rec.unknown("Permissions.query is available", "unavailable", "navigator.permissions.query is missing");
        rec.unknown("supported descriptors return valid states", "unavailable", "no Permissions API");
        rec.unknown("repeated descriptor queries are stable", "unavailable", "no Permissions API");
        rec.unknown("unsupported descriptor names reject with TypeError", "unavailable", "no Permissions API");
        rec.unknown("PermissionStatus exposes a non-empty name, valid state and listeners", "unavailable", "no Permissions API");
        rec.unknown("context grant propagates to descriptor state", "unavailable", "no Permissions API");
        rec.unknown("context clear removes the grant", "unavailable", "no Permissions API");
        rec.limit("permissions-absent", "A missing Permissions API is a capability observation, not a pass.");
        return finish(rec, { available: false });
      }

      const supported = queried.rows.filter((row) => row.supported);
      const unsupported = queried.rows.filter((row) => !row.supported);
      rec.expect("Permissions.query is available", true);
      rec.expect("supported descriptors return valid states", supported.length > 0 && supported.every((row) => row.stateEnum), `${supported.length} supported`);
      rec.expect("repeated descriptor queries are stable", supported.every((row) => row.state === row.repeatState));
      rec.expect("unsupported descriptor names reject with TypeError", queried.invalid === "TypeError", String(queried.invalid));
      rec.expect("PermissionStatus exposes a non-empty name, valid state and listeners", supported.every((row) => typeof row.statusName === "string" && row.statusName.length > 0 && row.stateEnum && row.hasOnChange && row.hasAddEventListener && row.hasRemoveEventListener));

      let grant = null;
      try {
        await context.grantPermissions(["geolocation"], { origin });
        const granted = await owned.page.evaluate(async () => {
          const status = await navigator.permissions.query({ name: "geolocation" });
          return status.state;
        });
        grant = { granted: true, state: granted };
      } catch (error) {
        grant = { granted: false, reason: `${error.name}: ${error.message}` };
      }
      if (grant.granted) {
        rec.expect("context grant propagates to descriptor state", grant.state === "granted", grant.state);
        try {
          await context.clearPermissions();
          const cleared = await owned.page.evaluate(async () => {
            const status = await navigator.permissions.query({ name: "geolocation" });
            return status.state;
          });
          grant.clearedState = cleared;
          rec.expect("context clear removes the grant", cleared !== "granted", cleared);
        } catch (error) {
          grant.clearError = `${error.name}: ${error.message}`;
          rec.unknown("context clear removes the grant", "unavailable", grant.clearError);
        }
      } else {
        rec.unknown("context grant propagates to descriptor state", "unavailable", grant.reason);
        rec.unknown("context clear removes the grant", "unavailable", grant.reason);
      }
      rec.limit("no-capture", "No camera, microphone, geolocation or notification capture API was called; only permission state metadata was read.");
      rec.limit("context-scope", "Grant and clear are Playwright context operations; browser UI policy and OS-level permission dialogs are not exercised. clearPermissions also removes any context-level grants the harness set, so use a fresh context per probe.");
      rec.limit("unsupported", `Unsupported descriptors: ${unsupported.map((row) => row.descriptor).join(", ") || "none"}.`);

      return finish(rec, {
        descriptors: queried.rows,
        supported: supported.map((row) => ({ descriptor: row.descriptor, state: row.state })),
        unsupported: unsupported.map((row) => ({ descriptor: row.descriptor, error: row.error })),
        invalidQuery: queried.invalid,
        grant,
        noCaptureApisCalled: true,
      });
    } finally {
      await context.clearPermissions().catch(() => {});
      if (owned.owned) await closeQuietly(owned.page);
    }
  },
};

export const probes = [probe];
