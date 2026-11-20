// Contract tests: scenario shape, declared-check drift, fixture validity, report
// secrecy/atomicity and lifecycle lockout. Nothing here launches a browser.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classify, runScenarios, scenarioIds, scenarios } from '../index.mjs';
import { ownedRoot } from '../lib/profile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE = path.resolve(HERE, '..');
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CHECK = /^[a-z0-9]+(-[a-z0-9]+)*\/[a-z0-9]+(-[a-z0-9]+)*$/;

async function scenarioSources() {
  const files = (await fs.readdir(path.join(SUITE, 'scenarios'))).filter((file) => file.endsWith('.mjs'));
  const rows = [];
  for (const file of files.sort()) {
    const source = await fs.readFile(path.join(SUITE, 'scenarios', file), 'utf8');
    rows.push({ file, source });
  }
  return rows;
}

async function allSources(directory, { skip = [] } = {}) {
  const rows = [];
  for (const entry of await fs.readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    if (skip.some((part) => file.includes(part))) continue;
    rows.push({ file, source: await fs.readFile(file, 'utf8') });
  }
  return rows;
}

test('all nine scenarios are declared', () => {
  assert.deepEqual(scenarioIds, [
    'launch-contract', 'profile-persistence', 'profile-isolation', 'storage-state',
    'portable-cookies', 'profile-metadata', 'seed-persistence', 'extension-mv3', 'search-engine'
  ]);
});

test('scenario ids and timeouts are well-formed', () => {
  assert.equal(new Set(scenarioIds).size, scenarioIds.length);
  for (const scenario of scenarios) {
    assert.match(scenario.id, SLUG);
    assert.equal(typeof scenario.run, 'function');
    assert.ok(Number.isInteger(scenario.timeoutMs) && scenario.timeoutMs > 0, `${scenario.id} timeoutMs`);
    assert.ok(scenario.timeoutMs <= 180_000, `${scenario.id} timeoutMs must be <= 180000`);
    assert.ok(Array.isArray(scenario.checks) && scenario.checks.length > 0, `${scenario.id} checks`);
    assert.equal(new Set(scenario.checks).size, scenario.checks.length, `${scenario.id} duplicate checks`);
    for (const name of scenario.checks) assert.match(name, CHECK, `${scenario.id}: ${name}`);
    if ('optional' in scenario) assert.equal(typeof scenario.optional, 'boolean');
  }
});

