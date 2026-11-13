#!/usr/bin/env node
// Native regression smoke tests for cloakium's patched Chromium.
//
// Requires a real patched browser:
//   CLOAKIUM_BINARY_PATH=$(nix build path:.#chromium --print-out-paths)/bin/cloakium-chromium
//   PLAYWRIGHT_CORE_PATH=/path/to/node_modules/playwright-core  (optional)
//   node tests/native/smoke.mjs
//
// The fixture is a local HTTP server only; no external network is used.

import { createRequire } from 'node:module';
import { startFixture } from './fixture-server.mjs';

const require = createRequire(import.meta.url);
const binary = process.env.CLOAKIUM_BINARY_PATH;
if (!binary) {
  console.error('CLOAKIUM_BINARY_PATH is required');
  process.exit(2);
}
const playwright = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
const { chromium } = playwright;

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures.push(`${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  console.log(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
}

function parseBrands(header) {
  const brands = [];
  if (!header) return brands;
  const pattern = /"([^"]+)";v="([^"]+)"/g;
  for (const match of header.matchAll(pattern)) {
    brands.push({ brand: match[1], version: match[2] });
  }
  return brands.sort((a, b) => a.brand.localeCompare(b.brand));
}

async function probe(fixture, host, args) {
  const browser = await chromium.launch({
    executablePath: binary,
    headless: true,
    args,
  });
  try {
    const page = await browser.newPage();
    await page.goto(fixture.urlFor(host), { waitUntil: 'load' });
    return await page.evaluate(() => window.__cloakium.run());
  } finally {
    await browser.close();
  }
}

const fixture = await startFixture();
try {
  const baseline = await probe(fixture, '127.0.0.1', []);

  // Baseline: automation is observable before the fingerprint switch is used.
  check('baseline webdriver is true', baseline.webdriver === true, baseline.webdriver);
  check('baseline UA has headless token', /Headless/.test(baseline.ua), baseline.ua);
  check(
    'baseline HTTP UA matches JS UA',
    baseline.headers['user-agent'] === baseline.ua,
    { http: baseline.headers['user-agent'], js: baseline.ua },
  );
  check('baseline userAgentData present', baseline.uad !== null, baseline.uad);
  check('baseline uad platform is Linux', baseline.uad?.platform === 'Linux', baseline.uad);
  check('baseline hardwareConcurrency > 0', baseline.hardwareConcurrency > 0, baseline.hardwareConcurrency);

  const seedA = 'a1b2c3d4e5f6';
  const seedB = '0f1e2d3c4b5a';
  const fpArgs = [`--fingerprint=${seedA}`];

  const first = await probe(fixture, '127.0.0.1', fpArgs);
  const second = await probe(fixture, '127.0.0.1', fpArgs);

  check('fingerprint webdriver is false', first.webdriver === false, first.webdriver);
  check('fingerprint UA has no headless token', !/Headless/.test(first.ua), first.ua);
  check(
    'fingerprint HTTP UA matches JS UA',
    first.headers['user-agent'] === first.ua,
    { http: first.headers['user-agent'], js: first.ua },
  );
  check(
    'fingerprint HTTP UA has no headless token',
    !/Headless/.test(first.headers['user-agent'] || ''),
    first.headers['user-agent'],
  );
  check(
    'Sec-CH-UA-Platform is Linux',
    first.headers['sec-ch-ua-platform'] === '"Linux"',
    first.headers['sec-ch-ua-platform'],
  );
  check(
    'HTTP brand list matches JS brand list',
    JSON.stringify(parseBrands(first.headers['sec-ch-ua'])) === JSON.stringify(first.uad?.brands || []),
    { http: parseBrands(first.headers['sec-ch-ua']), js: first.uad?.brands },
  );
  const chromiumBrand = first.uad?.brands?.find((brand) => brand.brand === 'Chromium');
  // Chromium's reduced UA product is `Chrome/<major>` for web compatibility;
  // the client-hint brand remains `Chromium`. The version must agree.
  check('UA product version matches Chromium client hint', !!chromiumBrand && first.ua.includes(`Chrome/${chromiumBrand.version}`), {
    ua: first.ua,
    brand: chromiumBrand,
  });

  check('fingerprint defaults keep host hardwareConcurrency', first.hardwareConcurrency === baseline.hardwareConcurrency, {
    baseline: baseline.hardwareConcurrency,
    fingerprint: first.hardwareConcurrency,
  });
  check('fingerprint defaults keep host deviceMemory', first.deviceMemory === baseline.deviceMemory, {
    baseline: baseline.deviceMemory,
    fingerprint: first.deviceMemory,
  });

  check('canvas dataURL is stable', first.canvas.dataURLStable === true, first.canvas);
  check('canvas getImageData is stable', first.canvas.imageDataStable === true, first.canvas);
  check(
    'two identically drawn canvases agree',
    first.canvas.dataURLHash === first.canvas.secondCanvasDataURLHash,
    first.canvas,
  );
  check('audio reads are stable', first.audio.stable === true, first.audio);
  check('two audio renders agree', first.audio.sameAcrossRenders === true, first.audio);

  check('same seed reproduces canvas', first.canvas.dataURLHash === second.canvas.dataURLHash, {
    first: first.canvas.dataURLHash,
    second: second.canvas.dataURLHash,
  });
  check('same seed reproduces audio', first.audio.hash === second.audio.hash, {
    first: first.audio.hash,
    second: second.audio.hash,
  });

  const otherSeed = await probe(fixture, '127.0.0.1', [`--fingerprint=${seedB}`]);
  check('different seed changes canvas', otherSeed.canvas.dataURLHash !== first.canvas.dataURLHash, {
    a: first.canvas.dataURLHash,
    b: otherSeed.canvas.dataURLHash,
  });
  check('different seed changes audio', otherSeed.audio.hash !== first.audio.hash, {
    a: first.audio.hash,
    b: otherSeed.audio.hash,
  });

  const overridden = await probe(fixture, '127.0.0.1', [
    `--fingerprint=${seedA}`,
    '--fingerprint-hardware-concurrency=6',
    '--fingerprint-device-memory=8',
  ]);
  check('hardwareConcurrency override propagates', overridden.hardwareConcurrency === 6, overridden.hardwareConcurrency);
  check('deviceMemory override propagates', overridden.deviceMemory === 8, overridden.deviceMemory);

  const profiled = await probe(fixture, '127.0.0.1', [
    `--fingerprint=${seedA}`,
    '--fingerprint-webgl-profile=mesa-intel-uhd630',
  ]);
  check('webgl unmasked vendor profile', profiled.webgl?.unmaskedVendor === 'Intel', profiled.webgl);
  check(
    'webgl unmasked renderer profile',
    profiled.webgl?.unmaskedRenderer === 'Mesa Intel(R) UHD Graphics 630 (CFL GT2)',
    profiled.webgl,
  );

  const otherOrigin = await probe(fixture, 'localhost', fpArgs);
  check('origin scoping separates 127.0.0.1 and localhost', otherOrigin.canvas.dataURLHash !== first.canvas.dataURLHash, {
    loopback: first.canvas.dataURLHash,
    localhost: otherOrigin.canvas.dataURLHash,
  });
} finally {
  await fixture.close();
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log('\nall native smoke checks passed');
