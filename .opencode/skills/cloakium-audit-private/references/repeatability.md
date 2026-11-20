# Repeatability across fork versions

## Carry forward

Keep these values fixed between runs unless the question changes:

- resolved binary path and launcher split;
- seed, locale, timezone;
- mode list and mode order;
- profile variants (default and `--native-defaults`);
- probe-set contract versions and per-file digests;
- fixture definitions and their digests;
- actual fixture security origins (scheme, hostname and port);
- classification vocabulary.

Anything that must change is a deliberate variable; write it in the report
header, not only in the diff.

The generic runner holds one owned probe fixture for the whole plan. Its
`suiteOptions.sharedFixture` policy defaults to `{ "port": 0 }`, allocated once.
For a version replay, use the prior receipt's actual port in every configuration;
an occupied replay port is refused. A fresh ephemeral port in a separate run
changes the security origin and confounds origin-scoped noise hashes.

Keep the hash-verified `source-snapshot/tests/audit` tree and the sibling
`snapshot-manifest.json`. Use that archived `run.mjs` as `--runner` for a replay;
do not assume the current checkout still contains the producer's exact bytes.
Source snapshots contain original harness sources, never a private browser,
credential file, vendor resource bundle or decompilation.

## Catalog IDs

Compare by stable ID, never by array index or file order:

- fingerprint probes use their declared `id` and `family`;
- network and storage probes use their `net.*` style IDs;
- profile-lifecycle scenarios use their scenario ID;
- request-path and wire-identity probes use their declared ID;
- parity probes use their probe `name`, grouped by the family prefix.

If a probe is renamed, record the rename as one removed ID and one added ID.
Do not report it as a value change.

## Diff recipe

1. Sort both catalogs by ID.
2. Emit `added`, `removed`, `changed` and `unchanged` sets.
3. For `changed`, compare observations structurally and report the smallest
   differing path, not a whole-object dump.
4. Compare result classes first: `unavailable` or `inconclusive` to `pass` is a
   coverage change, not by itself a demonstrated product improvement.
5. Preserve declared diagnostics by name so an intentional difference does not
   appear as a regression.

## Report header

Record at minimum:

- schema version of the report;
- target identities and digests per layer;
- inventory and probe-set versions;
- seed and mode order;
- host platform, kernel and sandbox availability;
- which suites ran, which were skipped, and why;
- declared diagnostics and intentional fail-closed paths.
- actual shared fixture origins and source snapshot digest.

A future version diff is only meaningful when both reports share that header
shape. Changing the header mid-series breaks comparability; version it instead.
