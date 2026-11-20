// Locale and time coherence across the window, dedicated/shared workers, a
// service worker and the HTTP Accept-Language header.
//
// Exact sample values are never asserted. Checks compare realms with each other
// and require that the two DST-season dates stay semantically coherent with the
// resolved timezone. A context that resolves to UTC will legitimately report the
// same offset twice; that is recorded, not failed.

import { STATUS, acquirePage, closeQuietly, finish, recorder } from "./support.mjs";

const SAMPLER = `
function sampleLocale() {
  const resolved = new Intl.DateTimeFormat().resolvedOptions();
  const dates = [Date.UTC(2026, 0, 15, 12), Date.UTC(2026, 6, 15, 12)];
  const long = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" });
  const zoneFormatter = new Intl.DateTimeFormat(undefined, { timeZoneName: "longOffset" });
  return {
    language: navigator.language,
    languages: Array.from(navigator.languages),
    locale: resolved.locale,
    timeZone: resolved.timeZone,
    calendar: resolved.calendar,
    numberingSystem: resolved.numberingSystem,
    hourCycle: resolved.hourCycle ?? null,
    number: new Intl.NumberFormat().format(1234567.89),
    fullDate: long.format(new Date(dates[0])),
    seasonDates: dates.map((epoch) => {
      const date = new Date(epoch);
      const parts = zoneFormatter.formatToParts(date);
      return {
        epoch,
        iso: date.toISOString(),
        tzOffsetMinutes: date.getTimezoneOffset(),
        zone: parts.find((part) => part.type === "timeZoneName")?.value ?? null,
        formatted: long.format(date)
      };
    })
  };
}
`;

const DEDICATED = `${SAMPLER}
self.onmessage = () => { self.postMessage(sampleLocale()); };`;

const SHARED = `${SAMPLER}
self.onconnect = (event) => {
  const port = event.ports[0];
  port.onmessage = () => port.postMessage(sampleLocale());
  port.start();
};`;

const SERVICE = `${SAMPLER}
self.addEventListener("message", (event) => {
  const port = event.ports && event.ports[0];
  if (port) port.postMessage(sampleLocale());
});`;

function primary(tag) {
  return String(tag ?? "").split("-")[0].toLowerCase();
}

