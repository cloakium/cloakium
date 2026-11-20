# Fingerprint surface probes

22 original probes over the documented Web API surface a fingerprinting script
can read: navigator and client hints, media queries, screen geometry and
multi-display, canvas 2D (readback, text, worker, offscreen), SVG, WebGL, WebGPU,
audio (offline and worklet), numeric/math invariants, font metrics, system
colours, speech voices, media devices, DRM, WebAuthn, capability presence and
origin scope.

Every probe reads public APIs and asserts coherence/determinism properties: a
persona that changes the user agent must change `navigator.platform` and the
client hints with it, repeated reads must agree, and arithmetic must stay within
documented bounds. Nothing asserts a particular host, seed or persona value, and
`passed: null` ("not evaluable here") is never treated as a pass.

Priming navigates a loopback HTTP document; `page.setContent` is exercised
separately as a client-compatibility contract in `browser-contracts`.

## Contract

```js
export const probes = [{
  id, family, timeoutMs, contextOptions,
  requirements: { endpoints, launchArgs, contextOptions, profileLifecycle, relaunch, needs },
  contract: { origin, crossOrigin, routes, permissions, activation, viewport, notes, checks },
  async run({ page, context, browser, origin, crossOrigin, lab, config, deadline })
    => { observations, checks: [{ name, passed }], limitations, coverage, failed }
}];
```

`run` is hard-bounded by `timeoutMs` and honours an earlier caller `deadline`
(rejects with `ProbeDeadlineError`, which a harness must record as not-run).

## Files

| Path | Contents |
| --- | --- |
| `index.mjs` | Aggregated descriptor array, deadline guard, `families` |
| `manifest.mjs` | Machine-readable suite manifest derived from the descriptors |
| `mapping.mjs` | Which observations may move across modes, seeds and config rows |
| `support/` | Shared recorder, page preparation, canvas/GPU helpers, source scan |
| `navigator/`, `screen/`, `render/`, `numeric/`, `text/`, `api/`, `origin/` | Probe modules |

## Checks

```bash
node --test tests/audit/fingerprint/tests/*.test.mjs
```

The tests prove descriptor shape, declared-check drift, harness readiness, the
clean-room rules (no init scripts, no property overrides, no randomness, no
external URLs) and that every module imports standalone.
