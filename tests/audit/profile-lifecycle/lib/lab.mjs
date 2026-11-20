// Staged persistent-context lab: one context at a time, sandbox on, explicit env.

import path from 'node:path';
import fs from 'node:fs/promises';
import { safeError } from '../../lib/secure-io.mjs';
import { bounded } from './deadline.mjs';
import { baseEnvFrom, displayKeys, envKeys, launchEnv } from './env.mjs';
import { assertSafeArguments, redactArguments } from './flags.mjs';
import { createProfileDirectory, writeOwnershipMarker } from './profile.mjs';

export const IGNORED_DEFAULT_ARGS = ['--enable-automation', '--enable-unsafe-swiftshader', '--no-sandbox'];

function createSerial() {
  let tail = Promise.resolve();
  return (task) => {
    const result = tail.then(task, task);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

export function createLab(options) {
  const {
    chromium,
    executablePath,
    headless,
    baseArgs,
    workRoot,
    baseEnv = null,
    ignoreDefaultArgs = [],
    contextOptions = null,
    keepProfiles = false,
    launchTimeoutMs = 60000,
    closeTimeoutMs = 30000
  } = options;

  if (!chromium || typeof chromium.launchPersistentContext !== 'function') {
    throw new Error('createLab: chromium BrowserType with launchPersistentContext is required');
  }
  if (!path.isAbsolute(executablePath)) throw new Error('createLab: executablePath must be absolute');
  if (typeof headless !== 'boolean') throw new Error('createLab: headless must be boolean');
  assertSafeArguments(baseArgs ?? []);
  if (!Array.isArray(ignoreDefaultArgs) || ignoreDefaultArgs.some((arg) => typeof arg !== 'string' || !arg.startsWith('--'))) {
    throw new Error('createLab: ignoreDefaultArgs must be an array of "--flag" strings');
  }
  if (contextOptions !== null && (typeof contextOptions !== 'object' || Array.isArray(contextOptions))) {
    throw new Error('createLab: contextOptions must be an object');
  }

  // Explicit caller snapshot for standalone use; runScenarios always passes one.
  const envSource = baseEnv ?? baseEnvFrom();
  // The persistent driver keeps its own ignored defaults; caller additions are
  // merged de-duplicated and recorded literally for the parent's comparison.
  const ignoredDefaults = [...new Set([...IGNORED_DEFAULT_ARGS, ...ignoreDefaultArgs])];
  const baseContextOptions = { viewport: null, ...(contextOptions ?? {}) };
  const serial = createSerial();
  const launches = [];
  const profiles = new Set();
  const counters = { opened: 0, closed: 0, closeFailures: 0 };
  let disposed = false;

  const lab = {
    failedCleanup: false,
    current: null,
    launches,
    workRoot,
    baseEnv: envSource,
    ignoreDefaultArgs: ignoredDefaults,
    contextOptions: baseContextOptions,
    async initialise() {
      await fs.mkdir(workRoot, { recursive: true, mode: 0o700 });
      await writeOwnershipMarker(workRoot, {
        kind: 'lab-root',
        headless,
        scenarios: 'profile-lifecycle',
        envKeys: envKeys(envSource)
      });
    },
    profile(label) {
      const directory = path.join(workRoot, label);
      profiles.add(directory);
      return directory;
    },
    async createProfile(label, meta = {}) {
      const directory = lab.profile(label);
      await createProfileDirectory(workRoot, label, meta);
      return directory;
    },
    assertIdle() {
      if (lab.current) throw new Error(`a profile is still open: ${lab.current.label}`);
      if (lab.failedCleanup) throw new Error('a previous close failed; no further launch is permitted');
    },
    stats() {
      return {
        contextsOpened: counters.opened,
        contextsClosed: counters.closed,
        closeFailures: counters.closeFailures,
        activeContexts: lab.current ? 1 : 0,
        profilesRetained: profiles.size,
        failedCleanup: lab.failedCleanup
      };
    },
    open({ label, directory, args = [], headless: mode = headless, contextOptions: openContextOptions = {} }) {
      return serial(async () => {
        lab.assertIdle();
        if (openContextOptions && (typeof openContextOptions !== 'object' || Array.isArray(openContextOptions))) {
          throw new Error('createLab: open contextOptions must be an object');
        }
        const fullArgs = [...(baseArgs ?? []), ...args];
        assertSafeArguments(fullArgs);
        const env = launchEnv(mode, envSource);
        const mergedContextOptions = { ...baseContextOptions, ...openContextOptions };
        const launchOptions = {
          executablePath,
          headless: mode,
          chromiumSandbox: true,
          ignoreDefaultArgs: [...ignoredDefaults],
          args: fullArgs,
          env,
          ...mergedContextOptions,
          acceptDownloads: false,
          handleSIGINT: false,
          handleSIGTERM: false,
          timeout: launchTimeoutMs
        };
        const entry = {
          label,
          directory,
          headless: mode,
          args: redactArguments(fullArgs),
          ignoreDefaultArgs: [...ignoredDefaults],
          contextOptions: { ...mergedContextOptions },
          envKeys: envKeys(env),
          displayKeys: displayKeys(env),
          launchedAt: new Date().toISOString()
        };
        let context;
        try {
          context = await bounded(
            chromium.launchPersistentContext(directory, launchOptions),
            launchTimeoutMs,
            `${label}: launch`
          );
        } catch (error) {
          throw Object.assign(new Error(`${label}: launch failed`), {
            code: error.code,
            auditError: safeError(error, `${label} launch`)
          });
        }
        const page = context.pages()[0] ?? (await context.newPage());
        try {
          entry.version = context.browser()?.version?.() ?? null;
        } catch {
          entry.version = null;
        }
        counters.opened += 1;
        lab.current = { ...entry, context, page };
        launches.push(entry);
        return { context, page, entry };
      });
    },
    close() {
      return serial(async () => {
        if (!lab.current) return { closed: false };
        const active = lab.current;
        lab.current = null;
        try {
          await bounded(active.context.close(), closeTimeoutMs, `${active.label}: close`);
        } catch (error) {
          counters.closeFailures += 1;
          lab.failedCleanup = true;
          active.closeError = safeError(error, `${active.label} close`);
          active.closedAt = new Date().toISOString();
          throw Object.assign(new Error('context close failed'), { auditError: active.closeError });
        }
        counters.closed += 1;
        active.closedAt = new Date().toISOString();
        return { closed: true, entry: active };
      });
    },
    async closeAll() {
      try {
        await lab.close();
      } finally {
        if (lab.current) {
          try {
            await bounded(lab.current.context.close(), closeTimeoutMs, 'closeAll');
            counters.closed += 1;
          } catch (error) {
            counters.closeFailures += 1;
            lab.failedCleanup = true;
            lab.current.closeError = safeError(error, 'closeAll');
          }
          lab.current = null;
        }
      }
    },
    async dispose() {
      await lab.closeAll();
      if (disposed) return { removed: 0, kept: profiles.size };
      disposed = true;
      if (keepProfiles) return { removed: 0, kept: profiles.size };
      const removedDirectories = new Set();
      for (const directory of profiles) {
        try {
          await fs.rm(directory, { recursive: true, force: true });
          removedDirectories.add(directory);
        } catch {
          /* a profile that cannot be removed is reported by the caller's tree */
        }
      }
      for (const directory of removedDirectories) profiles.delete(directory);
      return { removed: removedDirectories.size, kept: profiles.size };
    }
  };
  return lab;
}
