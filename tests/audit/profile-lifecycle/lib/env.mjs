// Explicit launch environment for persistent contexts.
//
// Nothing here mutates `process.env`. A caller passes a `baseEnv` snapshot; this
// module only chooses which keys reach the browser process. Headless launches
// never see a display or session-authority key, and headed launches require the
// caller to name the owned display it wants used.

export const DISPLAY_KEYS = ['DISPLAY', 'WAYLAND_DISPLAY', 'WAYLAND_SOCKET', 'XAUTHORITY'];

// Keys a browser genuinely needs that are not session/display state.
export const BASE_KEYS = [
  'HOME', 'PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR',
  'XDG_RUNTIME_DIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'DBUS_SESSION_BUS_ADDRESS', 'FONTCONFIG_PATH', 'FONTCONFIG_FILE',
  'LD_LIBRARY_PATH', 'MOZ_ENABLE_WAYLAND'
];

export const MODES = ['headless', 'headed'];

export function normaliseMode(mode) {
  if (mode === true) return 'headless';
  if (mode === false) return 'headed';
  if (!MODES.includes(mode)) throw new Error(`launchEnv: mode must be one of ${MODES.join(', ')}`);
  return mode;
}

// Snapshot the allowlisted subset of an environment object. Read-only.
export function baseEnvFrom(source = process.env) {
  const baseEnv = {};
  for (const key of [...BASE_KEYS, ...DISPLAY_KEYS]) {
    if (typeof source?.[key] === 'string') baseEnv[key] = source[key];
  }
  return baseEnv;
}

export function sanitiseBaseEnv(baseEnv = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (!BASE_KEYS.includes(key) && !DISPLAY_KEYS.includes(key)) continue;
    clean[key] = value;
  }
  return clean;
}

/**
 * Environment for one launch. `headless` drops every display key even when the
 * base snapshot carries them, so a headless run can never attach to X/Wayland.
 */
export function launchEnv(mode, baseEnv = {}) {
  const normalised = normaliseMode(mode);
  const clean = sanitiseBaseEnv(baseEnv);
  const env = {};
  for (const key of BASE_KEYS) if (key in clean) env[key] = clean[key];
  if (normalised === 'headed') {
    if (!clean.DISPLAY) {
      throw new Error('launchEnv: a headed launch requires an explicit owned DISPLAY in baseEnv');
    }
    for (const key of DISPLAY_KEYS) if (key in clean) env[key] = clean[key];
  }
  return env;
}

export function envKeys(env) {
  return Object.keys(env ?? {}).sort();
}

export function displayKeys(env) {
  return envKeys(env).filter((key) => DISPLAY_KEYS.includes(key));
}
