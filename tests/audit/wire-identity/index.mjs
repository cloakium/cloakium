// Wire identity: what JavaScript sees versus what the HTTP server received, in
// the page and in a dedicated worker. High-entropy client hints are exercised by
// an explicit opt-in response (Accept-CH on the dedicated /identity document),
// then verified from the server receipt rather than assumed.

import {
  IDENTITY_ACCEPT_CH,
  IDENTITY_ACCEPT_CH_VALUE,
  IDENTITY_HIGH_ENTROPY_HEADERS,
} from '../network/lab/origin.mjs';

export { IDENTITY_ACCEPT_CH, IDENTITY_ACCEPT_CH_VALUE, IDENTITY_HIGH_ENTROPY_HEADERS };

function unquote(value) {
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

/** Token-set comparison for an Accept-CH header value. */
export function acceptCHMatches(headerValue, policy = IDENTITY_ACCEPT_CH) {
  if (typeof headerValue !== 'string') return null;
  const actual = new Set(headerValue.split(',').map((token) => token.trim().toLowerCase()).filter(Boolean));
  const expected = new Set(policy.map((token) => token.toLowerCase()));
  if (actual.size !== expected.size) return false;
  for (const token of expected) if (!actual.has(token)) return false;
  return true;
}

export function identityChecks(sample, headers, prefix) {
  const checks = [
    { name: `${prefix}/user-agent-reaches-server`, passed: headers['user-agent'] === sample.userAgent },
    { name: `${prefix}/primary-language-reaches-server`, passed:
      typeof headers['accept-language'] === 'string' &&
      headers['accept-language'].split(',')[0].split(';')[0].toLowerCase() === sample.language.toLowerCase() },
  ];
  // Low-entropy platform brand comes from userAgentData.platform; the high-entropy
  // fields come from getHighEntropyValues(). A missing source value is unknown.
  for (const [header, property, read] of [
    ['sec-ch-ua-platform', 'platform', (value) => value.uaPlatform],
    ['sec-ch-ua-platform-version', 'platformVersion', (value) => value.highEntropy?.platformVersion],
    ['sec-ch-ua-arch', 'architecture', (value) => value.highEntropy?.architecture],
    ['sec-ch-ua-bitness', 'bitness', (value) => value.highEntropy?.bitness],
  ]) {
    const actual = unquote(headers[header]);
    const expected = read(sample);
    checks.push({
      name: `${prefix}/${property}-reaches-server`,
      passed: actual === null || expected === undefined || expected === null ? null : actual === expected,
      detail: { server: actual, javascript: expected ?? null },
    });
  }
  return checks;
}

/** How many requested high-entropy header values arrived (0 = not sent). */
export function highEntropyCount(headers) {
  return IDENTITY_HIGH_ENTROPY_HEADERS.filter((name) => typeof headers?.[name] === 'string' && headers[name].length > 0).length;
}

const FULL_VERSION_HEADER = 'sec-ch-ua-full-version-list';
const FVL_MAX_LENGTH = 4096;
const FVL_MAX_MEMBERS = 64;

/** Split a structured-field list on commas that are outside quoted strings. */
function splitHeaderMembers(value) {
  const members = [];
  let current = '';
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) { current += character; escaped = false; continue; }
    if (quoted && character === '\\') { current += character; escaped = true; continue; }
    if (character === '"') { quoted = !quoted; current += character; continue; }
    if (character === ',' && !quoted) { members.push(current); current = ''; continue; }
    current += character;
  }
  if (quoted) return null;
  members.push(current);
  return members;
}

/** Parse one RFC 8941 quoted string; returns { value, rest } or null. */
function parseQuotedString(input) {
  if (input[0] !== '"') return null;
  let value = '';
  for (let index = 1; index < input.length; index += 1) {
    const character = input[index];
    if (character === '\\') {
      const next = input[index + 1];
      if (next === undefined) return null;
      value += next;
      index += 1;
      continue;
    }
    if (character === '"') return { value, rest: input.slice(index + 1) };
    value += character;
  }
  return null;
}

/**
 * Parse Sec-CH-UA-Full-Version-List: quoted brand plus ;v="version" parameters.
 * The parser never splits inside quotes and returns a reason instead of guessing.
 */
