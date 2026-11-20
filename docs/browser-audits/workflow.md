# Reproducible browser audits

The audit tools compare explicitly selected artifacts using original local tests.
They do not discover, download or execute an arbitrary browser automatically.
Original Cloakium code remains MIT; proprietary artifacts and observations stay
outside this repository.

## Entry points

- `@cloakium-audit-private`: an explicitly selected binary or trusted launcher.
- `@cloakium-discover-browsers`: source, licence and release discovery only.
- `@cloakium-update-chromium`: prepare and validate a Chromium/Playwright candidate.
- [Canonical schemas and CLI](../../tests/audit/schema/SCHEMA.md).
- [Source-backed discovery catalogue](sources.md).
- [Skill installation and validation](../audit-skills.md).

The Nix packages are `audit`, `audit-display` and `audit-h3-lab`. The first wraps
`cloakium-audit` with the public Node, fontconfig, OpenSSL, display and HTTP/3
fixture tools. Neither installation nor discovery authorizes a binary run.

```sh
nix profile install .#audit .#audit-display
cloakium-audit --help
cloakium-audit run --help
node tests/audit/run.mjs --help
npm run test:audit:unit
```

If this checkout has both `.envrc` and `flake.nix`, use `direnv reload` for its
development environment. Do not modify Chromium pins as part of an audit.

## Separate the layers

Record these identities independently:

1. Original engine ELF and its supplied archive/signature receipts.
2. The exact trusted execution wrapper, without modifying the ELF.
3. Any additional wrapper/shaper executables in that launch chain.
4. Common vanilla Playwright and the Cloakium-patched client, including package
   content hashes and patch manifests.
5. Public SDK behavior, when an SDK is actually exercised.
6. Host, fonts, display policy, arguments, contexts, local fixtures and probes.

An FHS compatibility carrier is not the vendor's SDK. A public Cloakium launcher
test is not automatically an engine-only test. A stock control must use the same
locked Chromium source when attributing Cloakium's changes. A reference on another
Chromium milestone remains version-confounded.

Inventory never executes a target. `artifactPath` selects the native engine;
`executablePath` selects its trusted executable or script wrapper. Inventory
validates executable format before hashing, so a mistyped credential file is not
turned into an evidence digest.

```sh
cloakium-audit inventory \
  --artifact /private/selected-browser/chrome \
  --launcher /private/selected-browser/launch \
  --output /private/audit/identity.json
```

## Plan, inspect, then execute

Generate a plan with both modes and two iterations, inspect its actual JSON, and
make target-specific argument changes explicitly. A seed label does not prove
that a browser honored a seed switch.

```sh
cloakium-audit plan \
  --baseline /private/baseline/chrome \
  --candidate /private/candidate/chrome \
  --baseline-launcher /private/baseline/launch \
  --candidate-launcher /private/candidate/launch \
  --client-module /private/client/playwright-core/index.mjs \
  --locale en-US --timezone UTC \
  --suite fingerprint --suite browser-contracts \
  --output /private/audit/plan.json

cloakium-audit validate --plan /private/audit/plan.json
cloakium-audit run \
  --plan /private/audit/plan.json \
  --node /absolute/node \
  --runner /absolute/cloakium/tests/audit/run.mjs \
  --timeout 7200 \
  --output /private/audit/run-001
```

The timeout is the whole-run budget in **seconds**. A shell-tool timeout is a
separate **millisecond** budget and must cover the run, termination grace and
report collection. Do not start a duplicate after a tool-side timeout: retain
the original owner identity and inspect its liveness once.

The Node interface is exactly:

```sh
node tests/audit/run.mjs --plan /private/audit/plan.json --output /private/audit/run
```

It writes `runner-report.json`, a `cloakium.audit.runner/1` fragment. Rust owns
the final `report.json`, inventory, whole-run deadline and canonical validation.
Per-observation files, a rolling progress fragment, client/source hashes and
environment receipts remain private. Fresh artifacts use exclusive atomic
publication; rolling progress uses explicit replacement.

## Matched matrix

Use serial launches and an explicit order. For each target/client/profile:

1. Headless iteration 1, with no display endpoint.
2. Headed iteration 1 on the owned private display.
3. Headless iteration 2.
4. Headed iteration 2.

Add native-defaults, enabled, alternate-seed, noise-disabled and explicit-override
profiles only where their switches are documented or separately measured.
`--fingerprint=off` is a product configuration, not proof of stock Chromium.
Windows/macOS personas running on Linux do not establish those OS implementations.

Keep fixture origin policy, browser locale, timezone, fonts, window size, screen,
DPI, window manager, driver version and launch-default policy matched. Record
intentional differences instead of silently normalizing them away.
`probeConfig.ignoreDefaultArgs` makes a driver's removed defaults explicit.
Persistent-profile transport and its defaults are recorded separately.

Probe-only suites share one owned HTTP fixture for the entire plan. Record the
actual primary and cross-origin URLs, including their ports: an equal seed on a
different security origin is not a determinism comparison. For a later version
replay, set the same `suiteOptions.sharedFixture.port` in every configuration to
the port recorded by the prior fixture receipt. The default is `0` (allocate once
per plan); an occupied explicit replay port is refused, never stolen or silently
replaced. Network/proxy scenarios keep their separate, freshly owned fixtures.

The runner starts fresh contexts for ordinary probes and owns each
`BrowserServer` through its public process/close/kill APIs. Persistent profiles
use a Node-parent ancestry lease that excludes the parent and pre-existing
fixtures. Ownership uses PID **and start ticks**, never a process name or a bare
PID. No private Playwright process fields are used.

## Environment and displays

