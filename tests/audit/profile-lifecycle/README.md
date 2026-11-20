# Profile lifecycle

Nine staged scenarios over persistent profiles: launch contract, persistence
across a clean close/reopen, fresh-profile isolation, `storageState` export and
import, portable-cookie behaviour under a documented flag, metadata-only
inspection, seed stability, a side-loaded MV3 extension, and the default search
provider observation.

One persistent context is open at a time (a promise-chain mutex). A failed close
locks out further launches. Each scenario owns its profile directory, and only
closed, lab-owned profiles are copied.

## Caller API

```js
const report = await runScenarios({
  chromium,             // Playwright BrowserType (launchPersistentContext)
  executablePath,       // absolute path, caller-selected
  headless,             // boolean
  baseArgs,             // launch arguments, validated
  baseEnv,              // REQUIRED explicit environment snapshot
  ignoreDefaultArgs,    // caller additions, merged with the driver defaults
  contextOptions,       // { locale, timezoneId } applied to every persistent launch
  output,               // absolute, owned 0700 directory
  scenarios,            // optional id selection
  masterSeed, keepProfiles, signal, log
});
```

The persistent driver keeps its own ignored defaults
(`--enable-automation`, `--enable-unsafe-swiftshader`, `--no-sandbox`); caller
additions are merged de-duplicated and recorded literally per launch. Those
defaults differ from BrowserServer defaults, so cross-engine comparisons must use
the common caller policy, not the raw lists. The report exposes
`browserVersions` (unique, actual, non-null) and a per-launch `launches` array
(label, headless, version, redacted args, effective ignore list, context options).

`baseEnv` is mandatory: the aggregate never falls back to the ambient process
environment. `baseEnvFrom()` is exported for standalone helpers and tests only.
`lib/env.mjs` chooses which keys reach the browser:

- headless launches **never** receive `DISPLAY`, `WAYLAND_DISPLAY`,
  `WAYLAND_SOCKET` or `XAUTHORITY`, even when the snapshot carries them;
- a headed launch requires an explicit `DISPLAY` in `baseEnv` and uses only the
  display the caller named — it never falls back to an inherited one;
- other allowlisted keys (`HOME`, `PATH`, locale, `TMPDIR`, XDG, DBus, font
  config, `LD_LIBRARY_PATH`) pass through unchanged.

The report records environment *key names* per launch, never values, and never
stores cookie values, key material or a canary.

## Report safety

- Artifacts are written with the parent `atomicJson` helper: initial writes never
  overwrite, and each rolling `report.json` update is an explicit overwrite. A
  pre-existing scenario artifact is refused before any launch.
- `output` and the work root must be owned, non-symlink directories with mode
  `0700` (`privateDirectory` enforces this).
- Failures are stored as `safeError` records (`operation`, `name`, `category`,
  optional known `code`, and a fixed "raw text omitted" detail). Driver messages
  and stacks are never persisted.
- Classification uses the parent `summarizeResult`: `pass` / `fail` / `unknown`
  per check, so `stage-needed`, `unavailable`, `unsupported-by-target` and
  `inconclusive` are coverage gaps, never product failures.

## Lifecycle and cleanup receipt

One persistent context at a time; a failed `context.close()` is fail-closed —
the lab sets `failedCleanup`, refuses further launches, and the run terminates
with `status: "failed"`. Every report carries:

```js
cleanup: {
  contextsOpened, contextsClosed, activeProfiles, failedCleanup,
  profilesRetained,
  processVerification: 'not-exposed-by-public-persistent-context-api',
  limitations: [ ...transport and process-tree notes ]
}
```

`launchPersistentContext` spawns the browser process internally: the public API
exposes no process handle, so descendant processes cannot be verified here. A
`BrowserServer` transport would expose `server.process()`; process-tree proof
belongs to the browser-launch group, and this receipt says so explicitly rather
than claiming a clean process tree.

Each scenario returns `{ observations, checks, limitations, coverage, failed }`
and is persisted both as `<id>.json` and inside the rolling report.

## Scenarios

| Id | Observation |
| --- | --- |
| `launch-contract` | Arguments reach the engine, sandbox stays on, no `--no-sandbox` |
| `profile-persistence` | Cookie, localStorage and IndexedDB survive close/reopen |
| `profile-isolation` | A new profile contains none of another profile's canary |
| `storage-state` | `storageState({indexedDB})` export, then `setStorageState` import |
| `portable-cookies` | Closed-profile copy restarted on the same host |
| `profile-metadata` | File sizes/modes, SQLite header, JSON key names — metadata only |
| `seed-persistence` | Identity stable across reopen and across profiles |
| `extension-mv3` | Service worker target, marker value, content-script id |
| `search-engine` | Command-line flag plus Preferences key paths (optional) |

Limitations are explicit: a same-host copy is not cross-machine proof, and an
absent OS-bound credential blob on Linux is not a defect.

## Environment

`CLOAKIUM_AUDIT_PRIVATE_ROOT` selects the private root for work directories and
the `LAB_FIXTURE.json` ownership marker (default `/tmp/opencode`).

## Checks

```bash
node --test tests/audit/profile-lifecycle/tests/*.test.mjs
```