export function parseFullVersionList(headerValue) {
  if (typeof headerValue !== 'string') return { ok: false, state: 'unavailable', reason: 'header-absent' };
  if (headerValue.length === 0) return { ok: false, state: 'parse-error', reason: 'empty-header' };
  if (headerValue.length > FVL_MAX_LENGTH) return { ok: false, state: 'parse-error', reason: 'bounded' };
  const members = splitHeaderMembers(headerValue);
  if (!members || members.length > FVL_MAX_MEMBERS) return { ok: false, state: 'parse-error', reason: 'bounded-or-unbalanced' };
  const list = [];
  for (const rawMember of members) {
    let rest = rawMember.trim();
    if (!rest) return { ok: false, state: 'parse-error', reason: 'empty-member' };
    const brand = parseQuotedString(rest);
    if (!brand) return { ok: false, state: 'parse-error', reason: 'unquoted-brand' };
    rest = brand.rest.trim();
    let version = null;
    while (rest.length) {
      if (rest[0] !== ';') return { ok: false, state: 'parse-error', reason: 'bad-parameter' };
      rest = rest.slice(1).trim();
      const separator = rest.indexOf('=');
      if (separator <= 0) return { ok: false, state: 'parse-error', reason: 'bad-parameter' };
      const key = rest.slice(0, separator).trim().toLowerCase();
      const parsed = parseQuotedString(rest.slice(separator + 1).trim());
      if (!parsed) return { ok: false, state: 'parse-error', reason: 'bad-parameter-value' };
      if (key === 'v') version = parsed.value;
      rest = parsed.rest.trim();
    }
    if (version === null) return { ok: false, state: 'parse-error', reason: 'missing-version' };
    list.push({ brand: brand.value, version });
  }
  return { ok: true, state: 'parsed', list };
}

/** Order-insensitive, duplicate-sensitive brand/version comparison. */
export function fullVersionListMatches(jsList, headerValue) {
  const parsed = parseFullVersionList(headerValue);
  if (!parsed.ok) return { state: parsed.state, reason: parsed.reason };
  if (!Array.isArray(jsList)) return { state: 'unavailable', reason: 'javascript-list-absent' };
  const normalize = (entries) => entries
    .map((entry) => ({ brand: String(entry?.brand ?? ''), version: String(entry?.version ?? '') }))
    .sort((left, right) => (left.brand === right.brand ? left.version.localeCompare(right.version) : left.brand.localeCompare(right.brand)));
  const actual = normalize(jsList);
  const advertised = normalize(parsed.list);
  const match = actual.length === advertised.length
    && actual.every((entry, index) => entry.brand === advertised[index].brand && entry.version === advertised[index].version);
  return {
    state: match ? 'match' : 'mismatch',
    javascript: actual.length,
    header: advertised.length
  };
}

const SAMPLE = async () => ({
  userAgent: navigator.userAgent,
  platform: navigator.platform,
  // Low-entropy brand token, the value Sec-CH-UA-Platform mirrors.
  uaPlatform: navigator.userAgentData?.platform ?? null,
  language: navigator.language,
  languages: navigator.languages,
  highEntropy: navigator.userAgentData
    ? await navigator.userAgentData.getHighEntropyValues(['platformVersion', 'architecture', 'bitness', 'fullVersionList'])
    : null,
});