Headless browser environments never contain `DISPLAY`, `WAYLAND_DISPLAY`,
`WAYLAND_SOCKET` or `XAUTHORITY`. They do not need Xvfb. Each configuration gets
private HOME, temporary and XDG directories, a cleared environment, and an
enabled Chromium sandbox.

Headed runs use `cloakium-audit-display`, dynamic `-displayfd`, a private
authentication file, explicit screen/DPI/window-manager settings and verified
process/socket identities. The helper proves unauthenticated access is refused.
It never adopts a personal desktop or removes a socket based only on its user ID.

The font receipt hashes files actually visible to fontconfig under the selected
environment; browser font metrics provide a separate functional check. A declared
manifest or shared fontconfig filename alone is not font parity.
Auxiliary environment metadata is sampled on `about:blank` so intentional proxy
refusal cannot prevent it; functional realm, header and rendering probes still
use their HTTP fixtures.

Neither a minimal environment nor an FHS carrier is a malware sandbox.

## Coverage and meaning

The suites cover fingerprint/rendering contracts, HTTP wire identity, CDP and
document compatibility, proxy routing, DNS/DoH, TLS/HTTP2, HTTP/3, WebRTC,
cookies/storage, profiles, extensions and additional source-discovered surfaces.
Hardware- or permission-dependent probes preserve unknown outcomes.

The five request paths are tested separately:

- navigation;
- page `fetch`;
- `context.request`;
- `page.request`;
- `route.fetch`.

Raw Chromium proxy flags do not establish routing of Node-side request clients.
Authenticated proxies need negative controls; UDP/QUIC need direct positive
controls and relay-side attribution. Local endpoint counters prove only their
specified path, not all background egress.
Current request-path fixtures correlate the origin's TCP peer with an accepted
proxy connection, destination and lifetime. Unrelated rejected proxy traffic is
not proxy-use evidence. Older counter-window reports retain that narrower scope;
they are never retroactively promoted to connection-level proof.
This witness is validated for well-formed local fixture producers, not arbitrary
witness JSON or cross-address-family equivalence. Connection timestamps use the
fixture process's wall clock.

The passive Linux socket witness correlates owned process FDs with socket
inodes. It records sampling limits and **always** reports
`absenceEstablished: false`. Short-lived traffic, UDP `sendto`, startup before
the first sample and hostnames/content require other evidence. A page-only
network log never proves no external traffic.

No CAPTCHA, detector score or protected third-party site is acceptance evidence.

## Compare without overclaiming

```sh
cloakium-audit validate --report /private/audit/run-001/report.json
cloakium-audit compare \
  --baseline /private/audit/run-001/report.json \
  --candidate /private/audit/run-001/report.json \
  --baseline-target baseline --candidate-target candidate \
  --plan /private/audit/plan.json \
  --output /private/audit/comparison.json
cloakium-audit catalog \
  --input /private/audit/comparison.json \
  --output /private/audit/catalog.json
```

A completed execution is different from an all-passing report.
Canonical `complete: true` requires all checks to pass as well as full coverage,
clean shutdown and stable provenance. A valid report containing observed
capability differences or unknown hardware support therefore has
`complete: false`; this does not make its executed observations disappear.
For native-owner cleanup proof, retain the actual `processCleanup` receipt.
Schema-valid imported legacy or hand-authored reports without that optional
receipt do not establish Rust process ownership or cleanup.

Preserve original check detail under `result.observations.$audit`. Distinguish
functional failures, ordinary value variation, intentional policy, headless
regressions, instability, execution errors and missing coverage. Only explicitly
declared stable values are stable-field requirements. Version, driver, fonts,
display, OS, locale, timezone, seed, identity and layer confounders remain visible.
Harness lifecycle timestamps stay in the immutable per-observation receipts and
run metadata, rather than being compared as browser-returned values. Actual
Web API timing observations remain in the comparison.
Use explicit stable fields in a same-target comparison for mode/iteration
parity. Do not require different forks' noise algorithms to emit equal hashes.

Every proposed improvement needs a headless acceptance test and a headed
comparison control. Preserve native Linux identity, real hardware defaults,
credential protection, proxied SDK requests and fail-closed WebRTC unless a
separately justified policy explicitly changes them.

## Consequential native investigation

Reproduce a meaningful behavioral difference first. Reuse saved private evidence
by artifact digest, keep native projects bounded, and select the relevant code
path before enabling broad analysis. Record rejected hypotheses and incomplete
coverage. A string, relocation, CFI stub or instruction-form match is not proof
of a patch, function boundary or live execution.

Keep raw decompilation, vendor tables, resources and credentials private.
An independent implementation worker receives behavioral requirements, public
standards and original tests—not vendor implementation material.

## Failure and replay

Rust holds an outer kernel lease; both direct and Rust-invoked Node runners also
share a private PID/start-ticks lease. A lease is never automatically stolen.
Owner death alone does not prove an orphaned browser is gone: inspect the
recorded owned process instances and cleanup evidence before explicit recovery.
Never bypass licensing or its concurrency limit.

If execution already finished but a report codec needs correction, do not rerun
the browsers. `finalize` revalidates terminal, immutable evidence and writes a new
report while preserving the original:

```sh
cloakium-audit finalize --run-dir /private/audit/run-001 \
  --output /private/audit/run-001/report.recovered.json
```

For replay, retain the plan bytes, inventory, all source/client/font/config
digests, fixture versions, actual environment receipts, observations, cleanup
receipts and catalogue inputs. Do not overwrite a previous run. A new browser,
client, probe or environment digest starts a new evidence lineage.

The runner archives hash-verified source files under
`source-snapshot/tests/audit`; its manifest stays outside that code tree. Replay
with the archived `tests/audit/run.mjs` as `--runner`, not a subsequently edited
checkout. Retain the selected client packages and Nix runtime closures too.
