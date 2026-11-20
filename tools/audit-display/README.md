# cloakium-audit-display

Owned, dynamically allocated X display for audits. Std-only Rust, one binary,
no crates.

```text
cloakium-audit-display start    --state-dir DIR [--width 1920] [--height 1080]
                                [--depth 24] [--dpi 96] [--window-manager openbox|none]
cloakium-audit-display status   --state-dir DIR
cloakium-audit-display stop     --state-dir DIR
cloakium-audit-display selftest --state-dir DIR
```

## Contract

- `start` prints **one** JSON manifest on stdout and nothing else; diagnostics
  go to stderr and to `logs/` inside the state directory.
- The display number comes from `Xvfb -displayfd`; nothing is assumed about
  `:0`/`:1`.
- The MIT-MAGIC-COOKIE file is written `0600` before the server starts and an
  unauthenticated client is verified to be refused (`authEnforced`).
- Readiness is `-displayfd` → `xdpyinfo` → window-manager confirmation, all
  bounded polls; there are no startup sleeps.
- The state directory must be absolute, owned by the caller, mode `0700`, and
  not a symlink. A live job found there is never overwritten.
- `stop` signals a process only when its pid, `/proc` start ticks and
  executable all match the manifest (pid-reuse guard), then removes the cookie
  and manifest and reports the socket state.

Manifest (`display.json`, mode `0600`):

```json
{
  "schema": "cloakium.audit.display/1",
  "display": ":2",
  "xauthorityPath": "<state-dir>/Xauthority",
  "xvfbPid": 1234,
  "xvfbStartTicks": 5678,
  "wmPid": 1235,
  "wmStartTicks": 5679,
  "screen": { "width": 1920, "height": 1080, "depth": 24, "dpi": 96 },
  "windowManager": "openbox",
  "authEnforced": true,
  "owned": true
}
```

No cookie value is ever written to the manifest.

## Environment

`CLOAKIUM_AUDIT_XVFB`, `CLOAKIUM_AUDIT_OPENBOX`, `CLOAKIUM_AUDIT_XPROP`,
`CLOAKIUM_AUDIT_XDPIINFO` select the tools. The Nix wrapper bakes them in; with
a plain `cargo build` they are looked up on `PATH`. Every child process is
started with `env_clear()` plus a minimal fixed environment, so nothing is
inherited from the caller.

## Tests

`cargo test` covers the JSON reader/writer, manifest rejection rules, path and
symlink refusals, tick parsing and the pid-reuse guard — no X server required.
`selftest --state-dir DIR` allocates a real display, asserts readiness and
refusals, exercises the pid-reuse guard and cleans up.