export const probes = [{
  id: 'wire-main-worker-identity',
  family: 'Server-observed HTTP identity coherence',
  timeoutMs: 30000,
  async run({ page, origin, config }) {
    // 1. Complete HTTP navigation to the opt-in document: the response carries the
    //    Accept-CH policy for this origin only.
    await page.goto(`${origin}/identity`, { waitUntil: 'domcontentloaded', timeout: 10_000 });

    // 2. Same-origin fetches, retried as needed: each round trip is the opt-in
    //    propagation trigger, never a blind sleep.
    const attempts = [];
    let receipt = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const observed = await page.evaluate(async (endpoint) => {
        const response = await fetch(endpoint, { cache: 'no-store' });
        return { acceptCH: response.headers.get('accept-ch'), body: await response.json() };
      }, `${origin}/headers`);
      const count = highEntropyCount(observed.body.headers);
      attempts.push({ attempt, acceptCH: observed.acceptCH, highEntropyHeaders: count });
      receipt = observed;
      if (count > 0) break;
    }

    const mainSample = await page.evaluate(SAMPLE);
    const mainCount = highEntropyCount(receipt.body.headers);
    const mainFullVersion = fullVersionListMatches(
      mainSample.highEntropy?.fullVersionList,
      receipt.body.headers[FULL_VERSION_HEADER]
    );
    const checks = [
      {
        name: 'main/accept-ch-advertised',
        passed: acceptCHMatches(receipt.acceptCH) === true,
        detail: { server: receipt.acceptCH ?? null, expected: IDENTITY_ACCEPT_CH },
      },
      mainCount > 0
        ? { name: 'main/high-entropy-hints-sent', passed: true, detail: { received: mainCount } }
        : {
          name: 'main/high-entropy-hints-sent',
          passed: null,
          detail: 'main realm did not send the requested high-entropy hints after opt-in; realm-specific unavailability, not an absence claim',
        },
      {
        name: 'main/full-version-list-matches',
        passed: mainFullVersion.state === 'match' ? true : mainFullVersion.state === 'mismatch' ? false : null,
        detail: mainFullVersion,
      },
      ...identityChecks(mainSample, receipt.body.headers, 'main'),
    ];

    const limitations = [
      'High-entropy client hints are exercised only after the explicit Accept-CH opt-in on /identity; absence elsewhere is not evidence.',
      'Accept-Language comes from the browser context locale (common metadata option), not from a client hint.',
    ];
    if (mainCount === 0) limitations.push('main-realm-no-client-hints: the main navigation/fetch realm sent no high-entropy hints after opt-in.');

    // 3. Worker realm: the blob inherits this secure loopback origin, so it may
    //    carry the same opt-in when the engine implements hints in workers.
    const worker = await page.evaluate(async ({ endpoint, sampleSource }) => {
      const script = `onmessage=async event=>{try{
        const sample=await(${sampleSource})();
        const response=await fetch(event.data,{cache:'no-store'});
        postMessage({javascript:sample,acceptCH:response.headers.get('accept-ch'),server:await response.json()});
      }catch(error){postMessage({error:error.name})}}`;
      const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
      const instance = new Worker(url);
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('worker identity deadline')), 8000);
          instance.onmessage = (event) => resolve(event.data);
          instance.onerror = () => reject(new Error('worker identity failed'));
          instance.postMessage(endpoint);
        });
      } finally {
        clearTimeout(timer);
        instance.terminate();
        URL.revokeObjectURL(url);
      }
    }, { endpoint: `${origin}/headers`, sampleSource: SAMPLE.toString() }).catch((error) => ({ error: error.name }));

    if (worker.error) {
      checks.push({ name: 'worker/server-identity-observed', passed: null });
      checks.push({ name: 'worker/high-entropy-hints-sent', passed: null });
      limitations.push(`worker-realm-unavailable: ${worker.error}`);
    } else {
      const workerCount = highEntropyCount(worker.server.headers);
      checks.push({
        name: 'worker/accept-ch-advertised',
        passed: acceptCHMatches(worker.acceptCH) === true,
        detail: { server: worker.acceptCH ?? null },
      });
      checks.push(workerCount > 0
        ? { name: 'worker/high-entropy-hints-sent', passed: true, detail: { received: workerCount } }
        : {
          name: 'worker/high-entropy-hints-sent',
          passed: null,
          detail: 'worker realm sent no high-entropy hints after opt-in; realm-specific unavailability, not an absence claim',
        });
      const workerFullVersion = fullVersionListMatches(
        worker.javascript.highEntropy?.fullVersionList,
        worker.server.headers[FULL_VERSION_HEADER]
      );
      checks.push({
        name: 'worker/full-version-list-matches',
        passed: workerFullVersion.state === 'match' ? true : workerFullVersion.state === 'mismatch' ? false : null,
        detail: workerFullVersion,
      });
      checks.push(...identityChecks(worker.javascript, worker.server.headers, 'worker'));
      for (const field of ['userAgent', 'platform', 'language', 'languages', 'highEntropy']) {
        const mainValue = mainSample[field];
        const workerValue = worker.javascript[field];
        const missing = mainValue === null || mainValue === undefined || workerValue === null || workerValue === undefined;
        checks.push({
          name: `main-worker/${field}-coherent`,
          passed: missing ? null : JSON.stringify(mainValue) === JSON.stringify(workerValue),
          detail: { main: mainValue ?? null, worker: workerValue ?? null },
        });
      }
      if (workerCount === 0) limitations.push('worker-realm-no-client-hints: the worker fetch sent no high-entropy hints after opt-in.');
      limitations.push('Worker client hints are an engine capability: an unsent worker hint is recorded as realm-specific unknown, never as coherence or absence.');
    }

    if (checks.some((check) => check.passed === null)) {
      limitations.push('Some requested client hints were not exposed in this realm; absence is not a passing coherence check.');
    }

    return {
      observations: {
        source: 'HTTP server receipt, not CDP request metadata',
        policy: { advertised: receipt.acceptCH ?? null, requested: IDENTITY_ACCEPT_CH },
        attempts,
        main: { javascript: mainSample, highEntropyHeaders: mainCount, fullVersionList: mainFullVersion },
        worker: worker.error
          ? { error: worker.error }
          : { javascript: worker.javascript, acceptCH: worker.acceptCH, highEntropyHeaders: highEntropyCount(worker.server.headers), fullVersionList: fullVersionListMatches(worker.javascript.highEntropy?.fullVersionList, worker.server.headers[FULL_VERSION_HEADER]) },
        languageSource: { contextLocale: config?.contextOptions?.locale ?? null, javascript: mainSample.language, acceptLanguage: receipt.body.headers['accept-language'] ?? null },
      },
      checks,
      limitations,
    };
  },
}];
