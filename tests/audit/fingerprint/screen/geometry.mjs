// Screen, window and visual-viewport geometry.
//
// Deliberately tolerant of driver/window-manager framing: the driver may emulate
// focus or an in-tab fullscreen, which is not an OS bug and not a fingerprint
// defect. Only grossly impossible geometry fails; ambiguous framing is reported
// as coverage-unknown with the raw numbers attached.

import { finish, prepare, recorder } from '../support/common.mjs';

const probe = {
  id: 'screen-geometry',
  family: 'screen',
  budgetMs: 12_000,
  contract: {
    origin: 'loopback',
    crossOrigin: 'not-used',
    routes: [],
    permissions: [],
    activation: 'none',
    viewport: 'any',
    notes: 'Tolerance for window chrome, focus emulation and maximised launches; no exact viewport is assumed.',
    checks: [
      'screen/avail-within-bounds',
      'screen/avail-height-realistic',
      'screen/color-depth-consistent',
      'screen/orientation-valid',
      'screen/orientation-matches-dimensions',
      'screen/dpr-positive-finite',
      'screen/physical-resolution-plausible',
      'screen/inner-within-screen',
      'screen/outer-not-smaller-than-half-inner',
      'screen/visual-viewport-scale',
      'screen/visual-viewport-within-layout',
      'screen/window-position-numeric',
      'screen/read-stable'
    ]
  },

  async run({ page, origin }) {
    const rec = recorder();
    await prepare(page, origin);

    const read = () =>
      page.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        const viewport = window.visualViewport;
        return {
          screen: {
            width: screen.width,
            height: screen.height,
            availWidth: screen.availWidth,
            availHeight: screen.availHeight,
            availLeft: screen.availLeft ?? null,
            availTop: screen.availTop ?? null,
            colorDepth: screen.colorDepth,
            pixelDepth: screen.pixelDepth,
            isExtended: screen.isExtended ?? null,
            orientation: screen.orientation
              ? { type: screen.orientation.type, angle: screen.orientation.angle }
              : null
          },
          window: {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            outerWidth: window.outerWidth,
            outerHeight: window.outerHeight,
            devicePixelRatio: window.devicePixelRatio,
            screenX: window.screenX,
            screenY: window.screenY,
            screenLeft: window.screenLeft,
            screenTop: window.screenTop
          },
          visualViewport: viewport
            ? {
                width: viewport.width,
                height: viewport.height,
                scale: viewport.scale,
                offsetLeft: viewport.offsetLeft,
                offsetTop: viewport.offsetTop,
                pageLeft: viewport.pageLeft,
                pageTop: viewport.pageTop
              }
            : null,
          documentElement: {
            clientWidth: document.documentElement.clientWidth,
            clientHeight: document.documentElement.clientHeight
          }
        };
      });

    const first = await read();
    const second = await read();

    const s = first.screen;
    const w = first.window;
    const vv = first.visualViewport;

    rec.expect(
      'screen/avail-within-bounds',
      s.availWidth > 0 && s.availHeight > 0 && s.availWidth <= s.width && s.availHeight <= s.height,
      { width: s.width, height: s.height, availWidth: s.availWidth, availHeight: s.availHeight }
    );
    rec.expect(
      'screen/avail-height-realistic',
      s.height > 0 && s.availHeight / s.height >= 0.5,
      { height: s.height, availHeight: s.availHeight }
    );
    rec.expect(
      'screen/color-depth-consistent',
      s.colorDepth === s.pixelDepth && [24, 30, 32].includes(s.colorDepth),
      { colorDepth: s.colorDepth, pixelDepth: s.pixelDepth }
    );
    if (!s.orientation) {
      rec.unknown('screen/orientation-valid', 'screen.orientation is absent');
      rec.unknown('screen/orientation-matches-dimensions', 'screen.orientation is absent');
    } else {
      const validAngle = [0, 90, 180, 270].includes(s.orientation.angle);
      const knownTypes = ['portrait-primary', 'portrait-secondary', 'landscape-primary', 'landscape-secondary'];
      // Angle 0 is the display's natural orientation, which may itself be
      // landscape: the type cannot be derived from the angle alone.
      rec.expect('screen/orientation-valid', validAngle && knownTypes.includes(s.orientation.type), s.orientation);
      const portrait = s.height >= s.width;
      rec.expect(
        'screen/orientation-matches-dimensions',
        s.orientation.type.startsWith(portrait ? 'portrait' : 'landscape'),
        { type: s.orientation.type, width: s.width, height: s.height }
      );
    }
    rec.expect(
      'screen/dpr-positive-finite',
      Number.isFinite(w.devicePixelRatio) && w.devicePixelRatio > 0 && w.devicePixelRatio <= 8,
      w.devicePixelRatio
    );
    rec.expect(
      'screen/physical-resolution-plausible',
      Number.isFinite(w.devicePixelRatio) &&
        s.width * w.devicePixelRatio >= 320 &&
        s.width * w.devicePixelRatio <= 16384 &&
        s.height * w.devicePixelRatio >= 200 &&
        s.height * w.devicePixelRatio <= 16384,
      { width: s.width, height: s.height, dpr: w.devicePixelRatio }
    );
    rec.expect(
      'screen/inner-within-screen',
      w.innerWidth > 0 && w.innerHeight > 0 && w.innerWidth <= s.width + 1 && w.innerHeight <= s.height + 1,
      { innerWidth: w.innerWidth, innerHeight: w.innerHeight }
    );
    if (w.innerWidth > w.outerWidth || w.innerHeight > w.outerHeight) {
      rec.unknown('screen/outer-not-smaller-than-half-inner', {
        innerWidth: w.innerWidth,
        innerHeight: w.innerHeight,
        outerWidth: w.outerWidth,
        outerHeight: w.outerHeight,
        reason: 'framing may be focus-emulated or in-tab fullscreen'
      });
      rec.limit('window-framing-ambiguous', 'inner size exceeds outer size; driver framing, not an OS defect');
    } else {
      rec.expect(
        'screen/outer-not-smaller-than-half-inner',
        w.outerWidth >= w.innerWidth * 0.5 && w.outerHeight >= w.innerHeight * 0.5,
        { innerWidth: w.innerWidth, outerWidth: w.outerWidth }
      );
    }
    if (!vv) {
      rec.unknown('screen/visual-viewport-scale', 'window.visualViewport is absent');
      rec.unknown('screen/visual-viewport-within-layout', 'window.visualViewport is absent');
      rec.limit('visual-viewport-absent', 'window.visualViewport is not exposed');
    } else {
      rec.expect(
        'screen/visual-viewport-scale',
        Number.isFinite(vv.scale) && vv.scale > 0.1 && vv.scale <= 8,
        vv.scale
      );
      if (Math.abs(vv.scale - 1) > 0.01) {
        rec.unknown('screen/visual-viewport-within-layout', { scale: vv.scale, reason: 'page is zoomed' });
      } else {
        rec.expect(
          'screen/visual-viewport-within-layout',
          vv.width > 0 && vv.height > 0 && vv.width <= w.innerWidth + 1 && vv.height <= w.innerHeight + 1,
          { width: vv.width, height: vv.height, innerWidth: w.innerWidth, innerHeight: w.innerHeight }
        );
      }
    }
    rec.expect(
      'screen/window-position-numeric',
      [w.screenX, w.screenY, w.screenLeft, w.screenTop].every((value) => Number.isFinite(value)) &&
        w.screenX === w.screenLeft &&
        w.screenY === w.screenTop,
      { screenX: w.screenX, screenY: w.screenY, screenLeft: w.screenLeft, screenTop: w.screenTop }
    );
    rec.expect('screen/read-stable', JSON.stringify(first) === JSON.stringify(second));

    return finish(rec, { first, second, stable: JSON.stringify(first) === JSON.stringify(second) });
  }
};

export const probes = [probe].map((entry) => ({
  ...entry,
  timeoutMs: entry.timeoutMs ?? entry.budgetMs,
  contextOptions: entry.contextOptions ?? {}
}));
