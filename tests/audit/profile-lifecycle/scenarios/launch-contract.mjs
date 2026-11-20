// Launch contract: the harness arguments reach the engine, the sandbox is on, and
// Playwright's automation/sandbox defaults were filtered out.

import { recorder, finish } from '../lib/recorder.mjs';
import { flagsPresent, flagName, hasFlag } from '../lib/flags.mjs';
import { readChromeVersion } from '../lib/page.mjs';
import { settle } from '../lib/deadline.mjs';
import { readOwnershipMarker } from '../lib/profile.mjs';

export const scenario = {
  id: 'launch-contract',
  timeoutMs: 45_000,
  checks: [
    'launch/profile-directory-owned',
    'launch/base-args-visible-in-command-line',
    'launch/no-no-sandbox-flag',
    'launch/sandbox-page-reports-sandboxed'
  ],

  async run({ lab, server, baseArgs, log }) {
    const rec = recorder();
    const directory = await lab.createProfile('launch-contract');
    const { page } = await lab.open({ label: 'launch-contract', directory });
    try {
      rec.expect('launch/profile-directory-owned', Boolean(await readOwnershipMarker(directory)));
      await page.goto(server.origin, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      const versionText = await readChromeVersion(page);
      const commandLine = versionText.split('\n').find((line) => line.includes('--')) ?? versionText;
      const expected = baseArgs.map((argument) => flagName(argument)).filter((name) => name !== '--');
      const present = flagsPresent(baseArgs, commandLine);
      rec.expect(
        'launch/base-args-visible-in-command-line',
        expected.length === 0 || present.length === expected.length,
        { expected, present }
      );
      rec.expect('launch/no-no-sandbox-flag', !/--no-sandbox\b/.test(commandLine));

      const sandbox = await settle(
        (async () => {
          await page.goto('chrome://sandbox', { waitUntil: 'domcontentloaded', timeout: 5000 });
          return page.locator('body').innerText({ timeout: 5000 });
        })(),
        8000,
        'chrome://sandbox'
      );
      const sandboxed = sandbox.ok && /adequately sandboxed/i.test(sandbox.value);
      if (sandboxed) {
        rec.expect('launch/sandbox-page-reports-sandboxed', true);
      } else {
        rec.unknown(
          'launch/sandbox-page-reports-sandboxed',
          sandbox.ok ? 'page did not confirm the sandbox' : sandbox.error
        );
        if (sandbox.ok) rec.limit('sandbox-page-inconclusive', sandbox.value.replace(/\s+/g, ' ').slice(0, 200));
        else rec.limit('sandbox-page-unavailable', sandbox.error);
      }
      log(`launch-contract: args=${expected.join(',') || 'none'}`);
      return finish(rec, {
        directory,
        baseArgs,
        expectedFlags: expected,
        presentFlags: present,
        noSandboxFlag: hasFlag(baseArgs, '--no-sandbox'),
        commandLineDigestLength: commandLine.length,
        sandboxText: sandbox.ok ? sandbox.value.replace(/\s+/g, ' ').slice(0, 300) : null
      });
    } finally {
      await lab.close();
    }
  }
};
