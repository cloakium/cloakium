# Catalog contract

## Current owner

The committed catalog is `tests/audit/catalog/sources.json` and declares
`schema: "cloakium.audit.sources/1"`. The readable claim page is
`docs/browser-audits/sources.md`, and `tests/audit/additional/tests/catalog.test.mjs`
validates the shape and axis coverage. The audit comparison schemas under
`tests/audit/schema` cover plan, report, runner, policy, inventory, compare and
the merged gap catalog; they do not define the discovery claim catalog.

## Entry fields

| Field | Content |
| --- | --- |
| `id` | Stable lowercase identifier, used as the audit checkpoint target ID |
| `repository` | Canonical repository URL |
| `commit` | Full commit SHA actually read |
| `kind` | Observed kind, for example `chromium-patch-set`, `chromium-fork`, `gecko-fork` |
| `sourceAvailability` | What source is actually published, in one sentence |
| `license` | `status`, `spdx`, `proofUrl`, `notes` |
| `engine` | `family`, `version`, `evidence[]` |
| `platforms` | Per-artifact platform list |
| `headless`, `cdp`, `playwright` | `status` plus `evidence[]`, never a bare claim |
| `release` | `tag`, `name`, `publishedAt`, `url`, `assets` |
| `freshness` | `lagMajorsBehindLatestChromium`, `note` |
| `features` | `id`, `claim`, `evidence[]` |
| `executionStatus` | `not-executed` for every discovery entry |
| `limitations` | What the evidence cannot establish |
| `reason` | Why the entry is in this state |

Every `evidence[]` item records `url`, `path`, `commit` and `kind`, so a reader
can re-read the same revision instead of a moving branch.

## Rules

- IDs are unique. Two entries for one project are duplicates unless they differ
  in revision or artifact.
- Sorting is by ID. Adding an entry must not reorder existing ones.
- A field that was not observed is `null` or omitted by the schema's rule, never
  filled with a plausible guess.
- `not-executed` is not a capability claim. It says the candidate was not
  acquired, installed or launched.
- `features[].id` is a claim identifier. Its count is a count of documented
  claims, not of recovered engine features.
- A schema version bump is a new version, not an in-place edit.
- The catalog is data. Rendering it as a table does not make a claim an
  observation.

## Handoff

When a candidate is selected, its catalog `id` becomes the audit checkpoint's
target ID so a later version diff is keyed by the same value. Discovery supplies
source facts; the audit supplies behaviour; neither overwrites the other's
fields.
