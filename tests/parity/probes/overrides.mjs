// Explicit Playwright context-emulation probes. These exercise only supported
// context options (no page-level getter patching) so the same assertions must
// hold on a headed reference and on headless: mobile/touch descriptor, media
// preference overrides, locale/timezone overrides.
//
// Run with `--native-defaults` so Playwright's headless-only Blink overrides
// are stripped and the real device/media fallbacks are measured.

import { invariant, openPage } from './environment-support.mjs';

const MOBILE_VIEWPORT = { width: 414, height: 896 };

const MOBILE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; padding: 0; }
  #pad { width: 160px; height: 64px; touch-action: manipulation; }
  #ruler { width: 100px; height: 10px; background: #336699; }
</style></head><body>
<div id="ruler"></div>
<button id="pad" type="button">tap</button>
<pre id="log">none</pre>
<script>
  window.__touch = { events: [], trusted: [], pointerTypes: [] };
  const record = (type) => (event) => {
    window.__touch.events.push(type);
    window.__touch.trusted.push(event.isTrusted === true);
    if (event.pointerType) window.__touch.pointerTypes.push(event.pointerType);
    document.body.dataset.tapped = type;
    document.querySelector('#log').textContent = window.__touch.events.join(',');
  };
  const pad = document.querySelector('#pad');
  pad.addEventListener('touchstart', record('touchstart'));
  pad.addEventListener('touchend', record('touchend'));
  pad.addEventListener('pointerdown', record('pointerdown'));
</script></body></html>`;

const PREFERENCES_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { --scheme: none; --motion: none; --forced: none; }
  @media (prefers-color-scheme: dark) { :root { --scheme: dark; } }
  @media (prefers-color-scheme: light) { :root { --scheme: light; } }
  @media (prefers-reduced-motion: reduce) { :root { --motion: reduce; } }
  @media (prefers-reduced-motion: no-preference) { :root { --motion: no-preference; } }
  @media (forced-colors: active) { :root { --forced: active; } }
  @media (forced-colors: none) { :root { --forced: none; } }
  #probe { width: 40px; height: 20px; background: #336699; }
</style></head><body><div id="probe"></div></body></html>`;

