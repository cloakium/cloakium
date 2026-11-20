// Environment parity probes: geometry, media queries and native-ness of the
// host surface. Observation-only; assertions encode same-mode invariants so a
// violation fails the probe instead of passing silently.

import { MEDIA_QUERIES, NATIVE_APIS, invariant, openPage } from './environment-support.mjs';

const windowGeometry = {
  name: 'environment/window-geometry',
  contextOptions: { viewport: null },
  async run({ context, origin }) {
    const page = await openPage(context, `${origin}/`);
    await page.setContent('<!doctype html><html><body></body></html>');
    const observed = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;top:-9999px;width:120px;height:120px;overflow:scroll';
      document.body.append(probe);
      const scrollbarWidth = probe.offsetWidth - probe.clientWidth;
      const scrollbarHeight = probe.offsetHeight - probe.clientHeight;
      probe.remove();
      const orientation = screen.orientation || {};
      const vv = window.visualViewport;
      return {
        innerWidth,
        innerHeight,
        outerWidth,
        outerHeight,
        screenX,
        screenY,
        devicePixelRatio,
        screen: {
          width: screen.width,
          height: screen.height,
          availWidth: screen.availWidth,
          availHeight: screen.availHeight,
          availLeft: screen.availLeft ?? null,
          availTop: screen.availTop ?? null,
          isExtended: screen.isExtended ?? null,
          orientation: { type: orientation.type ?? null, angle: orientation.angle ?? null },
          delta: { width: screen.width - screen.availWidth, height: screen.height - screen.availHeight },
        },
        visualViewport: vv
          ? { width: vv.width, height: vv.height, scale: vv.scale, offsetLeft: vv.offsetLeft, offsetTop: vv.offsetTop }
          : null,
        documentElement: { clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight },
        scrollbarWidth,
        scrollbarHeight,
        chromeInsets: { width: outerWidth - innerWidth, height: outerHeight - innerHeight },
        isSecureContext,
        visibilityState: document.visibilityState,
      };
    });
    return invariant(observed, [
      ['innerWidth>0', observed.innerWidth > 0],
      ['innerHeight>0', observed.innerHeight > 0],
      ['outerWidth>=innerWidth', observed.outerWidth >= observed.innerWidth],
      ['outerHeight>=innerHeight', observed.outerHeight >= observed.innerHeight],
      ['devicePixelRatio>0', observed.devicePixelRatio > 0],
      ['screen.width>0', observed.screen.width > 0],
      ['availWithinScreen', observed.screen.availWidth <= observed.screen.width && observed.screen.availHeight <= observed.screen.height],
      ['clientWidth<=innerWidth', observed.documentElement.clientWidth <= observed.innerWidth],
      ['scrollbarWidth>=0', observed.scrollbarWidth >= 0],
      ['visualViewportPresent', observed.visualViewport !== null],
    ]);
  },
};

const mediaQueries = {
  name: 'environment/media-queries',
  async run({ context, origin }) {
    const page = await openPage(context, `${origin}/`);
    await page.setContent('<!doctype html><html><body></body></html>');
    const observed = await page.evaluate((queries) => {
      const matches = {};
      for (const query of queries) matches[query] = matchMedia(query).matches;
      const repeat = {};
      for (const query of queries) repeat[query] = matchMedia(query).matches;
      const pick = (kind) =>
        ['fine', 'coarse', 'none'].find((value) => matches[`(${kind}: ${value})`]) ?? 'unknown';
      const hover = ['hover', 'none'].find((value) => matches[`(hover: ${value})`]) ?? 'unknown';
      return {
        matches,
        deterministic: queries.every((query) => matches[query] === repeat[query]),
        derived: {
          pointer: pick('pointer'),
          anyPointer: pick('any-pointer'),
          hover,
          anyHover: matches['(any-hover: hover)'] ? 'hover' : 'none',
          colorScheme: matches['(prefers-color-scheme: dark)'] ? 'dark' : 'light',
          dynamicRange: matches['(dynamic-range: high)'] ? 'high' : 'standard',
          forcedColors: matches['(forced-colors: active)'],
          monochrome: matches['(monochrome)'],
          colorGamut: ['rec2020', 'p3', 'srgb'].find((g) => matches[`(color-gamut: ${g})`]) ?? 'unknown',
        },
      };
    }, MEDIA_QUERIES);
    const derived = observed.derived;
    return invariant(observed, [
      ['deterministic', observed.deterministic],
      ['pointerKnown', derived.pointer !== 'unknown'],
      ['pointerHoverCoherent', !(derived.pointer === 'none' && derived.hover === 'hover')],
      ['colorPresent', observed.matches['(color)'] === true],
      ['srgbBaseline', derived.colorGamut !== 'unknown'],
    ]);
  },
};

