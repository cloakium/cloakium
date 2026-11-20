// Capability presence and cross-API coherence.
//
// Records a broad inventory of public API surfaces (Bluetooth, HID, Serial, USB,
// Share, Clipboard, OPFS, WebTransport, WebSocket, RTC, Permissions, MediaSession,
// Scheduling) and asserts only internal consistency: paired APIs appear together,
// nothing is granted or prompted, and the secure-context requirement holds.

import { finish, prepare, recorder } from '../support/common.mjs';

const probe = {
  id: 'api-capability-presence',
  family: 'api',
  budgetMs: 12_000,
  contract: {
    origin: 'loopback (secure context)',
    crossOrigin: 'not-used',
    routes: [],
    permissions: [],
    activation: 'none',
    viewport: 'any',
    notes: 'Presence and permission state only; no device, share, or clipboard call is made.',
    checks: [
      'presence/secure-context',
      'presence/rtc-present',
      'presence/clipboard-api',
      'presence/share-consistent',
      'presence/notification-default',
      'presence/permissions-query',
      'presence/opfs-available',
      'presence/webtransport-consistent',
      'presence/storage-apis'
    ]
  },

  async run({ page, origin }) {
    const rec = recorder();
    await prepare(page, origin);

    const observed = await page.evaluate(async () => {
      const kind = (value) => typeof value;
      const inventory = {
        bluetooth: 'bluetooth' in navigator,
        usb: 'usb' in navigator,
        hid: 'hid' in navigator,
        serial: 'serial' in navigator,
        share: kind(navigator.share),
        canShare: kind(navigator.canShare),
        clipboardRead: kind(navigator.clipboard?.readText),
        clipboardWrite: kind(navigator.clipboard?.writeText),
        geolocation: kind(navigator.geolocation?.getCurrentPosition),
        wakeLock: 'wakeLock' in navigator,
        locks: kind(navigator.locks?.request),
        serviceWorker: 'serviceWorker' in navigator,
        opfs: kind(navigator.storage?.getDirectory),
        mediaSession: 'mediaSession' in navigator,
        virtualKeyboard: 'virtualKeyboard' in navigator,
        gpu: 'gpu' in navigator,
        xr: 'xr' in navigator,
        credentials: kind(navigator.credentials?.get),
        permissions: kind(navigator.permissions?.query),
        userActivation: 'userActivation' in navigator,
        scheduling: kind(navigator.scheduling?.isInputPending),
        connection: 'connection' in navigator,
        deviceMemory: 'deviceMemory' in navigator,
        hardwareConcurrency: 'hardwareConcurrency' in navigator,
        notification: typeof Notification,
        paymentRequest: typeof PaymentRequest,
        webTransport: typeof WebTransport,
        webSocket: typeof WebSocket,
        rtcPeerConnection: typeof RTCPeerConnection,
        indexedDB: typeof indexedDB,
        caches: typeof caches,
        pushManager: typeof PushManager,
        cookieStore: typeof cookieStore
      };

      let canShareResult = null;      if (typeof navigator.canShare === 'function') {
        try {
          canShareResult = navigator.canShare({ text: 'cloakium probe' });
        } catch (error) {
          canShareResult = { error: error.name };
        }
      }

      let permissionState = null;
      let permissionError = null;
      if (navigator.permissions?.query) {
        try {
          const status = await navigator.permissions.query({ name: 'geolocation' });
          permissionState = status.state;
        } catch (error) {
          permissionError = error.name;
        }
      }

      return {
        secureContext: isSecureContext,
        inventory,
        storageApis: {
          indexedDBOpen: typeof self.indexedDB?.open === 'function',
          cachesOpen: typeof self.caches?.open === 'function',
          serviceWorker: 'serviceWorker' in navigator
        },
        canShareResult,
        permissionState,
        permissionError,
        notificationPermission: typeof Notification !== 'undefined' ? Notification.permission : null,
        origin: location.origin,
        opaqueOrigin: location.origin === 'null'
      };
    });

    rec.expect('presence/secure-context', observed.secureContext === true && observed.opaqueOrigin === false, {
      origin: observed.origin,
      secureContext: observed.secureContext
    });
    rec.expect('presence/rtc-present', observed.inventory.rtcPeerConnection === 'function');
    rec.expect(
      'presence/clipboard-api',
      observed.inventory.clipboardRead === 'function' && observed.inventory.clipboardWrite === 'function',
      { read: observed.inventory.clipboardRead, write: observed.inventory.clipboardWrite }
    );
    if (observed.inventory.share === 'undefined') {
      rec.unknown('presence/share-consistent', 'navigator.share absent');
      rec.limit('web-share-absent', 'navigator.share is not exposed on this platform');
    } else {
      rec.expect(
        'presence/share-consistent',
        observed.inventory.canShare === 'function' && typeof observed.canShareResult === 'boolean',
        { share: observed.inventory.share, canShare: observed.inventory.canShare, canShareResult: observed.canShareResult }
      );
    }
    rec.expect('presence/notification-default', observed.notificationPermission === 'default', {
      permission: observed.notificationPermission
    });
    if (observed.permissionState === null) {
      rec.unknown('presence/permissions-query', observed.permissionError);
      rec.limit('permissions-query-failed', observed.permissionError);
    } else {
      rec.expect(
        'presence/permissions-query',
        ['granted', 'denied', 'prompt'].includes(observed.permissionState),
        observed.permissionState
      );
    }
    rec.expect('presence/opfs-available', observed.inventory.opfs === 'function');
    rec.expect(
      'presence/webtransport-consistent',
      observed.inventory.webTransport === 'function' && observed.inventory.webSocket === 'function',
      { webTransport: observed.inventory.webTransport, webSocket: observed.inventory.webSocket }
    );
    rec.expect(
      'presence/storage-apis',
      observed.storageApis.indexedDBOpen === true &&
        observed.storageApis.cachesOpen === true &&
        observed.storageApis.serviceWorker === true,
      observed.storageApis
    );

    return finish(rec, observed);
  }
};

export const probes = [probe].map((entry) => ({
  ...entry,
  timeoutMs: entry.timeoutMs ?? entry.budgetMs,
  contextOptions: entry.contextOptions ?? {}
}));
