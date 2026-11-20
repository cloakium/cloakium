# Request-path egress probes

Five original probes that attribute one HTTP request to the stack that produced
it, for five documented client paths:

| Probe | Path |
| --- | --- |
| `reqpath.goto.browser-stack` | `page.goto` |
| `reqpath.page-fetch.browser-stack` | in-page `fetch()` |
| `reqpath.context-request.api-context` | `context.request` |
| `reqpath.page-request.api-context` | `page.request` |
| `reqpath.route-fetch.api-context` | `route.fetch` |

Attribution uses the fixture proxy counters, not peer addresses: a loopback
origin cannot distinguish callers by address, so only a browser-stack request
advances the proxy's absolute-form/CONNECT counters. Each probe reports a receipt
(origin-observed host/path/method), the proxy counter delta, and an
`egress: proxied | direct | unknown` classification. Node-side paths are recorded
as observations of the client library, never graded as a product safety result.

Five launch plans compare raw proxy flags with the documented Playwright `proxy`
option: `rp-raw-http-anon`, `rp-pw-http-auth`, `rp-raw-http-inline`,
`rp-raw-socks5`, `rp-raw-socks5-inline-auth`. Fixtures come from the network
family (`../network`), loopback only, port `0`, dummy credentials per run.

## Contract

```js
export const probes = [{
  id, family, timeoutMs, requirements,
  async run({ context, browser, origin, lab, config, deadline })
    => { observations, checks, limitations, status, denominator }
}];
```

`configForScenario(plan)` carries the route shape only — endpoint name and mode,
never a credential value.

## Checks

```bash
node tests/audit/request-paths/selfcheck/syntax.mjs      # structure + credential-free config
node tests/audit/request-paths/selfcheck/run.mjs         # fixtures, receipts, classification
node tests/audit/request-paths/selfcheck/browser.mjs \
  --executable-path /abs/chromium --playwright /abs/node_modules/playwright-core/index.mjs
```

The browser smoke is optional and headless-only; it never adds `--no-sandbox`,
never weakens TLS, and prints observations without a pass claim.
