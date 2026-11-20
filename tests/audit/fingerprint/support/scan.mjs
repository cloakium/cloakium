// Static self-consistency helpers for the probe modules.
//
// Used by the contract test and the catalog generator so the declared checks and
// the checks actually recorded by each probe cannot drift apart. This is a source
// scan, not a substitute for running the probe.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDED_DIRECTORIES = new Set(['support', 'tests', 'scripts', 'node_modules']);

export function moduleFiles() {
  return readdirSync(root, { recursive: true })
    .filter((entry) => entry.endsWith('.mjs'))
    .filter((entry) => !entry.split('/').some((part) => EXCLUDED_DIRECTORIES.has(part)))
    .filter((entry) => entry !== 'index.mjs' && entry !== 'manifest.mjs')
    .sort()
    .map((entry) => join(root, entry));
}

// Maps each probe id to the module that declares it, verified by the literal
// `id: '<probe-id>'` occurrence.
export function mapProbeSources(probes) {
  const sources = moduleFiles().map((file) => ({ file, source: readFileSync(file, 'utf8') }));
  const mapped = new Map();
  for (const probe of probes) {
    const hits = sources.filter((entry) => entry.source.includes(`id: '${probe.id}'`));
    if (hits.length === 1) mapped.set(probe.id, hits[0]);
  }
  return mapped;
}

// Every `rec.expect('name'` / `rec.unknown('name'` literal in the module body,
// counted per verb. A name may legitimately appear once as `expect` and once as
// `unknown` (mutually exclusive branches); it must not appear twice under the
// same verb, which would mean two unconditional verdicts.
export function emittedCheckLiterals(source) {
  const counts = new Map();
  const patten = /rec\.(expect|unknown)\(\s*'([^']+)'/g;
  for (const match of source.matchAll(patten)) {
    const key = `${match[1]}:${match[2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function limitCodes(source) {
  const codes = new Set();
  for (const match of source.matchAll(/rec\.limit\(\s*'([^']+)'/g)) codes.add(match[1]);
  return [...codes].sort();
}

// Declared/emitted drift: names emitted but not declared, declared names that
// never appear in the module, duplicate declarations, and names given two
// verdicts of the same kind (a double-verdict bug).
export function scanConsistency(source, declared) {
  const counts = emittedCheckLiterals(source);
  const emitted = new Set([...counts.keys()].map((key) => key.slice(key.indexOf(':') + 1)));
  const undeclaredEmitted = [...emitted].filter((name) => !declared.includes(name));
  const missingInSource = declared.filter((name) => !source.includes(`'${name}'`));
  const duplicatesDeclared = declared.filter((name, index) => declared.indexOf(name) !== index);
  const repeatedVerdicts = [...counts.entries()]
    .filter(([key, count]) => count > 1 && declared.includes(key.slice(key.indexOf(':') + 1)))
    .map(([key]) => key);
  // A name that appears only once exists solely in the contract: it is declared
  // but never recorded, so the declared count would exceed the runtime count.
  const declaredOnlyInContract = declared.filter(
    (name) => source.split(`'${name}'`).length - 1 < 2
  );
  return { undeclaredEmitted, missingInSource, duplicatesDeclared, repeatedVerdicts, declaredOnlyInContract };
}
