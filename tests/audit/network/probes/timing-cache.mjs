import {
  fail,
  fetchJson,
  inconclusive,
  pass,
  remaining,
  result,
  stageNeeded,
  withProbeContext,
  withProxyContext,
} from "./kit.mjs";

export const probes = [
  {
    id: "net.cache.fresh-and-no-store",
    family: "network-cache",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.originStats"],
      launchArgs: [],
      contextOptions: {},
      profileLifecycle: "none",
      relaunch: false,
      needs: "no Playwright route() interception on the lab origin, or the HTTP cache is bypassed",
    },
    async run({ context, browser, lab, deadline }) {
      const outcome = await withProbeContext(
        context,
        {},
        async (scoped) => {
          const page = await scoped.newPage();
          await page.goto(`${lab.origin}/`, { waitUntil: "domcontentloaded", timeout: remaining(deadline, 10_000) });
          const fresh = await page.evaluate(async () => {
            const read = (path) => fetch(path, { cache: "default" }).then((response) => response.json());
            const first = await read("/hit/cache-fresh?mode=fresh&maxAge=120");
            const second = await read("/hit/cache-fresh?mode=fresh&maxAge=120");
            const entries = performance
              .getEntriesByType("resource")
              .filter((entry) => entry.name.includes("cache-fresh"))
              .map((entry) => ({ transferSize: entry.transferSize, duration: entry.duration }));
            return { first, second, entries };
          });
          const noStore = await page.evaluate(async () => {
            const read = (path) => fetch(path, { cache: "default" }).then((response) => response.json());
            const first = await read("/hit/cache-nostore?mode=nostore");
            const second = await read("/hit/cache-nostore?mode=nostore");
            return { first, second };
          });
          await page.close().catch(() => {});
          return { fresh, noStore };
        },
        { browser },
      );

      if (outcome.skipped) {
        return result({
          observations: { skipped: outcome.skipped },
          checks: [stageNeeded("cache-context-created", outcome.skipped)],
          limitations: ["Isolated context could not be created."],
        });
      }

      const { fresh, noStore } = outcome.value;
      const cached = fresh.second.count === fresh.first.count;
      const revalidated = noStore.second.count === noStore.first.count + 1;

      return result({
        observations: {
          freshCounts: [fresh.first.count, fresh.second.count],
          noStoreCounts: [noStore.first.count, noStore.second.count],
          resourceEntries: fresh.entries,
        },
        checks: [
          cached
            ? pass("fresh-resource-served-from-cache", `hit counter stayed at ${fresh.first.count} across two fetches`)
            : fail("fresh-resource-served-from-cache", `counts ${fresh.first.count} -> ${fresh.second.count}; the resource was refetched`),
          revalidated
            ? pass("no-store-always-refetched", `${noStore.first.count} -> ${noStore.second.count}`)
            : fail("no-store-always-refetched", `counts ${noStore.first.count} -> ${noStore.second.count}`),
          fresh.entries.length >= 2 && fresh.entries.some((entry) => entry.transferSize === 0)
            ? pass("second-fetch-transfer-size-zero", "a resource entry reports transferSize 0")
            : inconclusive(
                "second-fetch-transfer-size-zero",
                `transferSizes=${fresh.entries.map((entry) => entry.transferSize).join(",")}; counter evidence is authoritative`,
              ),
        ],
        limitations: [
          "Playwright route interception disables the HTTP cache; this probe assumes no route() handler for the lab origin.",
          "A hit-counter comparison is used because transferSize can be 0 for unrelated reasons.",
        ],
      });
    },
  },
  {
    id: "net.cache.revalidation",
    family: "network-cache",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.originStats"],
      launchArgs: [],
      contextOptions: {},
      profileLifecycle: "none",
      relaunch: false,
      needs: "no route() interception on the lab origin",
    },
    async run({ context, browser, lab, deadline }) {
      const outcome = await withProbeContext(
        context,
        {},
        async (scoped) => {
          const page = await scoped.newPage();
          await page.goto(`${lab.origin}/hit/etag-flow?mode=etag`, {
            waitUntil: "domcontentloaded",
            timeout: remaining(deadline, 10_000),
          });
          const values = await page.evaluate(async () => {
            const read = (path) => fetch(path, { cache: "default" }).then((response) => response.json());
            const first = await read("/hit/etag-flow?mode=etag");
            const second = await read("/hit/etag-flow?mode=etag");
            return { first, second };
          });
          await page.close().catch(() => {});
          return values;
        },
        { browser },
      );

      if (outcome.skipped) {
        return result({
          observations: { skipped: outcome.skipped },
          checks: [stageNeeded("revalidation-context-created", outcome.skipped)],
          limitations: ["Isolated context could not be created."],
        });
      }

      const requests = lab.originStats().requests.filter((entry) => entry.path === "/hit/etag-flow");
      const revalidated = requests.filter((entry) => Boolean(entry.headers["if-none-match"])).length;
      const values = outcome.value;

      return result({
        observations: {
          counts: [values.first.count, values.second.count],
          originRequests: requests.map((entry) => ({ count: entry.count, ifNoneMatch: entry.headers["if-none-match"] ?? null })),
        },
        checks: [
          revalidated > 0
            ? pass("conditional-request-sent", `${revalidated} request(s) carried if-none-match`)
            : fail("conditional-request-sent", "the browser never revalidated the stale resource"),
          values.second.count >= values.first.count
            ? pass("revalidated-resource-reusable", `counts ${values.first.count} -> ${values.second.count}`)
            : fail("revalidated-resource-reusable", "hit counter moved backwards"),
        ],
        limitations: [
          "The origin answers 304 on a matching ETag; the browser surfaces 200 from cache, so the origin request log is the evidence.",
        ],
      });
    },
  },
  {
    id: "net.proxy.header-hygiene-e2e",
    family: "network-proxy-http",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.proxy.http"],
      launchArgs: [],
      contextOptions: { proxy: { fromEndpoint: "lab.proxy.http", bypass: "<-loopback>" } },
      profileLifecycle: "none",
      relaunch: false,
      needs: "an HTTP proxy route so hop-by-hop and credential headers can be inspected end to end",
    },
    async run({ context, browser, origin, lab, config }) {
      const outcome = await withProxyContext(
        { context, browser, config, lab, endpoint: "lab.proxy.http" },
        async (scoped) => {
          const page = await scoped.newPage();
          await page.setExtraHTTPHeaders({ "X-Lab-Probe": "header-hygiene" });
          const body = await fetchJson(page, `${origin}/echo?probe=hygiene`);
          await page.close().catch(() => {});
          return body;
        },
      );

      if (outcome.skipped) {
        return result({
          observations: { skipped: outcome.skipped },
          checks: [stageNeeded("hygiene-context-created", outcome.skipped)],
          limitations: ["No proxy route was available."],
        });
      }

      const body = outcome.value ?? {};
      const headers = body.headers ?? {};
      const names = body.headerNames ?? [];
      if (headers.via !== "1.1 cloakium-lab") {
        return result({
          observations: { originBody: body },
          checks: [
            stageNeeded(
              "proxy-in-path",
              "the request did not traverse the fixture proxy; verify proxy mode and `<-loopback>` in the bypass list",
            ),
          ],
          limitations: ["Header hygiene through a proxy is unproven because the request did not traverse the proxy."],
        });
      }

      return result({
        observations: { headers: names, host: headers.host ?? null, via: headers.via ?? null, proxyMode: outcome.mode },
        checks: [
          headers["x-lab-probe"] === "header-hygiene"
            ? pass("application-header-preserved", "X-Lab-Probe survived the proxy")
            : fail("application-header-preserved", "X-Lab-Probe was dropped or rewritten"),
          names.includes("proxy-authorization")
            ? fail("proxy-authorization-not-forwarded", "origin received proxy credentials")
            : pass("proxy-authorization-not-forwarded", "no proxy-authorization header at origin"),
          headers["x-forwarded-for"]
            ? fail("no-synthetic-forwarding-headers", `proxy injected x-forwarded-for=${headers["x-forwarded-for"]}`)
            : pass("no-synthetic-forwarding-headers", "no x-forwarded-for injection"),
          String(headers.host ?? "").startsWith("127.0.0.1:") && String(headers.host).includes(":")
            ? pass("host-header-preserved-with-port", `host=${headers.host}`)
            : fail("host-header-preserved-with-port", `host=${headers.host ?? "none"}`),
        ],
        limitations: ["Hop-by-hop headers are stripped by design; only end-to-end semantics are asserted."],
      });
    },
  },
  {
    id: "net.timing.navigation-metadata",
    family: "network-timing",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.origin"],
      launchArgs: [],
      contextOptions: {},
      profileLifecycle: "none",
      relaunch: false,
      needs: "nothing beyond the fixture origin",
    },
    async run({ context, browser, lab, deadline }) {
      const outcome = await withProbeContext(
        context,
        {},
        async (scoped) => {
          const page = await scoped.newPage();
          await page.goto(`${lab.origin}/slow?ms=40`, { waitUntil: "domcontentloaded", timeout: remaining(deadline, 10_000) });
          const timing = await page.evaluate(() => {
            const entries = performance.getEntriesByType("navigation");
            if (!entries.length) return null;
            const nav = entries[0];
            return {
              timeOrigin: performance.timeOrigin,
              requestStart: nav.requestStart,
              responseStart: nav.responseStart,
              responseEnd: nav.responseEnd,
              nextHopProtocol: nav.nextHopProtocol,
              transferSize: nav.transferSize,
            };
          });
          await page.close().catch(() => {});
          return timing;
        },
        { browser },
      );

      if (outcome.skipped) {
        return result({
          observations: { skipped: outcome.skipped },
          checks: [stageNeeded("timing-context-created", outcome.skipped)],
          limitations: ["Isolated context could not be created."],
        });
      }

      const timing = outcome.value;
      if (!timing) {
        return result({
          observations: {},
          checks: [fail("navigation-timing-available", "no navigation timing entry was produced")],
          limitations: ["Navigation timing may be disabled by policy in this target."],
        });
      }

      return result({
        observations: { timing },
        checks: [
          timing.requestStart > 0 && timing.responseStart >= timing.requestStart
            ? pass("response-start-after-request-start", `${timing.requestStart} -> ${timing.responseStart}`)
            : fail("response-start-after-request-start", `requestStart=${timing.requestStart} responseStart=${timing.responseStart}`),
          timing.responseEnd >= timing.responseStart
            ? pass("response-end-after-response-start", `${timing.responseStart} -> ${timing.responseEnd}`)
            : fail("response-end-after-response-start", `responseStart=${timing.responseStart} responseEnd=${timing.responseEnd}`),
          typeof timing.nextHopProtocol === "string" && timing.nextHopProtocol.length > 0
            ? pass("next-hop-protocol-present", `nextHopProtocol=${timing.nextHopProtocol}`)
            : fail("next-hop-protocol-present", "nextHopProtocol missing"),
        ],
        limitations: ["Single localhost baseline for comparison; no absolute latency claim."],
      });
    },
  },
];
