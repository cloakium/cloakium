# Network attribution and failure classification

## Why five paths, not one

A browser can honour a proxy for ordinary HTTP while still leaking through
another path. Attribution requires an observation per path and a positive
control per path; a missing observation is not evidence of blocking.

| Path | Fixture | Positive control |
| --- | --- | --- |
| Direct TCP HTTP(S) | local origin server | stock launch reaches the origin |
| Proxied TCP HTTP(S) | local HTTP CONNECT and SOCKS5 proxy | request is observed at the proxy and absent at the origin |
| DNS | local UDP/TCP DNS, DoH endpoint when configured | query observed at the fixture resolver |
| UDP non-proxied (WebRTC/STUN) | localhost STUN binding responder | stock launch produces a binding request and a server-reflexive candidate |
| UDP 443 (QUIC/HTTP3) | local H3 endpoint or a documented disabled state | stock launch completes a QUIC exchange, or the path's absence is stated |

`tests/browser/webrtc.test.mjs` is the existing positive-control model: the
baseline browser must send a STUN request, and the hardened launch must send
none. Keep both halves. Never print the local port or any address in a public
artifact.

## Attribution rules

- Bind every fixture to loopback. Nothing in this workflow may leave the host.
- Attribute the observed path to a layer: engine switch, launcher default, driver
  option, or client option. `--webrtc-ip-handling-policy=disable_non_proxied_udp`
  is a Chrome switch; a Playwright option that maps to it is still the engine
  enforcing it.
- A transparent proxy that is not actually intercepting will look like a pass.
  Prove interception at the fixture, not by reading a configuration value.
- HTTP/2, DoH and HTTP/3 are separate observations. HTTP/2 success says nothing
  about QUIC, and a DoH setting says nothing about system DNS.
- Proxy credentials never go on the Chromium command line. Record that the
  authenticated proxy path was exercised without recording the secret.

## Failure classification

Classify each check before writing any summary, using the statuses in
`tests/audit/lib/outcomes.mjs`:

- `pass`: the assertion ran and held.
- `fail`: the assertion ran and failed; this is a measured difference.
- `unavailable`: the host could not run the probe (no namespace sandbox, no
  `xvfb-run`, exhausted memory). Never convert to pass.
- `unsupported-by-target`: the target lacks the capability by design.
- `stage-needed`: a fixture or stage prerequisite is missing.
- `inconclusive`: the probe did not run or a capability was null. A null WebGPU
  adapter is not WebGPU rendering, and an absent client hint is not coherence.

An intentional privacy boundary is a `pass` for the policy assertion, with the
blocked path recorded as `unavailable` in observations. WebRTC non-proxied UDP,
forced proxy paths and proxy-key protection are the expected cases; preserve
them.

These are native probe outcomes. The report adapter maps them to canonical
`Check.status`: `unavailable` and `inconclusive` become `unknown`,
`unsupported-by-target` becomes `unsupported`, and `stage-needed` becomes
`skipped` or `unknown`. The original tri-state rows and limitations are retained
under `observations.$audit.originalChecks` and `originalLimitations`.

A runtime crash, a launch failure or a missing dependency is not a feature
difference. Record it as `unavailable` with the exact command and the first error
line. A difference that appears only in headed mode, and disappears with
`--native-defaults`, is an adapter default effect; name it that way instead of
calling it an engine gap.

## Reporting intentional differences

The parity suite keeps two named X11 physical-window diagnostics separate from
the compared contract: duplicate pointer-boundary events after window-history
changes, and the pointer-lock cursor warp at startup. Window-manager theme
insets also legitimately differ. Report these as declared diagnostics with the
asserted transitions still compared, never as a silent exclusion and never as a
reason to hardcode desktop pixels.

## Evidence quantity

- Both modes, in both profile variants, at least twice, in opposite order.
- One fresh context per probe.
- Functional assertions in both modes; a comparison of two broken modes is not a
  comparison.
- If a suite is skipped, say which suite, why, and what remains unproven.
