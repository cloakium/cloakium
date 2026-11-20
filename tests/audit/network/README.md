# Network, proxy and storage probes

Loopback-only fixtures plus 31 original probes for network semantics: HTTP proxy
forms and headers, SOCKS5 (TCP, RFC 1929 auth, UDP ASSOCIATE), DNS/DoH, WebRTC
STUN, TLS ClientHello metadata, HTTP/2, HTTP/3, cache and revalidation, cookies,
storage quota/buckets, navigation and popup bounds, and portable-profile export
security. Nothing here launches a browser by itself and nothing contacts a
non-loopback host.

## Contract

```js
export const probes = [{
  id, family, stage, timeoutMs, contextOptions,
  requirements: { endpoints, launchArgs, contextOptions, profileLifecycle, relaunch, needs },
  async run({ page, context, browser, origin, crossOrigin, lab, config, deadline })
    => { observations, checks: [{ name, passed, status }], limitations, status, denominator }
}];
```

`startLab(options)`, `scenarios`, `scenarioLaunch(id, lab)` and
`configForScenario(plan)` keep their signatures: the harness runs one browser
process per scenario, sequentially, and resolves `--flag={lab.endpoint}` templates
from the live lab object. Every listener binds `127.0.0.1` with port `0`.

`passed: true` is a pass, `false` is an observed inconsistency, and a
`stage-needed` / `unsupported-by-target` / `inconclusive` check is a capability
outcome that must never be scored as a pass.

## Fixtures

| Fixture | Purpose |
| --- | --- |
| `lab/origin.mjs` | HTTP origin with `/echo`, `/headers`, cache and cookie routes, plus `/input`, `/popup`, `/navigation-policy` and `/audio` documents for the browser-contract probes; a second loopback site for cross-site probes |
| `lab/proxy-http.mjs` | RFC 9110 absolute-form + CONNECT proxy; loopback allowlist; optional Basic auth |
| `lab/proxy-socks5.mjs` | RFC 1928/1929 server with a UDP relay and relay-port attribution |
| `lab/stun.mjs` | RFC 5389 binding responder (proof that UDP actually left the browser) |
| `lab/dns.mjs`, `lab/dns-wire.mjs` | RFC 1035 recorder and wire helpers |
| `lab/doh.mjs` | RFC 8484 GET/POST DoH listener with an SPKI pin |
| `lab/tls.mjs`, `lab/http2.mjs` | Ephemeral loopback CA plus HTTP/2 ALPN fixture |
| `lab/tap.mjs` | ClientHello tap: JA3-shaped metadata only, no handshake |
| `lab/transparent-proxy.mjs` | Records origin-form versus absolute-form requests |
| `lab/h3.mjs` | Spawns the Rust HTTP/3 fixture (below) |

Dummy proxy credentials are generated per lab run. They are never logged, never
placed in a report, and never reused across runs.

## Environment

- `CLOAKIUM_AUDIT_PRIVATE_ROOT` — private scratch root for certificates and
  profile fixtures (default `/tmp/opencode`).
- `CLOAKIUM_H3_BIN` — explicit path to the HTTP/3 fixture binary; otherwise
  `tools/audit-h3-lab/target/{release,debug}/cloakium-lab-h3` is used.
- `OPENSSL_BIN` — OpenSSL CLI for ephemeral certificates (PATH fallback).

## Selfchecks (no browser, no credentials)

```bash
node tests/audit/network/selfcheck/manifest.mjs     # registry cannot drift
node tests/audit/network/selfcheck/syntax.mjs       # descriptor + degradation paths
node tests/audit/network/selfcheck/run.mjs          # every fixture, protocol level
node tests/audit/network/selfcheck/profile-fixture.mjs
node tests/audit/network/selfcheck/h3-fixture.mjs   # skips when the binary is absent
node tests/audit/network/selfcheck/sources.mjs      # source guard for all audit dirs
```
