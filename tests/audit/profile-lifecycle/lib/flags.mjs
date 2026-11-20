// Launch-argument safety: never weakens the sandbox, never accepts
// credential-like arguments. Redaction of values is the parent's structured job.

import { redactText } from '../../lib/secure-io.mjs';
import { assertSandboxArguments } from '../../lib/browser.mjs';

const UNSAFE = /(?:--no-sandbox|--disable-setuid-sandbox|--disable-web-security|--disable-site-isolation|--disable-features=IsolateOrigins)/i;
const SECRETISH = /\b(?:license|licence|password|passwd|token|apikey|api_key|secret|bearer)\b/i;
const BEARER = /\bBearer\s+\S+/i;
const URL_USERINFO = /(https?|socks5h?):\/\/[^/\s:@]+:[^/\s@]+@/;

export function redactArgument(argument) {
  return redactText(String(argument));
}

export function redactArguments(args) {
  return args.map(redactArgument);
}

export function assertSafeArguments(args) {
  for (const argument of args) {
    if (typeof argument !== 'string' || !argument.startsWith('--')) {
      throw new Error(`invalid launch argument: ${redactArgument(argument)}`);
    }
    if (UNSAFE.test(argument)) throw new Error(`sandbox-weakening argument rejected: ${argument}`);
    if (SECRETISH.test(argument) && !/^--fingerprint-search-engine=/.test(argument)) {
      throw new Error(`credential-like argument rejected: ${redactArgument(argument)}`);
    }
    if (BEARER.test(argument) || URL_USERINFO.test(argument)) {
      throw new Error('credential-like argument rejected');
    }
  }
  assertSandboxArguments(args);
  return args;
}

export function flagName(argument) {
  return String(argument).split('=')[0];
}

export function hasFlag(args, name) {
  return args.some((argument) => flagName(argument) === name);
}

export function withoutFlag(args, name) {
  return args.filter((argument) => flagName(argument) !== name);
}

// The subset of `expected` flag names present in a browser command line.
export function flagsPresent(expected, commandLine) {
  return expected.map((argument) => flagName(argument)).filter((name) => commandLine.includes(name));
}
