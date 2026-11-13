# `@cloakium/browser` API

A Playwright-only wrapper around a Chromium build supplied by the host. It owns
option assembly, proxy normalisation, per-profile fingerprint seeds, optional
GeoIP resolution, and an opt-in humanize layer. It never downloads a browser and
contains no licensing, payment, update-check, or telemetry code.

Package surface:

```ts
import {
  launch,
  launchContext,
  launchPersistentContext,
  buildLaunchOptions,
  buildContextOptions,
  humanizeBrowser,
  resolveBinaryPath,
  maybeResolveGeoip,
} from "@cloakium/browser";
import { patchBrowser, patchContext, patchPage, resolveConfig } from "@cloakium/browser/human";
```

## Browser binary

Resolution order, first hit wins:

1. `CLOAKIUM_BINARY_PATH`
2. `CLOAKBROWSER_BINARY_PATH` (legacy deployments)
3. `cloakium-chromium` on `PATH`

A configured path that does not exist or is not executable throws
`BinaryNotFoundError`; there is no fallback search and no download. In practice
the host (Nix, container image, CI job) provides the patched build.

## Launch options

```ts
interface LaunchOptions {
  headless?: boolean;                 // default true
  proxy?: string | { server: string; bypass?: string; username?: string; password?: string };
  args?: string[];                    // extra Chromium switches
  extensionPaths?: string[];
  stealthArgs?: boolean;              // default true: --fingerprint + WebRTC policy
  fingerprintSeed?: string | number;  // fixed seed; default random 5 digits
  timezone?: string;                  // IANA zone
  locale?: string;                    // BCP 47
  geoip?: boolean;
  geoipResolver?: (input: { proxy?: ProxyInput }) => GeoResult | null | Promise<GeoResult | null>;
  launchOptions?: Record<string, unknown>;  // forwarded to chromium.launch()
  humanize?: boolean;
  humanPreset?: "default" | "careful";
  humanConfig?: Partial<HumanConfig>;
}

interface LaunchContextOptions extends LaunchOptions {
  userAgent?: string;
  viewport?: { width: number; height: number } | null;  // default null
  timezoneId?: string;                                  // alias of timezone
  colorScheme?: "light" | "dark" | "no-preference";
  contextOptions?: BrowserContextOptions;
}

interface LaunchPersistentContextOptions extends LaunchContextOptions {
  userDataDir: string;
}
```

### Functions

- `launch(options?)` → Playwright `Browser`. Contexts created from it default to
  `viewport: null` so the page follows the real window instead of Playwright's
  1280×720 emulation.
- `launchContext(options?)` → `BrowserContext`; closing it closes the browser.
- `launchPersistentContext({ userDataDir, ... })` → the persistent
  `BrowserContext`, with `viewport: null` by default.
- `buildLaunchOptions(options?)` → the object passed to `chromium.launch()`
  without starting a browser. Useful for embedding or tests.
- `buildContextOptions(options?)` → `newContext()` options with the same
  defaults.
- `humanizeBrowser(browser, options?)` → apply the humanize layer to a browser
  the caller launched itself (requires `humanize: true`).
- `resolveBinaryPath()` / `tryResolveBinaryPath()` → the executable resolution
  described above.
- `maybeResolveGeoip(options)` → the resolved `{ timezone?, locale? }` or a
  typed error.
- `resolveEgressIp(proxy?, timeoutMs, env?)` / `isPrivateIp(ip)` → the egress
  address discovery used by GeoIP, exposed for diagnostics and custom resolvers.

`launchOptions` is forwarded to `chromium.launch()` / `launchPersistentContext()`,
but the fields this package owns always win: `executablePath`, `proxy`, `args`,
`ignoreDefaultArgs` and `headless` come from the wrapper options. A
`launchOptions.proxy` is still accepted (and normalised) when no `proxy` option
is given, so a credentialed URL can never reach Chromium's `--proxy-server`.

### Sandbox, flags and platform honesty

