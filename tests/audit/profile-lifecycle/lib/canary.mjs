// The single dummy canary used across scenarios. Every value is a fixed literal
// owned by this lab; nothing resembles a real credential.

import { unixSeconds } from './deadline.mjs';

export const CANARY = {
  cookieName: 'lab_canary',
  cookieValue: 'lab-dummy-canary-v1',
  localKey: 'lab-canary',
  localValue: 'lab-dummy-canary-v1',
  dbName: 'lab-canary-db',
  store: 'kv',
  recordKey: 'canary',
  recordValue: 'lab-dummy-canary-v1',
  expirySeconds: 3600
};

export function pageSpec() {
  return {
    localKey: CANARY.localKey,
    localValue: CANARY.localValue,
    dbName: CANARY.dbName,
    store: CANARY.store,
    recordKey: CANARY.recordKey,
    recordValue: CANARY.recordValue
  };
}

// Expiry is always explicit: a session cookie would legitimately vanish when the
// profile closes, which would confound the persistence checks.
export function cookieFor(origin) {
  return {
    name: CANARY.cookieName,
    value: CANARY.cookieValue,
    domain: new URL(origin).hostname,
    path: '/',
    expires: unixSeconds() + CANARY.expirySeconds,
    httpOnly: false,
    secure: false,
    sameSite: 'Lax'
  };
}

export function canaryMatches(cookie) {
  return Boolean(cookie) && cookie.value === CANARY.cookieValue;
}
