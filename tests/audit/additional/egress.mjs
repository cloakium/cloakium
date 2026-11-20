// Page-scope egress inventory.
//
// This probe can prove that a page-initiated request is observable. It cannot
// prove that the browser process makes no background requests. That absence
// check is reported as coverage-unknown with the method required to resolve it.

import { STATUS, closeQuietly, finish, recorder } from "./support.mjs";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

function classify(url, allowedOrigins) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "data:" || parsed.protocol === "blob:") return "local";
    if (allowedOrigins.has(parsed.origin)) return "fixture";
    if (LOOPBACK.has(parsed.hostname)) return "other-loopback";
    return "external";
  } catch {
    return "invalid";
  }
}

const probe = {
  id: "egress/request-inventory",
  family: "egress",
  timeoutMs: 30_000,
  contextOptions: {},
  async run({ page, context, origin, crossOrigin, deadline }) {
    const rec = recorder();
    const owned = !page;
    const cross = crossOrigin ?? origin;
    const target = page ?? (await context.newPage());
    const seen = new Set();
    const requests = [];
    const failures = [];
    const onRequest = (request) => {
      if (seen.has(request)) return;
      seen.add(request);
      try {
        requests.push({ url: request.url(), method: request.method(), resourceType: request.resourceType(), frame: request.frame() === target.mainFrame() ? "main" : "frame" });
      } catch {
        requests.push({ url: request.url(), method: request.method(), resourceType: request.resourceType(), frame: "unknown" });
      }
    };
    const onFailed = (request) => {
      try {
        failures.push({ url: request.url(), error: request.failure()?.errorText ?? null });
      } catch {
        failures.push({ url: request.url(), error: null });
      }
    };
    context.on("request", onRequest);
    target.on("request", onRequest);
    context.on("requestfailed", onFailed);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, Math.max(100, (deadline ?? Infinity) - Date.now()))));
    try {
      await target.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 10_000 });
      await sleep(1_200);
      const quiet = requests.slice();

      const fetchOutcome = await target.evaluate(async (url) => {
        try {
          await fetch(url, { mode: "no-cors", cache: "no-store" });
          return "resolved";
        } catch (error) {
          return error.name;
        }
      }, `${cross}/__cloakium_egress_fetch__`);
      const beacon = await target.evaluate((url) => {
        if (typeof navigator.sendBeacon !== "function") return { available: false, accepted: null };
        try {
          return { available: true, accepted: navigator.sendBeacon(url, "cloakium-probe") };
        } catch (error) {
          return { available: true, accepted: false, error: error.name };
        }
      }, `${cross}/__cloakium_egress_beacon__`);
      await target.evaluate((url) => {
        const image = new Image();
        image.src = url;
        document.body.append(image);
      }, `${cross}/__cloakium_egress_image__`);
      await sleep(800);

      const allowed = new Set([new URL(origin).origin, new URL(cross).origin]);
      const inventory = requests.map((request) => ({ ...request, scope: classify(request.url, allowed) }));
      const quietInventory = quiet.map((request) => ({ ...request, scope: classify(request.url, allowed) }));
      const has = (needle, list = inventory) => list.some((request) => request.url.includes(needle));
      const external = inventory.filter((request) => request.scope === "external");
      const quietExternal = quietInventory.filter((request) => request.scope === "external");

      rec.expect("Playwright request events are available", inventory.length > 0);
      rec.expect("the fixture document request is observed", inventory.some((request) => request.resourceType === "document" && request.scope === "fixture"));
      rec.expect("page fetch is observed", has("__cloakium_egress_fetch__"));
      if (beacon.available) {
        rec.expect("sendBeacon is observed when accepted", has("__cloakium_egress_beacon__"), beacon.accepted === false ? "sendBeacon returned false" : undefined);
      } else {
        rec.unknown("sendBeacon is observed when accepted", STATUS.unsupported, "navigator.sendBeacon is unavailable");
      }
      rec.expect("image request is observed", has("__cloakium_egress_image__"));
      rec.expect("no external origin was requested during the quiet period", quietExternal.length === 0, `${quietExternal.length} external request(s)`);
      rec.unknown(
        "browser-process background egress absence",
        STATUS.coverageUnknown,
        "Playwright page/context events cannot observe browser-process traffic; use OS socket/DNS/packet capture, browser-process logging or a network namespace.",
      );
      rec.limit("scope", "Only renderer-initiated requests visible to Playwright are inventoried; component updates, variations, DNS prefetch, DoH and extension traffic are outside this view.");
      rec.limit("fixture-egress", "The probe deliberately fetches, beacons and loads an image from the supplied loopback origins to show that inventory is capable of seeing egress.");
      rec.limit("launch-args", "Playwright adds background-networking and component-update suppression arguments by default; record the launch profile (adapter defaults versus native defaults) alongside any quiet-period result.");

      return finish(rec, {
        inventory,
        quietInventory,
        external,
        failures,
        fetchOutcome,
        beacon,
        allowedOrigins: [...allowed],
        requestEventCount: inventory.length,
        quietRequestCount: quietInventory.length,
        coverageGap: {
          check: "browser-process background egress absence",
          requiredMethods: ["OS packet or socket capture", "DNS query capture", "browser-process netlog", "network namespace isolation"],
        },
      });
    } finally {
      context.off("request", onRequest);
      target.off("request", onRequest);
      context.off("requestfailed", onFailed);
      if (owned) await closeQuietly(target);
    }
  },
};

export const probes = [probe];
