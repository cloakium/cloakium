# Wire identity

One original probe that compares what JavaScript sees with what the HTTP server
actually received, in both the page and a dedicated worker:

- `navigator.userAgent` ↔ `User-Agent`
- `navigator.language` / `languages[0]` ↔ `Accept-Language` (primary tag only)
- `userAgentData.platform` ↔ `Sec-CH-UA-Platform`
- high-entropy `platformVersion`, `architecture`, `bitness` ↔ the matching
  `Sec-CH-UA-*` request headers

The receipt comes from the fixture origin's `/headers` route, so it is a server
observation, not CDP metadata. A hint the browser did not send is `passed: null`
(unknown), never a pass; a header that disagrees with JavaScript is `false`.

## Contract

```js
export const probes = [{
  id: 'wire-main-worker-identity', family, timeoutMs,
  async run({ page, origin }) => { observations, checks, limitations }
}];
export function identityChecks(sample, headers, prefix) // pure, testable
```

## Check

```bash
node tests/audit/wire-identity/selfcheck.mjs
```
