import http from "node:http";
import {
  deltaCounters,
  fail,
  fetchJson,
  inconclusive,
  navigateExpectingFailure,
  pass,
  remaining,
  result,
  stageNeeded,
  unsupported,
  withProxyContext,
} from "./kit.mjs";

export const probes = [
  {
    id: "net.proxy.http.absolute-form",
    family: "network-proxy-http",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.proxy.http"],
      launchArgs: [],
      contextOptions: { proxy: { fromEndpoint: "lab.proxy.http", bypass: "<-loopback>" } },
      profileLifecycle: "none",
      relaunch: false,
      needs: "either a Playwright per-context proxy, or a process launched with --proxy-server=<lab.proxy.http.url> --proxy-bypass-list=<-loopback>",
    },
    async run({ context, browser, origin, lab, config, deadline }) {
      const before = lab.proxy.http.stats();
      const outcome = await withProxyContext(
        { context, browser, config, lab, endpoint: "lab.proxy.http" },
        async (scoped) => {
          const page = await scoped.newPage();
          const body = await fetchJson(page, `${origin}/echo?probe=absolute-form`);
          await page.close().catch(() => {});
          return body;
        },
      );
      const after = lab.proxy.http.stats();
      const delta = deltaCounters(before, after);
      void remaining(deadline, 1_000);

      if (outcome.skipped) {
        return result({
          observations: { skipped: outcome.skipped, proxyMode: outcome.mode, proxyDelta: delta },
          checks: [stageNeeded("proxy-route-available", outcome.skipped)],
          limitations: ["No proxy route was available, so proxy semantics were not exercised."],
        });
      }

      const body = outcome.value ?? {};
      const names = Array.isArray(body.headerNames) ? body.headerNames : [];
      const headers = body.headers ?? {};

      if (delta.absoluteRequests === 0) {
        return result({
          observations: { proxyMode: outcome.mode, proxyDelta: delta, originBody: body },
          checks: [
            stageNeeded(
              "proxy-received-absolute-form",
              "the request never reached the lab proxy; verify proxy mode and that loopback is not bypassed (`<-loopback>`)",
            ),
          ],
          limitations: ["The browser did not route through the fixture proxy."],
        });
      }

      return result({
        observations: {
          proxyMode: outcome.mode,
          proxyDelta: delta,
          hostHeader: headers.host ?? null,
          viaHeader: headers.via ?? null,
          originHeaderNames: names,
          lastTargets: after.targets.slice(-5),
        },
        checks: [
          pass("proxy-received-absolute-form", `absoluteRequests=${delta.absoluteRequests}`),
          headers.host === new URL(origin).host
            ? pass("origin-received-original-host", `host=${headers.host}`)
            : fail("origin-received-original-host", `expected ${new URL(origin).host}, got ${headers.host ?? "none"}`),
          headers.via === "1.1 cloakium-lab"
            ? pass("proxy-added-via", "via=1.1 cloakium-lab")
            : fail("proxy-added-via", `via=${headers.via ?? "absent"}`),
          names.includes("proxy-authorization")
            ? fail("proxy-credentials-not-forwarded", "origin saw a proxy-authorization header")
            : pass("proxy-credentials-not-forwarded", "no proxy-authorization header at origin"),
        ],
        limitations: ["Absolute-form applies to http:// targets; https:// targets use CONNECT (separate probe)."],
      });
    },
  },
  {
    id: "net.proxy.http.connect-auth",
    family: "network-proxy-http",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.proxy.httpAuth", "lab.tap"],
      launchArgs: [],
      launchProxy: { fromEndpoint: "lab.proxy.httpAuth", credentials: true, bypass: "<-loopback>" },
      contextOptions: { proxy: { fromEndpoint: "lab.proxy.httpAuth", credentials: true, bypass: "<-loopback>" } },
      profileLifecycle: "none",
      relaunch: true,
      needs: "Basic proxy auth: Playwright launch `proxy: {server, username, password}` or per-context equivalent; process-level auth is the realistic launcher path",
    },
    async run({ context, browser, lab, config, deadline }) {
      const before = lab.proxy.httpAuth.stats();
      const { username, password } = lab.proxy.httpAuth.credentials;
      const plan = config?.proxy ?? null;
      const options = {
        proxy: { server: lab.proxy.httpAuth.url, username, password, bypass: "<-loopback>" },
        ignoreHTTPSErrors: true,
      };

      const outcome = await withProxyContext(
        { context, browser, config, lab, endpoint: "lab.proxy.httpAuth" },
        async (scoped) => {
          const page = await scoped.newPage();
          const navigation = await navigateExpectingFailure(page, `https://localhost:${lab.tap.port}/`, remaining(deadline, 6_000));
          await page.close().catch(() => {});
          return navigation;
        },
        options,
      );
      const after = lab.proxy.httpAuth.stats();
      const delta = deltaCounters(before, after);

      if (outcome.skipped) {
        return result({
          observations: { skipped: outcome.skipped, proxyMode: plan?.mode ?? "context", proxyDelta: delta },
          checks: [stageNeeded("connect-route-available", outcome.skipped)],
          limitations: ["No authenticated proxy route was available."],
        });
      }
      if (delta.connects === 0) {
        return result({
          observations: { proxyMode: outcome.mode, proxyDelta: delta, navigation: outcome.value },
          checks: [
            stageNeeded(
              "connect-tunnel-established",
              "no CONNECT reached the authenticated proxy; a process-level --proxy-server with credentials is the usual remedy",
            ),
          ],
          limitations: ["CONNECT and proxy auth were not exercised."],
        });
      }

      return result({
        observations: {
          proxyMode: outcome.mode,
          proxyDelta: delta,
          navigation: outcome.value,
          targets: after.targets.slice(-5),
          credentialsNote: "dummy fixture credentials generated per lab run; never a real key",
        },
        checks: [
          pass("connect-tunnel-established", `connects=${delta.connects}`),
          delta.authOk > 0
            ? pass("proxy-basic-auth-accepted", `authOk=${delta.authOk}`)
            : fail("proxy-basic-auth-accepted", `authOk=0 rejected=${delta.rejectedAuth}; the browser never satisfied the 407 challenge`),
          delta.tunnelTlsHandshake > 0
            ? pass("tunnel-carried-tls-clienthello", `tlsHandshakes=${delta.tunnelTlsHandshake}`)
            : fail("tunnel-carried-tls-clienthello", `firstByte observations=${delta.tunnelConnections}`),
        ],
        limitations: [
          "Chromium may challenge once before authenticating; rejectedAuth counts that challenge and is reported, not asserted to be zero.",
          "The tunnel target is the ClientHello tap, so the later TLS error is expected.",
        ],
      });
    },
  },
  {
    id: "net.proxy.http.no-external-egress",
    family: "network-proxy-http",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.proxy.http"],
      launchArgs: [],
      contextOptions: { proxy: { fromEndpoint: "lab.proxy.http", bypass: "<-loopback>" } },
      profileLifecycle: "none",
      relaunch: false,
      needs: "proxy route so external attempts would be visible to the fixture proxy",
    },
    async run({ context, browser, lab, config }) {
      const plan = await withProxyContext(
        { context, browser, config, lab, endpoint: "lab.proxy.http" },
        async (scoped) => {
          const page = await scoped.newPage();
          await page.goto(`${lab.origin}/`, { waitUntil: "domcontentloaded" }).catch(() => {});
          await page.close().catch(() => {});
          return true;
        },
      );
      const stats = lab.proxy.http.stats();
      const status = await directExternalAttempt(lab.proxy.http.port).catch((error) => `error:${error.message}`);

      const checks = [
        stats.blockedExternal === 0
          ? pass("proxy-saw-no-external-target", "blockedExternal=0")
          : fail(
              "proxy-saw-no-external-target",
              `blockedExternal=${stats.blockedExternal}; a non-loopback target was attempted (hostnames deliberately not recorded)`,
            ),
        status === 403
          ? pass("proxy-refuses-non-loopback", "direct request to example.invalid returned 403")
          : fail("proxy-refuses-non-loopback", `expected 403, got ${status}`),
      ];
      if (plan.skipped) checks.unshift(stageNeeded("proxy-route-available", plan.skipped));

      return result({
        observations: {
          blockedExternal: stats.blockedExternal,
          loopbackTargets: stats.targets.length,
          allowlist: "loopback + .lab.test only; non-loopback is refused before any connect",
          egressNote:
            "the fixture proxy cannot relay outside loopback, so it can never intercept or influence other traffic",
        },
        checks,
        limitations: [
          "This is an allowlist property of the fixture proxy, not a measurement of the target's own egress policy.",
          "A non-zero count means the target browser tried external egress; the proxy refused it and recorded no hostname or payload.",
        ],
      });
    },
  },
  {
    id: "net.proxy.http.connect-auth-inline",
    family: "network-proxy-http",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.proxy.httpAuth", "lab.tap"],
      launchArgs: ["--proxy-server=http://<dummy-user>:<dummy-pass>@127.0.0.1:<lab.proxy.httpAuth.port>", "--proxy-bypass-list=<-loopback>"],
      contextOptions: { ignoreHTTPSErrors: true },
      profileLifecycle: "none",
      relaunch: true,
      needs: "INLINE dummy credentials in --proxy-server (scenario `http-proxy-auth-inline`); no Playwright credential injection",
    },
    async run({ context, browser, lab, config, deadline }) {
      const before = lab.proxy.httpAuth.stats();
      const outcome = await withProxyContext(
        { context, browser, config, lab, endpoint: "lab.proxy.httpAuth" },
        async (scoped) => {
          const page = await scoped.newPage();
          const navigation = await navigateExpectingFailure(page, `https://localhost:${lab.tap.port}/`, remaining(deadline, 6_000));
          await page.close().catch(() => {});
          return navigation;
        },
      );
      const after = lab.proxy.httpAuth.stats();
      const delta = deltaCounters(before, after);

      if (outcome.skipped) {
        return result({
          observations: { skipped: outcome.skipped, proxyDelta: delta },
          checks: [stageNeeded("inline-auth-route-available", outcome.skipped)],
          limitations: ["The inline process-level route was not used."],
        });
      }
      if (delta.connects === 0) {
        const inlineRejected = /ERR_NO_SUPPORTED_PROXIES/.test(outcome.value?.error ?? "");
        return result({
          observations: { proxyDelta: delta, navigation: outcome.value, inlineFlagRejected: inlineRejected },
          checks: inlineRejected
            ? [
                unsupported(
                  "inline-proxy-in-path",
                  "the proxy URL carrying inline credentials was rejected before any CONNECT (ERR_NO_SUPPORTED_PROXIES); this build does not parse credentials in --proxy-server",
                ),
                inconclusive("inline-basic-credentials-accepted", "not attempted: the proxy URL was rejected"),
                inconclusive("tunnel-carried-tls-clienthello", "not attempted: no tunnel"),
              ]
            : [
                stageNeeded(
                  "inline-proxy-in-path",
                  "no CONNECT reached the authenticated proxy; verify the inline --proxy-server value and <-loopback>",
                ),
              ],
          limitations: [
            "Chromium has no documented --proxy-server credential syntax; a launcher-level auth path is required for this capability.",
          ],
        });
      }

      return result({
        observations: {
          proxyDelta: delta,
          navigation: outcome.value,
          targets: after.targets.slice(-5),
          credentialsNote: "dummy fixture credentials generated per lab run; redacted by the runner",
        },
        checks: [
          pass("connect-tunnel-established", `connects=${delta.connects}`),
          delta.authOk > 0
            ? pass("inline-basic-credentials-accepted", `authOk=${delta.authOk}`)
            : unsupported(
                "inline-basic-credentials-accepted",
                `authOk=0 rejected=${delta.rejectedAuth}; inline credentials in --proxy-server were not applied by this build`,
              ),
          delta.tunnelTlsHandshake > 0
            ? pass("tunnel-carried-tls-clienthello", `tlsHandshakes=${delta.tunnelTlsHandshake}`)
            : fail("tunnel-carried-tls-clienthello", `firstByte observations=${delta.tunnelConnections}`),
        ],
        limitations: [
          "Chromium may challenge once before authenticating; rejectedAuth is reported, not asserted to be zero.",
          "A failure here is launcher-level evidence about inline credential handling, not proof the proxy protocol is unimplementable.",
        ],
      });
    },
  },
];

/** Direct local client: proves the proxy's allowlist without involving the browser. */
function directExternalAttempt(proxyPort) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port: proxyPort, path: "http://example.invalid/", headers: { host: "example.invalid" } },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
    request.end();
  });
}
