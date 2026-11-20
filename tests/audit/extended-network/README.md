# Extended network scenarios

Seven launch plans over the network family's own probes. This module adds no
fixtures and no new probe logic: it starts the network lab with DoH and the
intercepting-proxy control enabled, then resolves scenario ids to concrete
launch arguments.

| Scenario | Purpose |
| --- | --- |
| `doh-standard` | RFC 8484 DoH through the documented DoH switches |
| `doh-launcher-route` | Same probe with caller-supplied launcher arguments |
| `transparent-baseline` | Intercepting-proxy fixture with default arguments |
| `transparent-local` | Caller-supplied local-resolution arguments |
| `transparent-doh` | Transparent route plus DoH resolution, SPKI-pinned |
| `rtc-positive` | Direct STUN positive control with an explicit ICE address |
| `socks5-webrtc-forced` | Documented forced-policy shape for UDP over SOCKS5 |

```js
export function scenarioLaunch(id, lab, options)
// options.launcherArgs = { [scenarioId]: ["--flag=value", ...] }
```

Extra launcher arguments are the caller's decision: no build-specific switch name
is baked into this module. When the DoH fixture is not running, dependent
scenarios report a `skipReason` instead of failing.

## Check

```bash
node tests/audit/extended-network/selfcheck.mjs
```