const mobileTouch = {
  name: 'overrides/mobile-touch-descriptor',
  timeoutMs: 30000,
  contextOptions: {
    viewport: MOBILE_VIEWPORT,
    screen: MOBILE_VIEWPORT,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
  async run({ context, origin }) {
    const page = await openPage(context, `${origin}/`);
    await page.setContent(MOBILE_HTML);
    const before = await page.evaluate((expected) => {
      const queries = {
        'pointer: coarse': matchMedia('(pointer: coarse)').matches,
        'pointer: fine': matchMedia('(pointer: fine)').matches,
        'pointer: none': matchMedia('(pointer: none)').matches,
        'any-pointer: coarse': matchMedia('(any-pointer: coarse)').matches,
        'any-pointer: fine': matchMedia('(any-pointer: fine)').matches,
        'hover: none': matchMedia('(hover: none)').matches,
        'hover: hover': matchMedia('(hover: hover)').matches,
        'any-hover: none': matchMedia('(any-hover: none)').matches,
        'resolution: 2dppx': matchMedia('(resolution: 2dppx)').matches,
        'min-resolution: 2dppx': matchMedia('(min-resolution: 2dppx)').matches,
        'orientation: portrait': matchMedia('(orientation: portrait)').matches,
        'display-mode: browser': matchMedia('(display-mode: browser)').matches,
      };
      const ruler = document.querySelector('#ruler').getBoundingClientRect();
      return {
        expected,
        innerWidth,
        innerHeight,
        outerWidth,
        outerHeight,
        devicePixelRatio,
        screen: {
          width: screen.width,
          height: screen.height,
          availWidth: screen.availWidth,
          availHeight: screen.availHeight,
          orientation: screen.orientation?.type ?? null,
        },
        visualViewport: window.visualViewport
          ? {
              width: window.visualViewport.width,
              height: window.visualViewport.height,
              scale: window.visualViewport.scale,
            }
          : null,
        queries,
        maxTouchPoints: navigator.maxTouchPoints,
        touchEventGlobal: 'ontouchstart' in window,
        touchEventConstructor: typeof window.TouchEvent,
        userAgentDataMobile: navigator.userAgentData?.mobile ?? null,
        rulerCssPixels: { width: ruler.width, height: ruler.height },
        userAgent: navigator.userAgent,
      };
    }, MOBILE_VIEWPORT);
    await page.tap('#pad', { timeout: 5000 });
    const after = await page.evaluate(() => ({
      touch: window.__touch,
      tappedFlag: document.body.dataset.tapped ?? null,
      log: document.querySelector('#log').textContent,
      userActivation: {
        isActive: navigator.userActivation.isActive,
        hasBeenActive: navigator.userActivation.hasBeenActive,
      },
    }));
    const observed = { before, after };
    const q = before.queries;
    return invariant(observed, [
      ['maxTouchPointsAtLeastOne', before.maxTouchPoints >= 1],
      ['pointerCoarse', q['pointer: coarse'] === true],
      ['pointerNotFine', q['pointer: fine'] === false],
      ['hoverNone', q['hover: none'] === true],
      ['hoverNotHover', q['hover: hover'] === false],
      ['anyPointerCoarse', q['any-pointer: coarse'] === true],
      ['devicePixelRatioIs2', before.devicePixelRatio === 2],
      ['resolution2dppx', q['resolution: 2dppx'] === true],
      ['innerWidthMatchesViewport', before.innerWidth === MOBILE_VIEWPORT.width],
      ['innerHeightMatchesViewport', before.innerHeight === MOBILE_VIEWPORT.height],
      ['screenWidthEmulated', before.screen.width === MOBILE_VIEWPORT.width],
      ['screenHeightEmulated', before.screen.height === MOBILE_VIEWPORT.height],
      ['visualViewportWidth', before.visualViewport !== null && before.visualViewport.width === MOBILE_VIEWPORT.width],
      ['cssPixelRuler', before.rulerCssPixels.width === 100],
      ['portraitOrientation', q['orientation: portrait'] === true],
      ['touchEventsAvailable', before.touchEventGlobal === true && before.touchEventConstructor === 'function'],
      ['uaDataMobileIsBoolean', typeof before.userAgentDataMobile === 'boolean'],
      ['tapProducedTouchstart', after.touch.events.includes('touchstart')],
      ['tapEventsTrusted', after.touch.trusted.length > 0 && after.touch.trusted.every(Boolean)],
      ['tapPointerTypeTouch', after.touch.pointerTypes.includes('touch')],
      ['tapUpdatedDomState', after.tappedFlag !== null && after.log !== 'none'],
      ['tapGrantedActivation', after.userActivation.hasBeenActive === true],
    ]);
  },
};

const mediaPreferences = {
  name: 'overrides/media-preferences',
  contextOptions: {
    viewport: { width: 1000, height: 700 },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    forcedColors: 'active',
  },
  async run({ context, origin }) {
    const page = await openPage(context, `${origin}/`);
    await page.setContent(PREFERENCES_HTML);
    const observed = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const probe = getComputedStyle(document.querySelector('#probe'));
      return {
        queries: {
          'prefers-color-scheme: dark': matchMedia('(prefers-color-scheme: dark)').matches,
          'prefers-color-scheme: light': matchMedia('(prefers-color-scheme: light)').matches,
          'prefers-reduced-motion: reduce': matchMedia('(prefers-reduced-motion: reduce)').matches,
          'prefers-reduced-motion: no-preference': matchMedia('(prefers-reduced-motion: no-preference)').matches,
          'forced-colors: active': matchMedia('(forced-colors: active)').matches,
          'forced-colors: none': matchMedia('(forced-colors: none)').matches,
        },
        cssVariables: {
          scheme: root.getPropertyValue('--scheme').trim(),
          motion: root.getPropertyValue('--motion').trim(),
          forced: root.getPropertyValue('--forced').trim(),
        },
        colorScheme: root.colorScheme || null,
        probeBackground: probe.backgroundColor,
        probeBorderWidth: probe.borderTopWidth,
        stable: matchMedia('(prefers-color-scheme: dark)').matches === matchMedia('(prefers-color-scheme: dark)').matches,
      };
    });
    const q = observed.queries;
    const css = observed.cssVariables;
    return invariant(observed, [
      ['colorSchemeDark', q['prefers-color-scheme: dark'] === true],
      ['colorSchemeNotLight', q['prefers-color-scheme: light'] === false],
      ['reducedMotionReduce', q['prefers-reduced-motion: reduce'] === true],
      ['reducedMotionNotNoPreference', q['prefers-reduced-motion: no-preference'] === false],
      ['forcedColorsActive', q['forced-colors: active'] === true],
      ['forcedColorsNotNone', q['forced-colors: none'] === false],
      ['cssDarkCoherent', css.scheme === 'dark'],
      ['cssMotionCoherent', css.motion === 'reduce'],
      ['cssForcedCoherent', css.forced === 'active'],
      ['queriesStable', observed.stable],
      ['probeRendered', observed.probeBackground !== '' && observed.probeBackground !== 'rgba(0, 0, 0, 0)'],
    ]);
  },
};