function zoneMinutes(zone) {
  if (typeof zone !== "string") return null;
  if (zone === "GMT" || zone === "UTC") return 0;
  const match = /^(?:GMT|UTC)?([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(zone);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

function sameSeasonOffsets(left, right) {
  return (
    JSON.stringify(left.seasonDates.map((entry) => entry.tzOffsetMinutes)) ===
    JSON.stringify(right.seasonDates.map((entry) => entry.tzOffsetMinutes))
  );
}

function sameRealmFormatting(left, right) {
  return (
    left.locale === right.locale &&
    left.timeZone === right.timeZone &&
    left.number === right.number &&
    left.fullDate === right.fullDate &&
    sameSeasonOffsets(left, right)
  );
}

function sameRealmSample(left, right) {
  return left.language === right.language && sameRealmFormatting(left, right);
}

const probe = {
  id: "locale/realm-coherence",
  family: "locale",
  timeoutMs: 40_000,
  contextOptions: {},
  async run({ page, context, origin, deadline }) {
    const rec = recorder();
    let routeHandler = null;
    const owned = await acquirePage({ page, context, origin });
    try {
      const workerBudget = Math.min(6_000, Math.max(1_000, (deadline ?? Infinity) - Date.now()));
      let windowSample;
      try {
        windowSample = await owned.page.evaluate(`(() => { ${SAMPLER}; return sampleLocale(); })()`);
      } catch (error) {
        rec.unknown("navigator.languages is non-empty and starts with navigator.language", "unavailable", `${error.name}: ${error.message}`);
        rec.limit("sampler-unavailable", "The probe's own sampler could not be evaluated in this document; no locale verdict is possible.");
        return finish(rec, { samplerError: `${error.name}: ${error.message}` });
      }
      const realm = await owned.page.evaluate(
        async ({ dedicatedSource, sharedSource, budget }) => {
          const makeWorker = (source) => {
            const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
            return { url, worker: new Worker(url) };
          };
          const askDedicated = () =>
            new Promise((resolve) => {
              const created = makeWorker(dedicatedSource);
              const timer = setTimeout(() => {
                created.worker.terminate();
                URL.revokeObjectURL(created.url);
                resolve({ ok: false, reason: "dedicated worker timeout" });
              }, budget);
              created.worker.onmessage = (event) => {
                clearTimeout(timer);
                created.worker.terminate();
                URL.revokeObjectURL(created.url);
                resolve({ ok: true, value: event.data });
              };
              created.worker.onerror = (event) => {
                clearTimeout(timer);
                created.worker.terminate();
                URL.revokeObjectURL(created.url);
                resolve({ ok: false, reason: event.message ?? "dedicated worker error" });
              };
              created.worker.postMessage("sample");
            });
          const askShared = () =>
            new Promise((resolve) => {
              let created;
              try {
                const url = URL.createObjectURL(new Blob([sharedSource], { type: "text/javascript" }));
                created = new SharedWorker(url);
                created.port.start();
                const timer = setTimeout(() => resolve({ ok: false, reason: "shared worker timeout" }), budget);
                created.port.onmessage = (event) => {
                  clearTimeout(timer);
                  created.port.close();
                  URL.revokeObjectURL(url);
                  resolve({ ok: true, value: event.data });
                };
                created.port.onmessageerror = () => {
                  clearTimeout(timer);
                  created.port.close();
                  URL.revokeObjectURL(url);
                  resolve({ ok: false, reason: "shared worker message error" });
                };
                created.port.postMessage("sample");
              } catch (error) {
                resolve({ ok: false, reason: `${error.name}: ${error.message}` });
              }
            });
          const dedicated = await askDedicated();
          const shared = await askShared();
          return { dedicated, shared };
        },
        { dedicatedSource: DEDICATED, sharedSource: SHARED, budget: workerBudget },
      );

      // Capture the document request's Accept-Language without priming content.
      let acceptLanguage = null;
      const onRequest = (request) => {
        try {
          if (!request.isNavigationRequest() || request.frame() !== owned.page.mainFrame()) return;
        } catch {
          return;
        }
        const header = request.headers()["accept-language"];
        if (header && acceptLanguage === null) acceptLanguage = header;
      };
      owned.page.on("request", onRequest);
      try {
        await owned.page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
      } finally {
        owned.page.off("request", onRequest);
      }

      // Service worker: serve a probe-owned script at a unique same-origin path.
      routeHandler = (route) =>
        route.fulfill({ status: 200, contentType: "application/javascript", body: SERVICE });
      await context.route("**/__cloakium_locale_sw.js", routeHandler);
      const service = await owned.page.evaluate(async ({ url, budget }) => {
        if (!("serviceWorker" in navigator)) return { ok: false, reason: "serviceWorker unavailable" };
        try {
          const registration = await navigator.serviceWorker.register(url, { scope: "/" });
          const active =
            registration.active ??
            (await new Promise((resolve) => {
              const candidate = registration.installing ?? registration.waiting;
              if (!candidate) return resolve(null);
              const timer = setTimeout(() => resolve(null), budget);
              candidate.addEventListener("statechange", () => {
                if (candidate.state === "activated") {
                  clearTimeout(timer);
                  resolve(candidate);
                }
              });
            }));
          if (!active) {
            await registration.unregister().catch(() => {});
            return { ok: false, reason: "service worker did not activate" };
          }
          const value = await new Promise((resolve) => {
            const channel = new MessageChannel();
            const timer = setTimeout(() => resolve(null), budget);
            channel.port1.onmessage = (event) => {
              clearTimeout(timer);
              resolve(event.data);
            };
            active.postMessage("sample", [channel.port2]);
          });
          await registration.unregister().catch(() => {});
          return value ? { ok: true, value } : { ok: false, reason: "service worker did not reply" };
        } catch (error) {
          return { ok: false, reason: `${error.name}: ${error.message}` };
        }
      }, { url: "/__cloakium_locale_sw.js", budget: workerBudget });

      const dedicated = realm.dedicated;
      const shared = realm.shared;

      rec.expect("navigator.languages is non-empty and starts with navigator.language", windowSample.languages.length > 0 && windowSample.languages[0] === windowSample.language);
      rec.expect("Intl locale agrees with navigator.language's language", primary(windowSample.locale) === primary(windowSample.language));
      rec.expect("Intl exposes a non-empty timezone", typeof windowSample.timeZone === "string" && windowSample.timeZone.length > 0);

      const offsetCoherent = windowSample.seasonDates.every((entry) => {
        const parsed = zoneMinutes(entry.zone);
        return parsed === null || entry.tzOffsetMinutes === -parsed;
      });
      rec.expect("Date offsets agree with Intl longOffset in both seasons", offsetCoherent);

      const zoneMinutesPair = windowSample.seasonDates.map((entry) => zoneMinutes(entry.zone));
      const offsetPair = windowSample.seasonDates.map((entry) => entry.tzOffsetMinutes);
      const zoneDiffers = zoneMinutesPair[0] !== zoneMinutesPair[1];
      const offsetDiffers = offsetPair[0] !== offsetPair[1];
      rec.expect(
        zoneDiffers ? "DST seasons change Date and Intl offsets together" : "a non-DST resolved zone keeps both offsets equal",
        zoneDiffers === offsetDiffers,
      );

      if (dedicated.ok) {
        rec.expect("dedicated worker locale, timezone and formatting match the window", sameRealmSample(windowSample, dedicated.value));
        rec.expect("dedicated worker keeps identical epoch values for both seasons", dedicated.value.seasonDates.every((entry, index) => entry.epoch === windowSample.seasonDates[index].epoch));
      } else {
        rec.unknown("dedicated worker locale, timezone and formatting match the window", "unavailable", dedicated.reason);
      }
      if (shared.ok) {
        rec.expect("shared worker timezone and formatting match the window", sameRealmFormatting(windowSample, shared.value));
        rec.expect("shared worker language matches the window", shared.value.language === windowSample.language, `${shared.value.language} vs ${windowSample.language}`);
      } else {
        rec.unknown("shared worker timezone and formatting match the window", "unavailable", shared.reason);
        rec.unknown("shared worker language matches the window", "unavailable", shared.reason);
      }
      if (service.ok) {
        rec.expect("service worker locale, timezone and formatting match the window", sameRealmSample(windowSample, service.value));
      } else {
        rec.unknown("service worker locale, timezone and formatting match the window", STATUS.unsupported, service.reason);
      }
      if (acceptLanguage) {
        const firstTag = acceptLanguage.split(",")[0].trim();
        rec.expect("Accept-Language's first language matches navigator.language", primary(firstTag) === primary(windowSample.language));
      } else {
        rec.unknown("Accept-Language's first language matches navigator.language", "unavailable", "no navigation request header captured");
      }
      rec.limit("worker-scope", "Workers inherit the context locale/timezone; this probe does not force a per-worker override.");
      rec.limit("shared-worker-locale", "Unpatched Chromium can resolve SharedWorker navigator.language from the browser process instead of the context locale; a mismatch is a real coherence gap and an emulation boundary to verify against a fixed product locale.");
      rec.limit("service-worker-route", "The service-worker script is fulfilled through context routing; a harness that blocks routing reports the SW checks as unsupported.");

      return finish(rec, {
        window: windowSample,
        dedicated: dedicated.ok ? dedicated.value : { unavailable: dedicated.reason },
        shared: shared.ok ? shared.value : { unavailable: shared.reason },
        serviceWorker: service.ok ? service.value : { unavailable: service.reason },
        acceptLanguage,
        dstObserved: zoneDiffers,
        seasonOffsetsMinutes: offsetPair,
      });
    } finally {
      if (routeHandler) await context.unroute("**/__cloakium_locale_sw.js", routeHandler).catch(() => {});
      if (owned.owned) await closeQuietly(owned.page);
    }
  },
};

export const probes = [probe];