test('declared checks match the checks each scenario can emit', async () => {
  const sources = await scenarioSources();
  const combined = sources.map((row) => row.source).join('\n');
  for (const scenario of scenarios) {
    const row = sources.find((entry) => entry.source.includes(`id: '${scenario.id}'`));
    assert.ok(row, `${scenario.id} must be declared in one scenario file`);
    const counts = new Map();
    for (const match of row.source.matchAll(/rec\.(expect|unknown)\(\s*'([^']+)'/g)) {
      const key = `${match[1]}:${match[2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const emitted = new Set([...counts.keys()].map((key) => key.slice(key.indexOf(':') + 1)));
    for (const name of emitted) {
      assert.ok(scenario.checks.includes(name), `${scenario.id}: emitted but undeclared ${name}`);
    }
    for (const name of scenario.checks) {
      assert.ok(row.source.split(`'${name}'`).length - 1 >= 2, `${scenario.id}: declared but never recorded ${name}`);
    }
    for (const [key, count] of counts) {
      assert.ok(count === 1, `${scenario.id}: duplicate verdict ${key}`);
    }
  }
  assert.ok(combined.includes('sandbox'), 'sanity: scenario sources were read');
});

test('extension fixture is a valid, local, permission-free MV3 extension', async () => {
  const directory = path.join(SUITE, 'extension');
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.deepEqual(manifest.permissions, []);
  assert.ok(manifest.content_scripts[0].matches.includes('http://127.0.0.1/*'));
  for (const file of ['background.js', 'content.js']) {
    const source = await fs.readFile(path.join(directory, file), 'utf8');
    assert.ok(!/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(source), `${file} must not reference a remote origin`);
  }
});

test('sources stay local, deterministic and free of key material', async () => {
  const rows = await allSources(SUITE, { skip: ['/tests/', '/node_modules/'] });
  for (const { file, source } of rows) {
    const relative = file.slice(SUITE.length + 1);
    assert.ok(!/Math\.random/.test(source), `${relative}: no randomness`);
    assert.ok(!/createDecipheriv?|subtle\.(?:encrypt|decrypt)|\.decrypt\(/.test(source), `${relative}: no decryption`);
    assert.ok(!/\bcb_[A-Za-z0-9_-]+/.test(source), `${relative}: no credential-like literals`);
    const remote = [...source.matchAll(/https?:\/\/([^/\s"']+)/g)]
      .map((match) => match[1])
      .filter((host) => !/^(?:127\.0\.0\.1|localhost)(?::|$)/.test(host));
    assert.deepEqual(remote, [], `${relative}: remote origins are not allowed`);
  }
  const server = await fs.readFile(path.join(SUITE, 'lib/server.mjs'), 'utf8');
  assert.ok(server.includes("listen(0, '127.0.0.1'"), 'fixture server must bind loopback port 0');
  for (const { file, source } of rows) {
    if (file.endsWith('lib/lab.mjs')) continue;
    assert.ok(!source.includes('launchPersistentContext('), `${file}: only the lab may launch a persistent context`);
  }
});

test('the report path uses parent secure-io and no private or raw error text', async () => {
  const index = await fs.readFile(path.join(SUITE, 'index.mjs'), 'utf8');
  assert.match(index, /from '\.\.\/lib\/secure-io\.mjs'/, 'reports must use the parent secure IO helpers');
  assert.match(index, /atomicJson\(/, 'artifacts must be written atomically');
  assert.match(index, /safeError\(/, 'errors must be categorised');
  assert.ok(!/error\.stack/.test(index), 'raw stacks must never be recorded');
  assert.ok(!/_browser\b|_process\b/.test(index), 'no private Playwright handles');
});

test('classify uses the parent summarizer, not passed:false implies failure', () => {
  const pass = { observations: {}, checks: [{ name: 'a/b', passed: true }], limitations: [] };
  assert.equal(classify(pass), 'observed');
  assert.equal(
    classify({ observations: {}, checks: [{ name: 'a/b', passed: null }], limitations: [] }),
    'observed-with-limitations'
  );
  assert.equal(
    classify({ observations: {}, checks: [{ name: 'a/b', passed: true }], limitations: [{ code: 'gap' }] }),
    'observed-with-limitations'
  );
  assert.equal(
    classify({ observations: {}, checks: [{ name: 'a/b', passed: false }], limitations: [] }),
    'observed-inconsistency'
  );
  for (const status of ['stage-needed', 'unavailable', 'unsupported-by-target', 'inconclusive']) {
    assert.equal(
      classify({ observations: {}, checks: [{ name: 'a/b', passed: false, status }], limitations: [] }),
      'observed-with-limitations',
      `${status} must classify as unknown, not as an inconsistency`
    );
  }
  assert.equal(classify({ observations: {}, checks: [], limitations: [] }), 'observed-with-limitations');
  assert.throws(() => classify({ checks: [], limitations: [] }), /observations/);
  assert.throws(
    () => classify({ observations: {}, checks: [{ name: 'a/b', passed: 'yes' }], limitations: [] }),
    /boolean\/null/
  );
});

test('runScenarios rejects bad options before any launch', async () => {
  const chromium = { launchPersistentContext: async () => { throw new Error('must not launch'); } };
  const base = { chromium, executablePath: '/bin/true', headless: true, baseArgs: [], baseEnv: {} };
  const never = path.join(ownedRoot(), 'profile-lifecycle-tests-never');
  await assert.rejects(runScenarios({ ...base }), /output is required/);
  await assert.rejects(runScenarios({ ...base, output: 'relative/out' }), /output must be absolute/);
  await assert.rejects(
    runScenarios({ ...base, output: never, executablePath: 'relative' }),
    /executablePath must be absolute/
  );
  await assert.rejects(runScenarios({ ...base, output: never, baseArgs: ['--no-sandbox'] }), /sandbox-weakening/);
  await assert.rejects(
    runScenarios({ ...base, output: never, scenarios: ['does-not-exist'] }),
    /unknown scenario/
  );
  const { baseEnv: _omitted, ...withoutEnv } = base;
  await assert.rejects(runScenarios({ ...withoutEnv, output: never }), /baseEnv must be supplied explicitly/);
  await assert.rejects(runScenarios({ ...base, baseEnv: [], output: never }), /baseEnv must be supplied/);
  assert.equal(await fs.stat(never).catch(() => null), null);
});

function fakePersistentPage() {
  return {
    goto: async () => ({ status: () => 200 }),
    locator: () => ({ innerText: async () => 'Chromium 1.0 --fingerprint=1' }),
    evaluate: async () => null,
    close: async () => {}
  };
}

function fakePersistentChromium({ failClose = false, failLaunch = null } = {}) {
  const calls = [];
  return {
    calls,
    async launchPersistentContext(directory, options) {
      calls.push({ directory, options });
      if (failLaunch) throw failLaunch;
      const page = fakePersistentPage();
      return {
        pages: () => [page],
        newPage: async () => page,
        close: async () => {
          if (failClose) throw new Error('fixture close failure: target-origin-secret');
        },
        browser: () => ({ version: () => 'fake-1.0' })
      };
    }
  };
}

async function scratch(label) {
  const directory = path.join(ownedRoot(), `profile-lifecycle-${label}-${process.pid}`);
  await fs.rm(directory, { recursive: true, force: true });
  return directory;
}

test('launch-contract reports environment keys but never environment values', async () => {
  const chromium = fakePersistentChromium();
  const output = await scratch('env');
  const homeValue = '/tmp/cloakium-home-do-not-log';
  try {
    const report = await runScenarios({
      chromium,
      executablePath: '/bin/true',
      headless: true,
      baseArgs: ['--fingerprint=1'],
      baseEnv: { HOME: homeValue, PATH: '/usr/bin', DISPLAY: ':99', XAUTHORITY: '/tmp/xauth' },
      contextOptions: { locale: 'en-US', timezoneId: 'UTC' },
      output,
      scenarios: ['launch-contract']
    });
    assert.equal(chromium.calls.length, 1);
    assert.equal(chromium.calls[0].options.env.DISPLAY, undefined, 'headless must drop DISPLAY');
    assert.equal(chromium.calls[0].options.env.XAUTHORITY, undefined);
    assert.ok(report.engine.envKeys.includes('HOME'));
    assert.deepEqual(report.engine.displayKeys, []);
    const persisted = await fs.readFile(path.join(output, 'report.json'), 'utf8');
    assert.ok(!persisted.includes(homeValue), 'environment values must not reach the report');
    assert.ok(!persisted.includes('/tmp/xauth'));
    assert.equal(report.scenarios.length, 1);
    assert.equal(report.cleanup.contextsOpened, 1);
    assert.equal(report.cleanup.contextsClosed, 1);
    assert.equal(report.cleanup.activeProfiles, 0);
    assert.equal(report.cleanup.processVerification, 'not-exposed-by-public-persistent-context-api');
    assert.deepEqual(report.browserVersions, ['fake-1.0']);
    assert.equal(report.launches.length, 1);
    assert.equal(report.launches[0].version, 'fake-1.0');
    assert.deepEqual(report.launches[0].ignoreDefaultArgs, [
      '--enable-automation', '--enable-unsafe-swiftshader', '--no-sandbox'
    ]);
    assert.equal(report.launches[0].contextOptions.locale, 'en-US');
    assert.equal(report.launches[0].contextOptions.timezoneId, 'UTC');
    assert.equal(report.engine.contextOptions.locale, 'en-US');
    assert.ok(report.cleanup.limitations.some((line) => /BrowserServer/.test(line)));
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});

test('a headed run without an owned display fails before the browser starts', async () => {
  const chromium = fakePersistentChromium();
  const output = await scratch('headed');
  try {
    const report = await runScenarios({
      chromium,
      executablePath: '/bin/true',
      headless: false,
      baseArgs: [],
      baseEnv: { HOME: '/tmp/cloakium-home', PATH: '/usr/bin' },
      output,
      scenarios: ['launch-contract']
    });
    assert.equal(chromium.calls.length, 0, 'no browser launch may happen without a display');
    assert.equal(report.scenarios[0].status, 'execution-error');
    assert.equal(report.scenarios[0].error.category, 'operation-failed');
    assert.match(report.scenarios[0].error.detail, /omitted/);
    assert.equal(report.status, 'failed');
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});

test('a raw target error is never persisted', async () => {
  const chromium = fakePersistentChromium({
    failLaunch: new Error('license key: target-origin-secret-value')
  });
  const output = await scratch('secrecy');
  try {
    const report = await runScenarios({
      chromium,
      executablePath: '/bin/true',
      headless: true,
      baseArgs: [],
      baseEnv: {},
      output,
      scenarios: ['launch-contract']
    });
    assert.equal(report.status, 'failed');
    const persisted = await fs.readFile(path.join(output, 'report.json'), 'utf8');
    const scenarioArtifact = await fs.readFile(path.join(output, 'launch-contract.json'), 'utf8');
    for (const text of [persisted, scenarioArtifact, JSON.stringify(report)]) {
      assert.ok(!text.includes('target-origin-secret-value'), 'raw error text must not be recorded');
      assert.ok(!text.includes('license key'), 'credential-shaped error text must not be recorded');
    }
    assert.equal(report.scenarios[0].error.operation, 'launch-contract run');
    assert.equal(typeof report.scenarios[0].error.category, 'string');
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});

test('output directories must be owned, 0700 and not symlinks', async () => {
  const chromium = fakePersistentChromium();
  const base = { chromium, executablePath: '/bin/true', headless: true, baseArgs: [], baseEnv: {} };
  const publicDir = await scratch('public');
  const alias = await scratch('alias');
  const asFile = await scratch('file');
  const outsideWork = await scratch('outside-work');
  try {
    await fs.mkdir(publicDir, { recursive: true, mode: 0o755 });
    await fs.chmod(publicDir, 0o755);
    await assert.rejects(
      runScenarios({ ...base, output: publicDir, scenarios: ['launch-contract'] }),
      /0700/
    );
    await fs.mkdir(path.dirname(alias), { recursive: true });
    await fs.symlink(publicDir, alias);
    await assert.rejects(
      runScenarios({ ...base, output: alias, scenarios: ['launch-contract'] }),
      /owned regular directory/
    );
    await fs.writeFile(asFile, 'not a directory\n', { mode: 0o600 });
    await assert.rejects(
      runScenarios({ ...base, output: asFile, scenarios: ['launch-contract'] }),
      /owned regular directory|EEXIST|ENOTDIR/
    );
    await assert.rejects(
      runScenarios({ ...base, output: path.join(outsideWork, 'out'), workRoot: '/tmp/not-our-root/profiles', scenarios: ['launch-contract'] }),
      /workRoot must be inside the private audit root/
    );
    assert.equal(chromium.calls.length, 0, 'no launch may happen for a refused output');

    // A nested output that does not exist yet is created privately and used.
    const nested = path.join(publicDir.replace(/public$/, 'nested'), 'deep', 'out');
    const report = await runScenarios({ ...base, output: nested, scenarios: ['launch-contract'] });
    assert.equal(report.status, 'observed');
    assert.equal((await fs.stat(nested)).mode & 0o777, 0o700);
  } finally {
    await fs.rm(publicDir, { recursive: true, force: true });
    await fs.rm(alias, { recursive: true, force: true });
    await fs.rm(asFile, { recursive: true, force: true });
    await fs.rm(path.join(publicDir.replace(/public$/, 'nested')), { recursive: true, force: true });
  }
});

test('existing artifacts refuse reuse, and a second report write is explicit', async () => {
  const chromium = fakePersistentChromium();
  const output = await scratch('reuse');
  try {
    await fs.mkdir(output, { recursive: true, mode: 0o700 });
    await fs.chmod(output, 0o700);
    await fs.writeFile(path.join(output, 'launch-contract.json'), '{}\n', { mode: 0o600 });
    await assert.rejects(
      runScenarios({ chromium, executablePath: '/bin/true', headless: true, baseArgs: [], baseEnv: {}, output, scenarios: ['launch-contract'] }),
      /refusing to reuse an existing artifact/
    );
    assert.equal(chromium.calls.length, 0);

    await fs.rm(path.join(output, 'launch-contract.json'));
    const report = await runScenarios({
      chromium, executablePath: '/bin/true', headless: true, baseArgs: [], baseEnv: {}, output,
      scenarios: ['launch-contract']
    });
    assert.equal(report.status, 'observed');
    const persisted = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
    assert.equal(persisted.status, 'observed');
    assert.equal((await fs.stat(path.join(output, 'report.json'))).mode & 0o777, 0o600);
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});

test('a failed context close locks out further launches and fails the run', async () => {
  const chromium = fakePersistentChromium({ failClose: true });
  const output = await scratch('lockout');
  try {
    const report = await runScenarios({
      chromium,
      executablePath: '/bin/true',
      headless: true,
      baseArgs: [],
      baseEnv: {},
      output,
      scenarios: ['launch-contract', 'profile-persistence']
    });
    assert.equal(chromium.calls.length, 1, 'no second launch after a close failure');
    assert.equal(report.status, 'failed');
    assert.equal(report.cleanup.failedCleanup, true);
    assert.equal(report.cleanup.activeProfiles, 0);
    assert.ok(report.scenarios[1].status === 'skipped' || report.scenarios[1].status === 'execution-error');
    const persisted = await fs.readFile(path.join(output, 'report.json'), 'utf8');
    assert.ok(!persisted.includes('target-origin-secret'), 'close failures are categorised, not echoed');
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});