- The sandbox stays **enabled** unless Playwright/Chromium is configured
  otherwise by the caller (for example an explicit `--no-sandbox` in `args`, or
  `chromiumSandbox: false` in `launchOptions`).
- Only Chromium switches that the wrapper genuinely needs are added:
  `--fingerprint=<seed>`, the WebRTC IP handling policy described below and,
  for headed launches (and Windows), `--ignore-gpu-blocklist`.
  `--start-maximized` is added only for an explicit `headless: false` launch
  that supplied no window geometry and no viewport; a headless launch
  (`headless` omitted or `true`) never emits it.
- No `--fingerprint-platform`, `--lang`, `--fingerprint-locale` or
  `--fingerprint-timezone` is emitted. A partially patched build would ignore
  them, and claiming another operating system on this host would be incoherent.
  `locale` and `timezone` travel through Playwright's context emulation instead;
  a caller's explicit `contextOptions.locale` is overridden by the wrapper field
  of the same name.
- `ignoreDefaultArgs` removes `--enable-automation` only. Playwright's
  `--enable-unsafe-swiftshader` default is kept so WebGL still works on
  GPU-less hosts; pass `launchOptions.ignoreDefaultArgs: true` if the deployment
  wants its own complete argument list (an explicit `true` is the only
  forwarded `ignoreDefaultArgs` value).

### WebRTC egress privacy

A proxied context is not private if WebRTC can still send STUN/ICE UDP straight
from the host. The default privacy args therefore set the WebRTC IP handling
policy to `disable_non_proxied_udp` using the browser's effective switch:

- `--webrtc-ip-handling-policy=disable_non_proxied_udp` — the Chrome switch
  mapped to the `webrtc.ip_handling_policy` preference
  (`chrome/common/chrome_switches.h`, `chrome/browser/prefs/chrome_command_line_pref_store.cc`).
  This is the one the Chromium browser Playwright launches actually honours.

The similarly named `--force-webrtc-ip-handling-policy` is for other Chromium
shells and is inert in this browser, so it is not emitted.

The command line is browser-wide, so the policy also applies to contexts created
later with a different `proxy` (proxy rotation cannot drop back to direct UDP).
No invented or vendor-specific WebRTC flag is emitted.

Tradeoff: UDP WebRTC is disabled unless the traffic can be routed through a
proxy or a TCP path, so some peer-to-peer media flows fail by design. A caller
can override the switch by passing the same `--key` in `args` (last wins, for
example `--webrtc-ip-handling-policy=default` to restore stock behaviour), or
opt out of all default privacy switches with `stealthArgs: false`. This blocks
the non-proxied UDP egress path; it is not a guarantee that every WebRTC
protocol is proxied.

### Chromium sandbox

`chromiumSandbox` is explicitly enabled by default; Playwright's own default is
disabled. A deployment that deliberately accepts that risk must opt out with
`launchOptions: { chromiumSandbox: false }`. Containers should provide suitable
user namespaces instead of treating an unavailable sandbox as permission to
disable it silently.

### Proxy

`proxy` accepts a URL string or a Playwright proxy object. Credentials — whether
they arrive as URL userinfo or embedded in an object's `server` — are moved into
`server`-free `username`/`password` fields, and the result is passed to
Playwright, which installs and authenticates the proxy (so `context.request()`
and `route.fetch()` are proxied as well). The `server` string never contains a
username or password, so no credential-bearing URL can end up in Chromium's
`--proxy-server` switch or a diagnostic.

SOCKS4/SOCKS5 endpoints cannot be authenticated through this path; supplying
SOCKS credentials throws `ProxyAuthUnsupportedError` instead of dropping them.
Proxy parse errors, SOCKS errors and failures raised while launching or
resolving the egress IP are scrubbed: they never echo a username, a password or
a completed credentialed URL. URL userinfo is rewritten to `scheme://***@host`,
and detected credential values are removed from any launch error message.

```ts
const browser = await launch({
  proxy: "http://user:pass@proxy.example:8080",
  headless: false,
});
```

### Per-profile seed

