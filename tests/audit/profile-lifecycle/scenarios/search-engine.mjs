// Optional: --fingerprint-search-engine=none.
//
// Records whether the flag reaches the engine and what the fresh profile's
// Preferences metadata says about a default search provider. No baseline is
// assumed, no network query is made, and no provider string is copied; only key
// paths and their types are reported.

import { recorder, finish } from '../lib/recorder.mjs';
import { inspectProfile } from '../lib/profile.mjs';
import { readChromeVersion } from '../lib/page.mjs';
import { settle } from '../lib/deadline.mjs';
import { hasFlag } from '../lib/flags.mjs';

export const SEARCH_FLAG = '--fingerprint-search-engine=none';
const SEARCH_KEY = '--fingerprint-search-engine';

export const scenario = {
  id: 'search-engine',
  optional: true,
  timeoutMs: 45_000,
  checks: ['search/flag-applied', 'search/preferences-readable'],

  async run({ lab, server, baseArgs, log }) {
    const rec = recorder();
    const alreadySet = hasFlag(baseArgs, SEARCH_KEY);
    const directory = await lab.createProfile('search-engine');
    const opened = await lab.open({
      label: 'search-engine',
      directory,
      args: alreadySet ? [] : [SEARCH_FLAG]
    });
    let commandLine = '';
    try {
      await opened.page.goto(server.origin, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      const version = await settle(readChromeVersion(opened.page), 8000, 'chrome://version');
      if (version.ok) commandLine = version.value;
      else rec.limit('version-page-unavailable', version.error);
    } finally {
      await lab.close();
    }

    rec.expect(
      'search/flag-applied',
      alreadySet || commandLine.includes(SEARCH_KEY),
      { alreadySet, inCommandLine: commandLine.includes(SEARCH_KEY) }
    );

    const profile = await inspectProfile(directory);
    if (!profile.preferences.present || !profile.preferences.parses) {
      rec.unknown('search/preferences-readable', 'Preferences absent or unparsable');
      rec.limit('preferences-absent', 'No readable Default/Preferences after the run');
    } else {
      rec.expect('search/preferences-readable', true, {
        keyPaths: profile.preferences.searchKeyPaths
      });
    }
    rec.limit('no-search-provider-baseline', 'Provider presence/absence is recorded, not judged as a defect');
    log(`search: flag=${alreadySet || commandLine.includes(SEARCH_KEY)} keys=${profile.preferences.searchKeyPaths?.length ?? 0}`);
    return finish(rec, {
      alreadySet,
      flagInCommandLine: commandLine.includes(SEARCH_KEY),
      preferences: profile.preferences
    });
  }
};
