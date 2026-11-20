# Evidence, layers and reuse

## Layer record

Record six independent facts. Never collapse them into one version string.

| Layer | Source | Evidence |
| --- | --- | --- |
| Engine | the engine path named by the launcher, or the binary the user supplied | resolved path, SHA-256, `--version` output |
| Launcher | the wrapper the user supplied | resolved path, SHA-256, the `CLOAKIUM_REAL_CHROMIUM` line that names the engine, headless-only default flags it may prepend |
| Driver / SDK | `node_modules/playwright-core` or `CLOAKIUM_PLAYWRIGHT_MODULE` | package version, `cloakium` marker, `CLOAKIUM-PATCHES.json` digest |
| Client | the library build under test | package name and version, build artifact digest |
| Probe set | `tests/parity/probes/*.mjs`, `tests/audit/*/index.mjs` | per-file SHA-256 plus the exported contract version string |
| Font set | the runtime's font configuration | set digest when a font tool exists, otherwise `inconclusive` |

A launcher that prepends `--screen-info` and `--blink-settings` is not the
engine. Its defaults only apply when the caller passed both `--headless` and
`--fingerprint`; explicit caller settings win. Record which layer supplied a
flag, or a headed/headless difference will be misattributed.

## Identity keys

- A launcher may be an ELF or a trusted shebang script. `inventory` records
  `FileIdentity.kind` with optional ELF detail; a script launcher is not a failed
  ELF check.
- Use `realpath` output, not the path the user typed. Two different launchers can
  resolve to the same engine, and one launcher can be replaced under a stable
  symlink.
- Hash the file, not the directory. A directory digest changes when an unrelated
  file appears.
- For an archive or installer, record name, size, magic from `file`, SHA-256 and
  SRI. Format identification is not integrity.
- Version output is evidence, not identity. Two builds can print one version.
- A difference measured across two engine versions is a version effect until
  shown otherwise. Do not attribute it to a fork feature without a same-version
  control.

## Environment per mode

Headless children must receive none of `DISPLAY`, `WAYLAND_DISPLAY`,
`XAUTHORITY`. The parity harness deletes exactly those three and sets
`chromiumSandbox: true`; it also deletes `WAYLAND_DISPLAY` before it starts the
private Xvfb reference, so an inherited Wayland session cannot leak into the
run.

Headed children receive only the owned virtual display created for the test
process: an `xvfb-run` screen at 1920x1080x24 and 96 DPI, with the optional
`openbox --sm-disable` reference. No personal desktop display is used, and no
window-manager theme is treated as a Chromium difference.

Keep everything else equal:

- one seed for both modes;
- the same locale and timezone;
- the same client build and probe set;
- the same fixture origins and context options;
- `--native-defaults` runs recorded as a separate profile, not as a replacement
  for the default profile.

## Checkpoint reuse

A phase may be reused only when all of these match the current run:

1. the resolved binary path and its digest;
2. the launcher digest and layer split;
3. the driver version and patch-manifest digest;
4. the seed, modes and mode order;
5. the probe-set contract version and per-file digests;
6. the environment variable set and display mode.

Write the checkpoint key as a digest over those fields. If anything differs,
create a new checkpoint; never edit or overwrite the reused one. A mixed
checkpoint is worse than no checkpoint because it looks like one run.

## Hashes

`tests/audit/lib/hashes.mjs` is the shared contract:

- `hashFile` resolves the real path, requires a regular file and returns SHA-256;
- `hashValue` hashes a stable JSON form with sorted object keys;
- `sourceManifest` walks a directory, rejects symlinks, skips `node_modules`,
  `target`, `reports` and `evidence`, and includes only `mjs`, `json`, `rs` and
  `toml` files, returning per-file digests plus a digest of the manifest.

Use these instead of ad-hoc globs when a report needs a reproducible digest.
`sha256sum` remains valid for a single artifact a human is checking.

## Private storage

- Root outside the checkout, mode 0700; files mode 0600.
- Temporary sibling plus rename for every report write.
- No proxy credentials, no license key, no profile contents, no browsing
  history, no cookies in evidence. Record names and counts, not values.
- Raw reverse-engineering exports stay in the private root and never enter the
  repository, a public issue or a test fixture.
