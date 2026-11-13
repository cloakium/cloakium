/**
 * Minimal test harness. The suites are plain ESM so the same files run under
 * `node` and `bun` without a framework dependency.
 */

const registry = [];

export function test(name, fn) {
  registry.push({ name, fn });
}

export function skip(name, reason) {
  registry.push({ name, reason, skip: true });
}

export async function run({ label = "tests" } = {}) {
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const entry of registry) {
    if (entry.skip) {
      skipped += 1;
      console.log(`SKIP ${entry.name}${entry.reason ? ` (${entry.reason})` : ""}`);
      continue;
    }
    const started = Date.now();
    try {
      await entry.fn();
      passed += 1;
      console.log(`ok   ${entry.name} (${Date.now() - started}ms)`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${entry.name}`);
      console.error(error?.stack ?? String(error));
    }
  }

  console.log(`\n${label}: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  return { passed, failed, skipped };
}

export function testCount() {
  return registry.length;
}