`launchPersistentContext` keeps one fingerprint identity per profile:

- `.cloakium-seed` is created on first launch with a deterministic five-digit
  seed derived from the profile path, published with `link(2)` (or an exclusive
  create where hard links are unavailable) so concurrent first launches converge.
- An existing `.cloakbrowser-seed` is honoured read-only; no new file is written.
- An explicit `--fingerprint=...` in `args`, or `stealthArgs: false`, leaves the
  profile untouched.

```ts
const context = await launchPersistentContext({ userDataDir: "./profiles/acme" });
```

## GeoIP

GeoIP is optional and has **no download path**. Enable it only when a source is
configured:

```ts
// a) caller-supplied resolver — also the easiest way to stay offline
await launch({
  geoip: true,
  geoipResolver: () => ({ timezone: "Europe/Berlin", locale: "de-DE" }),
});

// b) MaxMind database + optional `mmdb-lib` peer
process.env.CLOAKIUM_GEOIP_DB = "/var/lib/geoip/GeoLite2-City.mmdb";
await launch({ geoip: true, proxy: "http://proxy.example:8080" });
```

- Explicit `timezone`/`locale` options always win and suppress the lookup
  entirely.
- Without a resolver or database, `geoip: true` throws `GeoipUnavailableError`
  naming the remedies. It does not silently launch with mismatched signals.
- Egress IP discovery uses `CLOAKIUM_GEOIP_IP` when set, otherwise an echo
  endpoint (`CLOAKIUM_GEOIP_ECHO_URL`, default `https://api.ipify.org`) reached
  directly or through the proxy. The echo endpoint may be `http:` or `https:`;
  anything else is rejected. SOCKS discovery needs the optional
  `socks-proxy-agent` peer.
- A discovered address that is private or loopback is rejected rather than
  resolved to a bogus country; an explicit `CLOAKIUM_GEOIP_IP` is always taken
  as given (which keeps offline fixtures possible).
- `CLOAKIUM_GEOIP_TIMEOUT_MS` bounds the lookup (default 10 s).
- Only a country→locale hint table is built in; an unmapped country leaves the
  locale to the browser.
- GeoIP errors never include proxy credentials: the proxy is normalised before
  the lookup and diagnostics are scrubbed.

## Humanize layer (`@cloakium/browser/human`)

Opt-in per launch (`humanize: true`) or manually:

```ts
import { patchBrowser, patchContext, patchPage, resolveConfig } from "@cloakium/browser/human";

const config = resolveConfig("default", { keyGap: [60, 120] });
patchBrowser(browser, config);   // existing + future contexts/pages
patchContext(context, config);   // one context
patchPage(page, config);         // one page
```

`resolveConfig(preset?, overrides?)` returns a frozen, validated config;
`mergeConfig(base, overrides)` merges one. Unknown fields, inverted ranges and
out-of-range values throw `ConfigurationError`.

### What is humanized

| Surface | Behaviour |
|---|---|
| `locator.click/dblclick/hover/tap`, `page.click`, `frame.click` | visibility wait, wheel scroll when needed, covered-element check, curved pointer path, press/hold timing, modifiers |
| `locator.fill`, `locator.type`, `locator.pressSequentially`, `page.fill/type` | click to focus, select-all + Backspace, per-character key hold and gap |
| `locator.press`, `page.press` | click to focus, key press with human hold time |
| `locator.check/uncheck/setChecked` | state check, human click, state verification |
| `locator.clear` | click to focus, select-all + Backspace |
| `locator.focus` | wheel scroll, then Playwright's focus primitive |
| `locator.scrollIntoViewIfNeeded` | wheel notches, re-measuring the element |
| `mouse.click/dblclick` | curved path to the point, press timing |
| `mouse.wheel` | large deltas are split into 100 px notches |
| `keyboard.type` | per-character typing with key hold and gaps |

Everything goes through Playwright's mouse/keyboard/touch pipeline, so the page
sees real (`isTrusted`) input events. No synthetic `KeyboardEvent` is dispatched
from page JavaScript. `tap` requires `hasTouch: true` on the context, exactly
like Playwright's own `tap`.

