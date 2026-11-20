import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { privateDirectory, atomicJson } from "./secure-io.mjs";
import { hashFile, hashValue } from "./hashes.mjs";
import { processIdentity } from "./processes.mjs";

export const displayKeys = ["DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "XAUTHORITY"];
const desktopKeys = [
  "DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK", "GPG_AGENT_INFO", "SESSION_MANAGER",
  "XDG_SESSION_TYPE", "XDG_SESSION_ID", "XDG_RUNTIME_DIR",
];
const runtimeRoots = new WeakMap();

export async function validateOutput(directory, projectRoot) {
  if (!path.isAbsolute(directory)) throw new Error("Audit output must be an absolute path");
  const absolute = path.resolve(directory);
  const relative = path.relative(await fs.realpath(projectRoot), absolute);
  if (!relative.startsWith(`..${path.sep}`) && relative !== "..")
    throw new Error("Private audit output must be outside the project");
  let current = path.parse(absolute).root;
  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("Audit output ancestry must consist of regular directories");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await privateDirectory(absolute);
  return absolute;
}

export async function launchEnvironment(environment, directory, mode, display = null) {
  if (!["headless", "headed"].includes(mode)) throw new Error("Audit mode must be explicit");
  if (mode === "headed" &&
      (!display?.owned || display.authEnforced !== true || !/^:\d+$/.test(display.display)))
    throw new Error("Headed mode requires a verified private authenticated display");
  await privateDirectory(directory);
  const home = path.join(directory, "home");
  const shortRoot = await fs.mkdtemp("/tmp/opencode/ca-");
  const temporary = path.join(shortRoot, "tmp");
  const runtime = path.join(shortRoot, "run");
  try {
    for (const name of [home, temporary, runtime]) await privateDirectory(name);
    const identity = await processIdentity(process.pid);
    if (!identity) throw new Error("Cannot establish private runtime ownership");
    const ownership = { schema: "cloakium.audit.runtime/1", root: shortRoot,
      pid: identity.pid, startTicks: identity.startTicks, configurationDirectory: directory };
    await atomicJson(path.join(shortRoot, "owner.json"), ownership);
    await atomicJson(path.join(directory, "launch-runtime.json"), ownership);
    const env = {
    PATH: "/run/current-system/sw/bin:/usr/bin:/bin",
    HOME: home, TMPDIR: temporary,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_RUNTIME_DIR: runtime,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8", TZ: environment.timezoneId,
    };
    if (environment.fontconfigFile) {
      env.FONTCONFIG_FILE = await fs.realpath(environment.fontconfigFile);
      await hashFile(env.FONTCONFIG_FILE);
    }
    if (environment.fontconfigPath) env.FONTCONFIG_PATH = await fs.realpath(environment.fontconfigPath);
    if (mode === "headed") {
      env.DISPLAY = display.display;
      env.XAUTHORITY = display.xauthorityPath;
      env.XDG_SESSION_TYPE = "x11";
    }
    runtimeRoots.set(env, ownership);
    return env;
  } catch (error) {
    await fs.rm(shortRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupLaunchEnvironment(env, { resourcesClosed = false } = {}) {
  const ownership = runtimeRoots.get(env);
  if (!ownership) return { closed: true, allocated: false };
  if (!resourcesClosed) return { closed: false, retained: true, root: ownership.root };
  await privateDirectory(ownership.root);
  const marker = JSON.parse(await fs.readFile(path.join(ownership.root, "owner.json"), "utf8"));
  if (hashValue(marker) !== hashValue(ownership)) throw new Error("Private runtime ownership changed");
  await fs.rm(ownership.root, { recursive: true });
  runtimeRoots.delete(env);
  return { closed: true, allocated: true, rootRemoved: true };
}

export async function environmentReceipt(environment, env, display = null, fonts = null, contextPolicy = {}) {
  return {
    id: environment.id, platform: process.platform, architecture: process.arch,
    kernel: os.release(), node: process.version,
    locale: environment.locale, timezoneId: environment.timezoneId,
    fontconfigFile: env.FONTCONFIG_FILE ?? null,
    fontconfigSha256: env.FONTCONFIG_FILE ? await hashFile(env.FONTCONFIG_FILE) : null,
    fontManifestSha256: fonts?.sha256 ?? null,
    declaredFontManifestSha256: environment.fontManifestSha256 ?? null,
    fontManifestVerification: fonts?.status === "measured" ? "fontconfig-visible-files-measured" : "unavailable",
    fonts,
    envKeys: Object.keys(env).sort(),
    ambientEndpointsExcluded: [...displayKeys, ...desktopKeys].filter(key => !Object.hasOwn(env, key)),
    display: display ? {
      kind: "owned-private-x11", screen: display.screen, windowManager: display.windowManager,
      authEnforced: display.authEnforced, ownershipManifestSha256: display.manifestSha256,
    } : { kind: "none", xRequired: false },
    configSha256: hashValue({ environment, contextPolicy }),
    isolation: "Minimal launch environment; not a malware sandbox or OS-wide network capture.",
    runtimePathPolicy: "Short owned TMPDIR and XDG runtime paths avoid Unix socket pathname limits.",
  };
}

export async function observeEnvironment(browser, origin, contextOptions) {
  const context = await browser.newContext({ viewport: null, ...contextOptions });
  try {
    const page = await context.newPage();
    if (page.url() !== "about:blank") await page.goto("about:blank", { timeout: 10000 });
    const observed = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const graphics = canvas.getContext("2d");
      const families = ["sans-serif", "serif", "monospace", "Arial", "Noto Sans", "DejaVu Sans"];
      const fontMetrics = Object.fromEntries(families.map(family => {
        graphics.font = `16px "${family}"`;
        const value = graphics.measureText("Audit MmWw 0123456789");
        return [family, [value.width, value.actualBoundingBoxAscent, value.actualBoundingBoxDescent]];
      }));
      return {
        language: navigator.language, languages: [...navigator.languages],
        intl: Intl.DateTimeFormat().resolvedOptions(),
        screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight,
          colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth },
        window: { innerWidth, innerHeight, outerWidth, outerHeight, screenX, screenY, devicePixelRatio },
        fontMetrics,
      };
    });
    return {
      ...observed, samplingScope: "network-independent-about-blank",
      intendedFixtureOrigin: origin,
      limitation: "HTTP-origin font and realm behavior is measured by the functional probes, not this transport-independent receipt.",
    };
  } finally { await context.close({ reason: "audit environment observation complete" }); }
}
