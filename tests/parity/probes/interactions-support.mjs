// Shared helpers for the deterministic interaction parity probes.
import fs from 'node:fs';
import path from 'node:path';

export function assertThat(condition, message, detail) {
  if (condition) return;
  const suffix = detail === undefined ? '' : `: ${JSON.stringify(detail)}`;
  throw new Error(`interactions probe assertion failed: ${message}${suffix}`);
}

const PRELUDE = `
window.__log = [];
window.__note = function (entry) { window.__log.push(entry); };
window.__listen = function (types, target, map) {
  types.forEach(function (type) {
    (target || document).addEventListener(type, function (event) {
      var entry = {
        type: type,
        trusted: event.isTrusted === true,
        target: (event.target && (event.target.id || event.target.nodeName)) || null
      };
      if (map) map(entry, event);
      window.__note(entry);
    }, true);
  });
};
window.__settledScroll = function () {
  return new Promise(function (resolve) {
    var stable = 0;
    var last = -1;
    function tick() {
      var current = window.scrollY;
      stable = current === last ? stable + 1 : 0;
      last = current;
      if (stable >= 3) resolve(current);
      else requestAnimationFrame(tick);
    }
    tick();
  });
};
`;

const STYLE = [
  'html,body{margin:0;padding:0}',
  'body{font:16px/1.5 monospace;padding:8px}',
  'a,button,input,select,textarea,div{box-sizing:border-box}',
  '#hover-target{width:200px;height:80px;background:#cfd8dc}',
  '#click-target{width:140px;height:40px}',
  '#spacer{height:2000px}',
  '#bottom{height:40px;background:#e1bee7}',
  '#drag-source{width:140px;height:40px;background:#ffe0b2}',
  '#drop-target{width:220px;height:80px;background:#c8e6c9;margin-top:8px}',
  '#fs-target{width:120px;height:80px;background:#90caf9}',
  '#pl-canvas{display:block;width:240px;height:120px;background:#37474f}',
  '#tap-target{width:160px;height:48px}',
  'iframe{border:1px solid #90a4ae}',
].join('');

export function doc(title, body, script = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
    `<style>${STYLE}</style></head><body>${body}` +
    `<script>${PRELUDE}${script}</script></body></html>`;
}

export async function openPage(context, origin, html) {
  const base = origin.replace(/\/+$/, '');
  const page = await context.newPage();
  try {
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.setContent(html, { waitUntil: 'load' });
    const locationOrigin = await page.evaluate(() => location.origin);
    assertThat(locationOrigin === base, 'setContent must retain the loopback origin', { locationOrigin, base });
    return page;
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
}

export async function closePage(page) {
  if (!page || page.isClosed()) return;
  await page.close().catch(() => {});
}

export async function readLog(page) {
  return page.evaluate(() => window.__log || []);
}

export function eventsOf(log, type) {
  return log.filter((entry) => entry.type === type);
}

export function assertTrusted(entries, label) {
  assertThat(entries.length > 0, `expected at least one ${label} event`);
  for (const entry of entries) {
    assertThat(entry.trusted === true, `${label} event must be trusted`, entry);
  }
}

export function allTrusted(entries) {
  return entries.every((entry) => entry.trusted === true);
}

export function activeId(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    return element ? element.id || element.nodeName : null;
  });
}

export function artifactFile(artifactDir, probeName, filename) {
  const directory = path.join(artifactDir || path.join(process.cwd(), 'artifacts'), 'interactions', probeName);
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, filename);
}

export function pageProbe(name, html, body, extra = {}) {
  return {
    name,
    ...extra,
    async run({ context, origin, crossOrigin, artifactDir }) {
      const markup = typeof html === 'function' ? html(origin) : html;
      const page = await openPage(context, origin, markup);
      try {
        return await body({ page, origin, crossOrigin, artifactDir });
      } finally {
        await closePage(page);
      }
    },
  };
}

export const keySummary = (log, type) => eventsOf(log, type).map((entry) => ({
  key: entry.key,
  code: entry.code,
  ctrl: entry.ctrl,
  shift: entry.shift,
  alt: entry.alt,
  trusted: entry.trusted,
}));

export const inputSummary = (log, type) => eventsOf(log, type).map((entry) => ({
  inputType: entry.inputType,
  data: entry.data,
  value: entry.value,
  trusted: entry.trusted,
}));

export function findFrame(page, urlPrefix) {
  const frame = page.frames().find((candidate) => candidate.url().startsWith(urlPrefix));
  assertThat(frame, `iframe with url prefix ${urlPrefix} must be discoverable`, page.frames().map((candidate) => candidate.url()));
  return frame;
}

export async function instrumentFrame(frame) {
  await frame.evaluate(() => {
    window.__frameLog = [];
    const record = (event) => {
      const target = event.target;
      window.__frameLog.push({
        type: event.type,
        trusted: event.isTrusted === true,
        target: (target && (target.id || target.nodeName)) || null,
        key: event.key || null,
        inputType: typeof event.inputType === 'string' ? event.inputType : null,
        value: target && typeof target.value === 'string' ? target.value : null,
      });
    };
    for (const type of ['keydown', 'keyup', 'beforeinput', 'input', 'click']) {
      document.addEventListener(type, record, true);
    }
  });
}

export function frameLog(frame) {
  return frame.evaluate(() => window.__frameLog || []);
}