const localeTimezone = {
  name: 'overrides/locale-timezone',
  timeoutMs: 30000,
  contextOptions: { viewport: { width: 1000, height: 700 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' },
  async run({ context, origin }) {
    const page = await openPage(context, `${origin}/`);
    await page.setContent('<!doctype html><html><body><pre id="out"></pre></body></html>');
    const observed = await page.evaluate(async () => {
      const resolved = Intl.DateTimeFormat().resolvedOptions();
      const headers = await (await fetch('/headers', { cache: 'no-store' })).json();
      const worker = await new Promise((resolve, reject) => {
        const source = `self.onmessage = () => postMessage({
          language: navigator.language,
          languages: navigator.languages.join(','),
          resolved: Intl.DateTimeFormat().resolvedOptions().timeZone,
          offset: new Date(Date.UTC(2026, 0, 15, 12, 0, 0)).getTimezoneOffset(),
        });`;
        const script = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
        const timer = setTimeout(() => reject(new Error('locale worker timeout')), 5000);
        script.addEventListener('message', (event) => {
          clearTimeout(timer);
          resolve(event.data);
        });
        script.addEventListener('error', (event) => {
          clearTimeout(timer);
          reject(new Error(`locale worker error: ${event.message}`));
        });
        script.postMessage('go');
      });
      const winter = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
      const summer = new Date(Date.UTC(2026, 6, 15, 12, 0, 0));
      return {
        language: navigator.language,
        languages: navigator.languages,
        resolved: { locale: resolved.locale, timeZone: resolved.timeZone, calendar: resolved.calendar },
        offsets: { winter: winter.getTimezoneOffset(), summer: summer.getTimezoneOffset() },
        numberFormat: new Intl.NumberFormat('de-DE').format(1234.5),
        dateFormat: new Intl.DateTimeFormat('de-DE', {
          timeZone: 'Europe/Berlin',
          dateStyle: 'short',
          timeStyle: 'short',
        }).format(winter),
        acceptLanguage: headers['accept-language'] ?? null,
        worker,
      };
    });
    return invariant(observed, [
      ['languageIsGerman', observed.language === 'de-DE'],
      ['languagesStartGerman', observed.languages[0] === 'de-DE'],
      ['timezoneIsBerlin', observed.resolved.timeZone === 'Europe/Berlin'],
      ['winterOffsetCet', observed.offsets.winter === -60],
      ['summerOffsetCest', observed.offsets.summer === -120],
      ['numberFormatGerman', observed.numberFormat === '1.234,5'],
      ['dateFormatGerman', /^15\.01\.26, 13:00$/.test(observed.dateFormat)],
      ['acceptLanguageHeader', typeof observed.acceptLanguage === 'string' && observed.acceptLanguage.includes('de-DE')],
      ['workerLanguageCoherent', observed.worker.language === 'de-DE'],
      ['workerTimezoneCoherent', observed.worker.resolved === 'Europe/Berlin' && observed.worker.offset === -60],
    ]);
  },
};

export const probes = [mobileTouch, mediaPreferences, localeTimezone];
