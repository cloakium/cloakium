// Side-loaded MV3 extension through Playwright's documented persistent-context
// flags: --disable-extensions-except and --load-extension.
//
// Verification uses three public observables: the extension service-worker target,
// a marker evaluated inside that worker, and the extension id a content script
// writes onto our local fixture document.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recorder, finish } from '../lib/recorder.mjs';
import { bounded, settle } from '../lib/deadline.mjs';
import { inspectProfile } from '../lib/profile.mjs';

const EXTENSION_DIR = fileURLToPath(new URL('../extension', import.meta.url));
const EXTENSION_ID = /^[a-p]{32}$/;
const MARKER = 'profile-lifecycle-extension-marker-v1';

async function readManifest() {
  try {
    return JSON.parse(await fs.readFile(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

export const scenario = {
  id: 'extension-mv3',
  timeoutMs: 90_000,
  checks: [
    'extension/fixture-manifest-valid',
    'extension/service-worker-target',
    'extension/marker-evaluates',
    'extension/id-is-chromium-extension-id',
    'extension/content-script-marker-matches-id'
  ],

  async run({ lab, server, log }) {
    const rec = recorder();
    const manifest = await readManifest();
    rec.expect(
      'extension/fixture-manifest-valid',
      manifest?.manifest_version === 3 &&
        manifest?.background?.service_worker === 'background.js' &&
        Array.isArray(manifest?.content_scripts) &&
        manifest.content_scripts[0]?.matches?.includes('http://127.0.0.1/*') &&
        (manifest.permissions ?? []).length === 0,
      { name: manifest?.name ?? null, permissions: manifest?.permissions ?? null }
    );

    const directory = await lab.createProfile('extension');
    const args = [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`];
    const opened = await lab.open({ label: 'extension', directory, args });
    let serviceWorker = null;
    let waited = false;
    let marker = null;
    let extensionId = null;
    let contentId = null;
    try {
      const existing = opened.context.serviceWorkers();
      if (existing.length > 0) {
        serviceWorker = existing[0];
      } else {
        const event = await settle(
          opened.context.waitForEvent('serviceworker', { timeout: 15_000 }),
          16_000,
          'serviceworker event'
        );
        waited = true;
        serviceWorker = event.ok ? event.value : null;
        if (!event.ok) rec.limit('service-worker-not-observed', event.error);
      }
      rec.expect('extension/service-worker-target', Boolean(serviceWorker), {
        waited,
        workers: opened.context.serviceWorkers().map((worker) => worker.url())
      });

      if (serviceWorker) {
        extensionId = new URL(serviceWorker.url()).host;
        const evaluated = await settle(serviceWorker.evaluate(() => globalThis.LAB_MARKER ?? null), 10_000, 'marker');
        marker = evaluated.ok ? evaluated.value : null;
        if (!evaluated.ok) rec.limit('extension-evaluate-failed', evaluated.error);
        rec.expect('extension/marker-evaluates', marker === MARKER, { marker });
        rec.expect('extension/id-is-chromium-extension-id', EXTENSION_ID.test(extensionId), extensionId);
      } else {
        rec.unknown('extension/marker-evaluates', 'no service worker target');
        rec.unknown('extension/id-is-chromium-extension-id', 'no service worker target');
      }

      await opened.page.goto(server.origin, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      if (serviceWorker) {
        const observed = await settle(
          opened.page.waitForFunction(
            () => document.documentElement.dataset.labExtensionId ?? null,
            null,
            { timeout: 10_000 }
          ),
          11_000,
          'content script marker'
        );
        if (!observed.ok) rec.limit('content-script-not-observed', observed.error);
        contentId = await opened.page.evaluate(() => document.documentElement.dataset.labExtensionId ?? null);
        rec.expect(
          'extension/content-script-marker-matches-id',
          Boolean(contentId) && contentId === extensionId,
          { contentId, extensionId }
        );
      } else {
        rec.unknown('extension/content-script-marker-matches-id', 'no service worker target');
      }
    } finally {
      await lab.close();
    }

    const profile = await inspectProfile(directory);
    log(`extension: id=${extensionId ?? 'none'} marker=${marker ?? 'none'} waited=${waited}`);
    return finish(rec, {
      extensionDir: EXTENSION_DIR,
      extensionId,
      marker,
      waitedForWorker: waited,
      contentScriptId: contentId,
      profileExtensions: profile.files.rows.filter((row) => row.path.includes('Extension')).map((row) => row.path)
    });
  }
};
