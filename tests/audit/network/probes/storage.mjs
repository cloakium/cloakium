import { fail, inconclusive, pass, result, stageNeeded, unavailable } from "./kit.mjs";

async function estimate(page) {
  return page.evaluate(async () => {
    const value = await navigator.storage.estimate();
    return { quota: value.quota ?? null, usage: value.usage ?? null, usageDetails: value.usageDetails ?? null };
  });
}

export const probes = [
  {
    id: "storage.quota-coherence",
    family: "storage",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.origin", "CDP Storage.getUsageAndQuota"],
      launchArgs: [],
      contextOptions: {},
      profileLifecycle: "none",
      relaunch: false,
      needs: "a fresh context so usage starts near zero (small writes only)",
    },
    async run({ context, origin }) {
      const page = await context.newPage();
      let cdp = null;
      try {
        await page.goto(`${origin}/storage`, { waitUntil: "domcontentloaded" });
        const before = await estimate(page);

        const written = await page.evaluate(async () => {
          localStorage.setItem("lab-quota", "x".repeat(1024));
          const cache = await caches.open("lab-quota-cache");
          await cache.put("/lab-quota-item", new Response("y".repeat(2048)));
          const database = await new Promise((resolve, reject) => {
            const request = indexedDB.open("lab-quota-db", 1);
            request.onupgradeneeded = () => request.result.createObjectStore("values");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          await new Promise((resolve, reject) => {
            const transaction = database.transaction("values", "readwrite");
            transaction.objectStore("values").put("z".repeat(4096), "key");
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
          });
          database.close();
          const stored = await cache.match("/lab-quota-item");
          return {
            localStorageBytes: (localStorage.getItem("lab-quota") ?? "").length,
            cacheHit: Boolean(stored),
            cacheBytes: stored ? (await stored.text()).length : 0,
            totalBytesWritten: 1024 + 2048 + 4096,
          };
        });

        const after = await estimate(page);
        if (!before || !written || !after) {
          return result({
            observations: { before, written, after },
            checks: [stageNeeded("storage-api-available", "navigator.storage.estimate() did not return a usable value")],
            limitations: ["Storage APIs were not evaluable in this target."],
          });
        }

        try {
          cdp = await context.newCDPSession(page);
        } catch {
          cdp = null;
        }
        let cdpUsage = null;
        if (!cdp) {
          cdpUsage = { error: "CDP session unavailable on this target" };
        } else {
          try {
            const quota = await cdp.send("Storage.getUsageAndQuota", { origin });
            cdpUsage = { usage: quota.usage ?? null, quota: quota.quota ?? null, breakdown: quota.usageBreakdown ?? null };
          } catch (error) {
            cdpUsage = { error: String(error.message).split("\n")[0] };
          }
        }

        const checks = [
          Number.isFinite(before.quota) && before.quota > 0
            ? pass("estimate-quota-positive", `quota=${before.quota}`)
            : fail("estimate-quota-positive", `quota=${before.quota}`),
          Number.isFinite(before.usage) && before.usage >= 0
            ? pass("estimate-usage-non-negative", `usage=${before.usage}`)
            : fail("estimate-usage-non-negative", `usage=${before.usage}`),
          written.localStorageBytes === 1024 && written.cacheHit
            ? pass("storage-writes-succeeded", `cacheBytes=${written.cacheBytes}`)
            : fail("storage-writes-succeeded", JSON.stringify(written)),
          after.usage >= before.usage
            ? pass("usage-not-decreasing-after-write", `${before.usage} -> ${after.usage}`)
            : fail("usage-not-decreasing-after-write", `${before.usage} -> ${after.usage}`),
          after.usageDetails?.indexedDB != null || after.usage > before.usage
            ? pass("usage-detail-tracks-indexeddb", `usageDetails=${JSON.stringify(after.usageDetails)}`)
            : inconclusive("usage-detail-tracks-indexeddb", "no per-origin detail and no measurable delta"),
          cdpUsage?.error
            ? unavailable("cdp-usage-available", cdpUsage.error)
            : pass("cdp-usage-available", `cdpUsage=${cdpUsage.usage} cdpQuota=${cdpUsage.quota}`),
        ];

        if (!cdpUsage?.error && Number.isFinite(cdpUsage.usage) && Number.isFinite(after.usage)) {
          const difference = Math.abs(cdpUsage.usage - after.usage);
          const tolerance = Math.max(64 * 1024, after.usage * 0.25);
          checks.push(
            difference <= tolerance
              ? pass("estimate-agrees-with-cdp", `delta=${difference}`)
              : inconclusive("estimate-agrees-with-cdp", `delta=${difference} exceeds tolerance=${tolerance}`),
          );
        }

        if (!cdpUsage?.error && Number.isFinite(cdpUsage.quota) && Number.isFinite(before.quota)) {
          const spread = Math.abs(cdpUsage.quota - before.quota) / Math.max(before.quota, cdpUsage.quota);
          checks.push(
            spread <= 0.05
              ? pass("quota-sources-agree", `estimate=${before.quota} cdp=${cdpUsage.quota}`)
              : inconclusive(
                  "quota-sources-agree",
                  `estimate.quota=${before.quota} but Storage.getUsageAndQuota quota=${cdpUsage.quota}; these are different heuristics, not an enforcement claim`,
                ),
          );
        }

        return result({
          observations: {
            before,
            after,
            written,
            cdpUsage,
            scopeNote: "small writes only (~7 KiB); no quota-limit stress and no claim about actual enforcement",
          },
          checks,
          limitations: [
            "Quota values are browser heuristics; only shape, monotonicity and CDP agreement are asserted.",
            "No quota-exceeded path is exercised, so the probe makes no claim that a specific quota (e.g. 10 GiB) is enforced.",
            "Headless profiles may report a fixed quota; no absolute byte claim is made.",
          ],
        });
      } finally {
        await cdp?.detach().catch(() => {});
        await page.close().catch(() => {});
      }
    },
  },
  {
    id: "storage.buckets-and-persistence",
    family: "storage",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.origin"],
      launchArgs: [],
      contextOptions: {},
      profileLifecycle: "none",
      relaunch: false,
      needs: "nothing beyond a fresh context; storageBuckets may be flagged off",
    },
    async run({ context, origin }) {
      const page = await context.newPage();
      try {
        await page.goto(`${origin}/storage`, { waitUntil: "domcontentloaded" });
        const state = await page.evaluate(async () => {
          const hasBuckets = "storageBuckets" in navigator;
          let bucketNames = null;
          let bucketError = null;
          if (hasBuckets && navigator.storageBuckets) {
            try {
              const keysResult = navigator.storageBuckets.keys();
              if (keysResult && typeof keysResult[Symbol.asyncIterator] === "function") {
                bucketNames = [];
                for await (const name of keysResult) bucketNames.push(name);
              } else if (keysResult && typeof keysResult[Symbol.iterator] === "function") {
                bucketNames = [...keysResult];
              } else if (keysResult && typeof keysResult.then === "function") {
                const resolved = await keysResult;
                bucketNames = Array.isArray(resolved) ? resolved.slice() : null;
              }
            } catch (error) {
              bucketError = String(error && error.message);
            }
          }
          const persistedBefore = await navigator.storage.persisted();
          let granted = null;
          try {
            granted = await navigator.storage.persist();
          } catch {
            granted = null;
          }
          const persistedAfter = await navigator.storage.persisted();
          const cache = await caches.open("lab-bucket-cache");
          await cache.put("/lab-roundtrip", new Response("roundtrip"));
          const hit = await cache.match("/lab-roundtrip");
          return {
            hasBuckets,
            bucketNames,
            bucketError,
            persistedBefore,
            granted,
            persistedAfter,
            cacheRoundtrip: hit ? await hit.text() : null,
          };
        });

        if (!state || typeof state !== "object") {
          return result({
            observations: {},
            checks: [stageNeeded("storage-api-available", "page script could not reach the Storage APIs")],
            limitations: ["Storage APIs were not evaluable in this target."],
          });
        }

        return result({
          observations: state,
          checks: [
            state.hasBuckets
              ? pass("storage-buckets-api-present", `buckets=${JSON.stringify(state.bucketNames)}${state.bucketError ? ` error=${state.bucketError}` : ""}`)
              : unavailable("storage-buckets-api-present", "navigator.storageBuckets is not exposed by this target"),
            typeof state.persistedBefore === "boolean" && typeof state.persistedAfter === "boolean"
              ? pass("persisted-boolean-coherent", `${state.persistedBefore} -> ${state.persistedAfter} granted=${state.granted}`)
              : fail("persisted-boolean-coherent", "persisted() did not return booleans"),
            typeof state.granted === "boolean"
              ? pass("persistence-outcome-well-defined", `granted=${state.granted} persisted=${state.persistedAfter}`)
              : inconclusive("persistence-outcome-well-defined", `persist() did not resolve to a boolean (granted=${state.granted})`),
            state.cacheRoundtrip === "roundtrip"
              ? pass("cache-api-roundtrip", "Cache API stored and returned the body")
              : fail("cache-api-roundtrip", `cacheRoundtrip=${state.cacheRoundtrip}`),
          ],
          limitations: [
            "storageBuckets is behind a feature flag in many builds; absence is reported as unavailable, not as a defect.",
            "persist() is auto-decided by heuristics; the probe asserts coherence between the call and persisted(), not a grant.",
          ],
        });
      } finally {
        await page.close().catch(() => {});
      }
    },
  },
  {
    id: "storage.quota-override",
    family: "storage",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.origin", "CDP Storage.overrideQuotaForOrigin"],
      launchArgs: [],
      contextOptions: {},
      profileLifecycle: "none",
      relaunch: false,
      needs: "a small bounded override (4 MiB) so the enforcement boundary is testable without touching the real quota",
    },
    async run({ context, origin }) {
      const quota = 4 * 1024 * 1024;
      const page = await context.newPage();
      let cdp = null;
      try {
        await page.goto(`${origin}/storage`, { waitUntil: "domcontentloaded" });
        try {
          cdp = await context.newCDPSession(page);
        } catch {
          cdp = null;
        }
        if (!cdp) {
          return result({
            observations: {},
            checks: [unavailable("cdp-quota-override", "no CDP session on this target")],
            limitations: ["Quota override requires CDP."],
          });
        }

        try {
          await cdp.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: quota });
        } catch (error) {
          return result({
            observations: { cdpError: String(error.message).split("\n")[0] },
            checks: [unavailable("cdp-quota-override", "Storage.overrideQuotaForOrigin is not usable on this target")],
            limitations: ["Quota override could not be applied."],
          });
        }

        let cdpQuota = null;
        try {
          cdpQuota = await cdp.send("Storage.getUsageAndQuota", { origin });
        } catch {
          cdpQuota = null;
        }

        const observed = await page.evaluate(async () => (await navigator.storage.estimate()).quota);
        const small = await page.evaluate(async (bytes) => {
          try {
            const cache = await caches.open("lab-override");
            await cache.put("/small", new Response(new Uint8Array(bytes)));
            return "ok";
          } catch (error) {
            return error?.name ?? "error";
          }
        }, 1024 * 1024);
        const over = await page.evaluate(async (bytes) => {
          try {
            const cache = await caches.open("lab-override");
            await cache.put("/over", new Response(new Uint8Array(bytes)));
            return "ok";
          } catch (error) {
            return error?.name ?? "error";
          }
        }, quota + 3 * 1024 * 1024);

        await cdp.send("Storage.overrideQuotaForOrigin", { origin }).catch(() => {});

        const ratio = observed / quota;
        return result({
          observations: {
            overrideBytes: quota,
            observedQuota: observed,
            overrideActive: cdpQuota?.overrideActive ?? null,
            cdpQuota: cdpQuota?.quota ?? null,
            smallWrite: small,
            overQuotaWrite: over,
            scopeNote: "override to 4 MiB; writes are 1 MiB and 7 MiB, no real-quota stress",
          },
          checks: [
            cdpQuota?.overrideActive === true
              ? pass("override-active-in-cdp", `Storage.getUsageAndQuota reports overrideActive=true`)
              : inconclusive("override-active-in-cdp", `overrideActive=${cdpQuota?.overrideActive ?? "unknown"}`),
            ratio > 0.5 && ratio < 1.5
              ? pass("override-reflected-in-estimate", `estimate.quota=${observed} for override=${quota}`)
              : inconclusive("override-reflected-in-estimate", `estimate.quota=${observed} did not track override=${quota}`),
            small === "ok"
              ? pass("sub-quota-write-succeeds", "1 MiB write accepted under the override")
              : fail("sub-quota-write-succeeds", `write returned ${small}`),
            over === "QuotaExceededError"
              ? pass("over-quota-write-rejected", "over-quota write raised QuotaExceededError")
              : fail("over-quota-write-rejected", `over-quota write returned ${over}`),
          ],
          limitations: [
            "The override is a test-only CDP control; this says nothing about the product's real quota value.",
            "Allocation granularity can make a small write exceed a tiny override; the chosen sizes leave headroom.",
          ],
        });
      } finally {
        await cdp?.detach().catch(() => {});
        await page.close().catch(() => {});
      }
    },
  },
];