Wrappers install on the `Page`, `Frame`, `Locator`, `Mouse` and `Keyboard`
prototypes once, are marked with an internal symbol, and fall back to the
original Playwright method for any page that was never patched — one humanized
page cannot change another page's behaviour. Re-patching a page, context or
browser updates a mutable config holder, so the new configuration applies to the
targets that already exist **and** to pages/contexts created afterwards; no
wrapper is stacked.

### Limitations (deliberate)

- **Not humanized:** `ElementHandle` actions (`elementHandle.click()`),
  `selectOption`, `dragTo`/`dragAndDrop`, `selectText`, `setInputFiles`, and all
  read methods (`textContent`, `inputValue`, …). Use locators for actions; the
  stock Playwright implementations remain available and unchanged.
- **Timeouts:** one `Deadline` covers the whole public call. An explicit
  `timeout` is an overall budget for that call — the visibility wait, the
  focusing click, the configured pauses and the typing all spend from it, so a
  `fill` cannot exceed its timeout by the length of several internal waits.
  `timeout: 0` disables the budget. When no `timeout` is given, element waits
  hand `undefined` to Playwright so the page/context default
  (`page.setDefaultTimeout`) applies, with a 30 s internal cap for the wrapper's
  own polling.
- **Hit testing** uses one `elementFromPoint` probe at the chosen point inside
  the element's own frame. `force: true` skips the visibility wait and the
  coverage check, but an element without a box fails immediately instead of
  waiting for the timeout. Strict-mode violations from a locator surface
  unchanged and never click anything.
- **Scrolling** scrolls vertically with the wheel. If the wheel cannot move the
  element (for example a container not under the pointer), Playwright's
  `scrollIntoViewIfNeeded` is used once as a documented fallback.
- **Typing** appends at the caret produced by the focusing click. `insertText`
  is used for characters without a physical key.
- **Modifiers** are pressed and released around the action; a modifier the
  caller was already holding is not preserved.
- **Determinism:** pass `humanConfig.random` to make paths and delays
  reproducible in tests.

## Playwright compatibility

`playwright-core >= 1.64.1 < 1.66.0` is supported and the suites run against
1.65.0. Only documented client API is used (`Browser`, `BrowserContext`, `Page`,
`Frame`, `Locator`, `Mouse`, `Keyboard`, `errors`); there is no dependency on
private fields, internal bundles, or injected-script internals. An omitted
`timeout` is forwarded as `undefined`, so Playwright's own page/context default
applies instead of a wrapper-imposed number. If a future Playwright release
changes a public behaviour the wrapper relies on, the tests in `tests/browser`
and `tests/human` fail rather than the wrapper degrading quietly.

## Interoperability notes

- `CLOAKBROWSER_BINARY_PATH`, `CLOAKBROWSER_GEOIP_DB` and
  `CLOAKBROWSER_GEOIP_TIMEOUT_MS` are accepted as legacy aliases of the
  `CLOAKIUM_*` variable of the same meaning.
- `.cloakbrowser-seed` files are read but never written.
- `launch`, `launchContext`, `launchPersistentContext`, `buildLaunchOptions`,
  `buildContextOptions`, `humanizeBrowser` and the `human` subpath exports keep
  the calling conventions existing integrations expect.

## Tests

```sh
npm run build
npm test                    # Node, then Bun when available
CLOAKIUM_BINARY_PATH=/path/to/chromium npm test   # includes browser suites
```

The browser suites report `SKIP` when no binary is configured.
`CLOAKIUM_TEST_NO_SANDBOX=1` adds an explicit `--no-sandbox` for hosts whose
sandbox cannot start; the wrapper itself never adds it.

`tests/browser/webrtc.test.mjs` runs a localhost-only UDP STUN responder and an
in-page `RTCPeerConnection` probe: a baseline launch reaches it, while the
default privacy args send no request and gather no server-reflexive candidate.
The probe never contacts an external STUN server and never prints an address.