const nativeDescriptors = {
  name: 'environment/native-descriptors',
  async run({ context, origin }) {
    const page = await openPage(context, `${origin}/`);
    await page.setContent('<!doctype html><html><body></body></html>');
    const observed = await page.evaluate((apis) => {
      const nativeSource = /\{\s*\[native code\]\s*\}$/;
      const describe = (descriptor) => {
        if (!descriptor) return { present: false };
        const getter = typeof descriptor.get === 'function' ? Function.prototype.toString.call(descriptor.get) : null;
        const value = typeof descriptor.value === 'function' ? Function.prototype.toString.call(descriptor.value) : null;
        const accessor = getter ?? value;
        return {
          present: true,
          kind: descriptor.get ? 'accessor' : 'data',
          writable: descriptor.writable ?? null,
          configurable: descriptor.configurable ?? null,
          enumerable: descriptor.enumerable ?? null,
          native: accessor ? nativeSource.test(accessor.trim()) : null,
          source: accessor ? accessor.trim().slice(0, 90) : null,
        };
      };
      const apisOut = {};
      for (const expression of apis) apisOut[expression] = describe(eval(expression));

      const audit = (target, label) => {
        const offenders = [];
        for (const key of Object.getOwnPropertyNames(target)) {
          if (key === 'constructor') continue;
          const descriptor = Object.getOwnPropertyDescriptor(target, key);
          const callable = descriptor.get ?? descriptor.value;
          if (typeof callable !== 'function') continue;
          if (!nativeSource.test(Function.prototype.toString.call(callable).trim())) offenders.push(`${label}.${key}`);
        }
        return offenders;
      };
      const polyfills = [
        ...audit(Navigator.prototype, 'Navigator.prototype'),
        ...audit(Window.prototype, 'Window.prototype'),
        ...audit(CanvasRenderingContext2D.prototype, 'CanvasRenderingContext2D.prototype'),
        ...audit(WebGLRenderingContext.prototype, 'WebGLRenderingContext.prototype'),
        ...audit(HTMLCanvasElement.prototype, 'HTMLCanvasElement.prototype'),
        ...audit(Permissions.prototype, 'Permissions.prototype'),
      ];
      return {
        webdriver: { value: navigator.webdriver, type: typeof navigator.webdriver },
        apis: apisOut,
        polyfillOffenders: polyfills,
        chromeObject: window.chrome
          ? { present: true, keys: Object.keys(window.chrome).sort(), runtime: typeof window.chrome.runtime }
          : { present: false },
        navigatorOwnKeys: Object.getOwnPropertyNames(Object.getPrototypeOf(navigator)).sort(),
        automationGlobals: ['__playwright', '__pwManualAddInitScript', '__puppeteer_evaluation_script__', 'cdc_adoQpoasnfa76pfcZLmcfl_Array'].filter(
          (name) => name in window,
        ),
        globals: {
          webdriverInWindow: 'webdriver' in window,
          callPhantom: typeof window.callPhantom,
          domAutomation: typeof window.domAutomation,
          domAutomationController: typeof window.domAutomationController,
        },
      };
    }, NATIVE_APIS);
    return invariant(observed, [
      ['webdriverFalse', observed.webdriver.value === false],
      ['webdriverIsNativeGetter', observed.apis["Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver')"].native === true],
      ['getImageDataNative', observed.apis["Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'getImageData')"].native === true],
      ['toDataUrlNative', observed.apis["Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'toDataURL')"].native === true],
      ['webglGetParameterNative', observed.apis["Object.getOwnPropertyDescriptor(WebGLRenderingContext.prototype, 'getParameter')"].native === true],
      ['permissionsQueryNative', observed.apis["Object.getOwnPropertyDescriptor(Permissions.prototype, 'query')"].native === true],
      ['noPolyfills', observed.polyfillOffenders.length === 0],
      ['noAutomationGlobals', observed.automationGlobals.length === 0],
    ]);
  },
};


export const probes = [windowGeometry, mediaQueries, nativeDescriptors];
