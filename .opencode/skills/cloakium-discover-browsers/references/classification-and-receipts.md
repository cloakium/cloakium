# Classification and receipts

## Kind

- **Native engine fork**: patches engine source and builds its own binary. Patch
  replay and build provenance are the important facts.
- **Rebranded distribution / wrapper**: ships an upstream or vendor binary with a
  different name, defaults or launcher. The engine is upstream; the wrapper is
  the local change.
- **Browser product**: an end-user browser, possibly closed. Source availability
  and license decide whether it can be evaluated at all.
- **Automation library / driver**: changes the automation layer, not the engine.
  Its compatibility claim is with a specific engine version.

A single project can occupy two rows. Record both and say which layer the audit
must inspect.

## Source and license are different axes

| Observation | Meaning |
| --- | --- |
| OSI license file with matching manifest field | open source; still check notices and third-party components |
| Source available under non-OSI terms | not open source; redistribution and modification may be restricted |
| Binary only, no source | no audit of source; behavioural audit only, with a license review first |
| No license file | all rights reserved by default; do not redistribute or vendor it |

Read the actual `LICENSE`, `COPYING` and `NOTICE` files at a pinned commit. A
README badge, a website claim or a package-registry field is a claim, not the
license.

## Platform and compatibility

- Record platform support per artifact, not per project. A project that supports
  Linux x86-64 says nothing about ARM64.
- Distinguish real headless mode from "runs under Xvfb". Both can be valid, but
  only one is a production headless dependency.
- For Playwright, record whether stock `playwright-core` works or a patched
  driver is required. A driver patch changes the compatibility contract.
- CDP support is not Playwright compatibility. A browser can expose CDP and still
  fail Playwright's launch, context or input contracts.

## Freshness

- Prefer an exact commit SHA; a branch name is not a pin.
- Record the upstream engine version the fork is based on, not the fork's own
  version string.
- Record the Playwright reference build separately. A version distance is
  information, not proof of incompatibility; the tested pair decides.
- A high release cadence with a stale engine is worse than a lower cadence on a
  current engine. Record both.

## Receipt template

Match the committed catalog shape (`cloakium.audit.sources/1`):

```json
{
  "id": "",
  "repository": "",
  "commit": "",
  "kind": "",
  "sourceAvailability": "",
  "license": { "status": "", "spdx": "", "proofUrl": "", "notes": "" },
  "engine": { "family": "", "version": "", "evidence": [] },
  "platforms": [],
  "headless": { "status": "", "evidence": [] },
  "cdp": { "status": "", "evidence": [] },
  "playwright": { "status": "", "evidence": [] },
  "release": { "tag": "", "name": "", "publishedAt": "", "url": "", "assets": 0 },
  "freshness": { "lagMajorsBehindLatestChromium": 0, "note": "" },
  "features": [{ "id": "", "claim": "", "evidence": [] }],
  "executionStatus": "not-executed",
  "limitations": [],
  "reason": ""
}
```

Observed status values include `osi-approved`, `inherited-unverified`,
`executable-path-only-unverified`, `not-applicable`, `unsupported` and
`not-executed`. Treat them as observed values, not as the complete enumeration;
the catalog test validates shape and coverage, and no separate sources JSON
Schema is published.

Every non-empty digest in the template must come from a command that ran, not
from a copied value. A `features[].id` is a claim identifier, not a recovered
feature count, and `features[].claim` stays a claim with evidence URLs.

## Acquisition decision

Before bringing a candidate into this repository or a build:

1. license permits the intended use and redistribution;
2. notices required by the license are identified;
3. artifact digest matches the project's published value;
4. source revision matches the artifact's claimed revision;
5. no runtime download or install is required to make it work.

If any answer is unknown, the candidate remains outside the repository. An
unknown license is not permission.
