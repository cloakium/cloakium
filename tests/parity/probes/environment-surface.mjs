// Environment parity probes: HTTP/JS identity coherence, the navigator
// surface and the permissions model (no device is ever opened).

import { HINTS, PERMISSIONS, invariant, openPage } from './environment-support.mjs';

const httpHeaderCoherence = {
  name: 'environment/http-header-coherence',
  async run({ context, origin }) {
    const page = await openPage(context, `${origin}/`);
    await page.setContent('<!doctype html><html><body></body></html>');
    const observed = await page.evaluate(async (hints) => {
      const parseBrands = (header) => {
        if (!header) return null;
        return [...header.matchAll(/"([^"]+)";v="([^"]+)"/g)]
          .map((match) => ({ brand: match[1], version: match[2] }))
          .sort((a, b) => a.brand.localeCompare(b.brand));
      };
      const headers = await (await fetch('/headers', { cache: 'no-store' })).json();
      const second = await (await fetch('/headers', { cache: 'no-store' })).json();
      const uaData = navigator.userAgentData
        ? { brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform }
        : null;
      let highEntropy = null;
      if (navigator.userAgentData?.getHighEntropyValues) {
        highEntropy = await Promise.race([
          navigator.userAgentData.getHighEntropyValues(hints),
          new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 2000)),
        ]);
      }
      return {
        headers,
        stableAcrossRequests: JSON.stringify(headers) === JSON.stringify(second),
        userAgent: navigator.userAgent,
        fullVersion: navigator.appVersion,
        uaData,
        highEntropy,
        parsed: {
          headerBrands: parseBrands(headers['sec-ch-ua']),
          jsBrands: uaData ? [...uaData.brands].sort((a, b) => a.brand.localeCompare(b.brand)) : null,
          platform: (headers['sec-ch-ua-platform'] || '').replace(/"/g, ''),
          mobile: headers['sec-ch-ua-mobile'] ?? null,
        },
      };
    }, HINTS);
    const parsed = observed.parsed;
    return invariant(observed, [
      ['uaMatchesNavigator', observed.headers['user-agent'] === observed.userAgent],
      ['brandsCoherent', JSON.stringify(parsed.headerBrands) === JSON.stringify(parsed.jsBrands)],
      ['platformCoherent', observed.uaData ? parsed.platform === observed.uaData.platform : true],
      ['mobileCoherent', observed.uaData ? parsed.mobile === (observed.uaData.mobile ? '?1' : '?0') : true],
      ['cookiesNotSent', observed.headers.cookie === undefined],
      ['uaHasNoHeadlessToken', !/Headless/i.test(observed.userAgent)],
    ]);
  },
};

const navigatorSurface = {
  name: 'environment/navigator-surface',
  async run({ context, origin }) {
    const page = await openPage(context, `${origin}/`);
    await page.setContent('<!doctype html><html><body></body></html>');
    const observed = await page.evaluate(async () => {
      const plugins = [...navigator.plugins].map((plugin) => ({
        name: plugin.name,
        filename: plugin.filename,
        description: plugin.description,
        mimeTypes: [...plugin].map((mime) => mime.type).sort(),
      }));
      const mimeTypes = [...navigator.mimeTypes].map((mime) => mime.type).sort();
      const connection = navigator.connection
        ? {
            effectiveType: navigator.connection.effectiveType,
            rttPositive: navigator.connection.rtt > 0,
            downlinkPositive: navigator.connection.downlink > 0,
            saveData: navigator.connection.saveData,
            type: navigator.connection.type ?? null,
          }
        : null;
      let estimate = null;
      try {
        const quota = await navigator.storage.estimate();
        estimate = { quotaGiB: Math.round((quota.quota ?? 0) / 1024 ** 3), usage: quota.usage };
      } catch (error) {
        estimate = { error: error.name };
      }
      return {
        plugins,
        mimeTypes,
        pluginCount: navigator.plugins.length,
        languages: navigator.languages,
        language: navigator.language,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory ?? null,
        maxTouchPoints: navigator.maxTouchPoints,
        pdfViewerEnabled: navigator.pdfViewerEnabled,
        cookieEnabled: navigator.cookieEnabled,
        doNotTrack: navigator.doNotTrack,
        globalPrivacyControl: navigator.globalPrivacyControl ?? null,
        onLine: navigator.onLine,
        connection,
        estimate,
        userAgentData: navigator.userAgentData
          ? {
              brands: navigator.userAgentData.brands,
              mobile: navigator.userAgentData.mobile,
              platform: navigator.userAgentData.platform,
            }
          : null,
        vendor: navigator.vendor,
        product: navigator.product,
        appName: navigator.appName,
        appCodeName: navigator.appCodeName,
        webdriver: navigator.webdriver,
        mediaDevices: navigator.mediaDevices
          ? { present: true, supportedConstraints: Object.keys(navigator.mediaDevices.getSupportedConstraints()).sort() }
          : { present: false },
        webgpu: 'gpu' in navigator,
        userActivation: navigator.userActivation
          ? { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive }
          : null,
        scheduling: typeof navigator.scheduling?.isInputPending,
        bluetooth: 'bluetooth' in navigator,
        hid: 'hid' in navigator,
        serial: 'serial' in navigator,
        usb: 'usb' in navigator,
      };
    });
    return invariant(observed, [
      ['localeApplied', observed.language === 'en-US' && observed.languages[0] === 'en-US'],
      ['platformNonEmpty', typeof observed.platform === 'string' && observed.platform.length > 0],
      ['hardwareConcurrencyPositive', observed.hardwareConcurrency > 0],
      ['pluginsConsistentWithMimes', observed.pluginCount === observed.plugins.length],
      ['uaDataPresent', observed.userAgentData !== null],
      ['vendorIsGoogle', observed.vendor === 'Google Inc.'],
    ]);
  },
};

const permissionsNoDevice = {
  name: 'environment/permissions-no-device',
  async run({ context, origin }) {
    const page = await openPage(context, `${origin}/`);
    await page.setContent('<!doctype html><html><body></body></html>');
    const observed = await page.evaluate(async (names) => {
      const states = {};
      for (const name of names) {
        try {
          const status = await navigator.permissions.query({ name });
          states[name] = { state: status.state };
        } catch (error) {
          states[name] = { error: error.name };
        }
      }
      return {
        states,
        notificationPermission: typeof Notification !== 'undefined' ? Notification.permission : null,
        hasGetUserMedia: typeof navigator.mediaDevices?.getUserMedia === 'function',
        hasEnumerateDevices: typeof navigator.mediaDevices?.enumerateDevices === 'function',
        clipboard: {
          readText: typeof navigator.clipboard?.readText,
          writeText: typeof navigator.clipboard?.writeText,
        },
        secureContext: isSecureContext,
      };
    }, PERMISSIONS);
    const captured = ['camera', 'microphone'];
    const optional = ['local-fonts', 'window-management', 'storage-access', 'midi'];
    return invariant(observed, [
      ['noDeviceGranted', captured.every((name) => observed.states[name]?.state !== 'granted')],
      ['geolocationNotGranted', observed.states.geolocation?.state !== 'granted'],
      ['notificationDefault', observed.notificationPermission === 'default'],
      [
        'requiredPermissionQueriesAnswered',
        PERMISSIONS.filter((name) => !optional.includes(name)).every((name) => observed.states[name].state !== undefined),
      ],
      ['clipboardApiPresent', observed.clipboard.readText === 'function' && observed.clipboard.writeText === 'function'],
    ]);
  },
};


export const probes = [httpHeaderCoherence, navigatorSurface, permissionsNoDevice];
