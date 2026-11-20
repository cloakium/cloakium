# Browser contracts

Ten original probes over CDP, native descriptors, trusted input and browser
defaults. They answer questions a fingerprint check cannot: is the navigator
surface still native, does the debugger see what page script cannot, is dispatch
input trusted, and do Chromium's own bounds still hold.

| Probe | Contract |
| --- | --- |
| `native-property-contract` | Navigator getters reject invalid receivers, nothing is an own property, main frame and same-origin iframe agree |
| `cdp-console-observation` | `Runtime.enable` plus explicit `Runtime.evaluate` still work; a local getter is not re-read by logging |
| `trusted-input-metadata` | Pointer, keyboard and wheel events are `isTrusted`, reach the requested element, and carry correct text |
| `unactivated-popup-policy` | Parser-initiated popups stay bounded without activation |
| `closed-shadow-encapsulation` | Page script cannot reach a closed root while CDP `pierce` can |
| `navigation-flood-policy-observation` | A bounded same-document burst cannot change the origin |
| `default-search-ui-observation` | Requires a persistent profile; owned by `profile-lifecycle/search-engine` |
| `realtime-audio-clock` | A scheduled realtime AudioContext advances its clock at wall-clock speed |
| `cdp-focus-state` | `Emulation.setFocusEmulationEnabled` keeps visibility fields coherent |
| `playwright-document-load-contract` | `page.setContent` completes and writes its DOM (client compatibility only) |

Priming uses loopback HTTP fixtures. `page.setContent` appears in exactly one
probe, as a compatibility contract, so it can never mask Web API coverage.

## Contract

```js
export const probes = [{
  id, family, timeoutMs, run({ page, context, browser, origin })
    => { observations, checks: [{ name, passed }], limitations }
}];
```

`passed: null` means the surface was not evaluable on this host.

## Check

```bash
node tests/audit/browser-contracts/selfcheck.mjs
```
