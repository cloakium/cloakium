// Upload, download, popup, dialog, fullscreen, pointer-lock and touch probes.
import fs from 'node:fs';
import {
  allTrusted,
  artifactFile,
  assertThat,
  assertTrusted,
  closePage,
  eventsOf,
  openPage,
  pageProbe,
  readLog,
} from './interactions-support.mjs';
import {
  dialogsDoc,
  downloadDoc,
  fileUploadDoc,
  fullscreenDoc,
  pointerLockDoc,
  popupDoc,
  touchDoc,
  viewportDoc,
} from './interactions-fixtures.mjs';

const fileUpload = pageProbe('interactions/file-upload', fileUploadDoc, async ({ page, artifactDir }) => {
  const pathA = artifactFile(artifactDir, 'interactions/file-upload', 'upload-a.txt');
  const pathB = artifactFile(artifactDir, 'interactions/file-upload', 'upload-b.txt');
  fs.writeFileSync(pathA, 'alpha');
  fs.writeFileSync(pathB, 'beta');

  const input = page.locator('#files');
  await input.setInputFiles([pathA, pathB]);
  const selected = await page.evaluate(() => {
    const files = Array.from(document.getElementById('files').files);
    return {
      value: document.getElementById('files').value,
      files: files.map((file) => ({ name: file.name, size: file.size, type: file.type })),
    };
  });
  const firstChange = (await readLog(page)).filter((entry) => entry.type === 'change').at(-1);
  assertThat(firstChange, 'path upload must emit a change event');

  await input.setInputFiles([]);
  const cleared = await page.evaluate(() => document.getElementById('files').files.length);
  const clearChange = (await readLog(page)).filter((entry) => entry.type === 'change').at(-1);
  assertThat(clearChange, 'clearing the file input must emit a change event');

  await input.setInputFiles({ name: 'mem.txt', mimeType: 'text/plain', buffer: Buffer.from('gamma') });
  const memorySelected = await page.evaluate(() => {
    const files = Array.from(document.getElementById('files').files);
    return { count: files.length, names: files.map((file) => file.name), sizes: files.map((file) => file.size) };
  });
  const memoryChange = (await readLog(page)).filter((entry) => entry.type === 'change').at(-1);
  assertThat(memoryChange, 'buffer upload must emit a change event');

  assertThat(selected.files.length === 2, 'two path files must be selected', selected);
  assertThat(selected.files[0].name === 'upload-a.txt' && selected.files[0].size === 5, 'first upload metadata', selected.files[0]);
  assertThat(selected.files[1].name === 'upload-b.txt' && selected.files[1].size === 4, 'second upload metadata', selected.files[1]);
  assertThat(selected.files.every((file) => file.type === 'text/plain'), 'uploaded files must keep their MIME type', selected.files);
  assertThat(selected.value.endsWith('upload-a.txt'), 'file input value must expose selected filenames', selected.value);
  assertThat(firstChange.fileCount === 2 && firstChange.names === 'upload-a.txt,upload-b.txt', 'change event must observe both files', firstChange);
  assertThat(firstChange.trusted === true, 'path-based file upload change must be trusted', firstChange);
  assertThat(cleared === 0, 'setInputFiles([]) must clear the selection', cleared);
  assertThat(clearChange.fileCount === 0 && clearChange.target === 'files', 'clear change event must observe an empty selection', clearChange);
  assertThat(memorySelected.count === 1 && memorySelected.names[0] === 'mem.txt' && memorySelected.sizes[0] === 5, 'buffer upload metadata', memorySelected);
  assertThat(memoryChange.fileCount === 1 && memoryChange.names === 'mem.txt', 'buffer change event must observe the in-memory file', memoryChange);
  assertThat(await page.locator('#summary').textContent() === 'count=1', 'fixture summary must match the last upload', await page.locator('#summary').textContent());

  return {
    selected,
    firstChange: { fileCount: firstChange.fileCount, names: firstChange.names, sizes: firstChange.sizes, types: firstChange.types, trusted: firstChange.trusted },
    cleared,
    clearChangeTrusted: clearChange.trusted,
    memorySelected,
    memoryChangeTrusted: memoryChange.trusted,
  };
});

const download = pageProbe('interactions/download', downloadDoc, async ({ page, artifactDir }) => {
  await page.waitForFunction(() => window.__downloadReady === true);

  const blobPromise = page.waitForEvent('download');
  await page.locator('#download').click();
  const blobDownload = await blobPromise;
  const blobSaved = artifactFile(artifactDir, 'interactions/download', 'hello.txt');
  await blobDownload.saveAs(blobSaved);
  const blobPayload = fs.readFileSync(blobSaved, 'utf8');
  const blobFailure = await blobDownload.failure();
  const blobFilename = blobDownload.suggestedFilename();
  const blobScheme = String(blobDownload.url()).split(':')[0];

  const serverPromise = page.waitForEvent('download');
  await page.locator('#server-download').click();
  const serverDownload = await serverPromise;
  const serverSaved = artifactFile(artifactDir, 'interactions/download', 'parity.txt');
  await serverDownload.saveAs(serverSaved);
  const serverPayload = fs.readFileSync(serverSaved, 'utf8');
  const serverFailure = await serverDownload.failure();
  const serverFilename = serverDownload.suggestedFilename();
  const serverScheme = String(serverDownload.url()).split(':')[0];

  assertThat(blobFilename === 'hello.txt', 'blob download must keep the declared filename', blobFilename);
  assertThat(blobScheme === 'blob', 'blob download URL expected', blobScheme);
  assertThat(blobFailure === null, 'blob download must not fail', blobFailure);
  assertThat(blobPayload === 'cloakium-download-payload', 'blob bytes must match', blobPayload);
  assertThat(serverFilename === 'parity.txt', 'Content-Disposition filename must be used', serverFilename);
  assertThat(serverScheme === 'http' || serverScheme === 'https', 'server download must use the loopback origin', serverScheme);
  assertThat(serverFailure === null, 'server download must not fail', serverFailure);
  assertThat(serverPayload === 'Cloakium parity download\n', 'server download body must match', serverPayload);

  return {
    blob: { suggestedFilename: blobFilename, scheme: blobScheme, failure: blobFailure, payload: blobPayload, savedBytes: blobPayload.length },
    server: { suggestedFilename: serverFilename, scheme: serverScheme, failure: serverFailure, payload: serverPayload, savedBytes: serverPayload.length },
  };
});

const popup = {
  name: 'interactions/popup-visibility',
  timeoutMs: 30000,
  async run({ context, origin }) {
    const page = await openPage(context, origin, popupDoc);
    let opened = null;
    try {
      const popupPromise = page.waitForEvent('popup');
      await page.locator('#open-popup').click();
      opened = await popupPromise;
      await opened.waitForLoadState('load');
      const popupState = await opened.evaluate(() => ({
        opener: window.opener !== null,
        marker: window.__marker || null,
        text: document.getElementById('popup-text') ? document.getElementById('popup-text').textContent : null,
        button: document.getElementById('popup-button') ? document.getElementById('popup-button').textContent : null,
        url: location.href,
      }));
      const roundtrip = await opened.evaluate(() => {
        window.opener.__fromPopup = 'popup-to-main';
        return window.opener !== null && window.opener !== window;
      });
      const mainSawRoundtrip = await page.evaluate(() => window.__fromPopup || null);

      await page.bringToFront();
      const afterMainFront = {
        mainVisibility: await page.evaluate(() => document.visibilityState),
        popupVisibility: await opened.evaluate(() => document.visibilityState),
        mainHasFocus: await page.evaluate(() => document.hasFocus()),
      };
      await opened.bringToFront();
      const afterPopupFront = {
        mainVisibility: await page.evaluate(() => document.visibilityState),
        popupVisibility: await opened.evaluate(() => document.visibilityState),
        popupHasFocus: await opened.evaluate(() => document.hasFocus()),
      };

      assertThat(popupState.opener === true, 'popup must retain window.opener', popupState);
      assertThat(popupState.text === 'popup ready' && popupState.button === 'Popup button', 'popup DOM written by the opener must render', popupState);
      assertThat(popupState.marker === 'popup-marker', 'popup must expose the opener-assigned marker', popupState);
      assertThat(roundtrip === true, 'popup and opener must share one same-origin window relationship', roundtrip);
      assertThat(mainSawRoundtrip === 'popup-to-main', 'popup must be able to write into the opener', mainSawRoundtrip);
      assertThat(afterMainFront.mainVisibility === 'visible', 'bringToFront must make the main page visible', afterMainFront);
      assertThat(afterPopupFront.popupVisibility === 'visible', 'bringToFront must make the popup visible', afterPopupFront);
      assertThat(afterPopupFront.popupHasFocus === true, 'fronted popup must hold focus', afterPopupFront);

      return {
        popupState,
        roundtrip,
        mainSawRoundtrip,
        afterMainFront,
        afterPopupFront,
        mainClickTrusted: (await readLog(page)).filter((entry) => entry.type === 'click').every((entry) => entry.trusted === true),
      };
    } finally {
      await closePage(opened);
      await closePage(page);
    }
  },
};

const dialogs = {
  name: 'interactions/dialogs',
  timeoutMs: 30000,
  async run({ context, origin }) {
    const page = await openPage(context, origin, dialogsDoc);
    const seen = [];
    let confirmMode = 'accept';
    page.on('dialog', async (dialog) => {
      seen.push({ type: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue() });
      if (dialog.type() === 'confirm' && confirmMode === 'dismiss') await dialog.dismiss();
      else if (dialog.type() === 'prompt') await dialog.accept('accepted-text');
      else await dialog.accept();
    });
    try {
      await page.locator('#alert').click();
      await page.waitForFunction(() => window.__results.afterAlert === 'after-alert');
      const alertResult = await page.evaluate(() => ({ alert: window.__results.alert === undefined ? 'undefined' : String(window.__results.alert), after: window.__results.afterAlert }));
      const afterText = await page.locator('#after').textContent();

      await page.locator('#confirm').click();
      await page.waitForFunction(() => window.__results.confirm !== undefined);
      const confirmAccepted = await page.evaluate(() => window.__results.confirm);

      confirmMode = 'dismiss';
      await page.locator('#confirm').click();
      await page.waitForFunction(() => window.__results.confirm !== true);
      const confirmDismissed = await page.evaluate(() => window.__results.confirm);

      await page.locator('#prompt').click();
      await page.waitForFunction(() => window.__results.prompt !== undefined);
      const promptResult = await page.evaluate(() => window.__results.prompt);

      assertThat(alertResult.alert === 'undefined' && alertResult.after === 'after-alert' && afterText === 'after-alert', 'alert must block then continue the handler', { alertResult, afterText });
      assertThat(confirmAccepted === true, 'accepted confirm must return true', confirmAccepted);
      assertThat(confirmDismissed === false, 'dismissed confirm must return false', confirmDismissed);
      assertThat(promptResult === 'accepted-text', 'accepted prompt must return the supplied text', promptResult);
      assertThat(JSON.stringify(seen) === JSON.stringify([
        { type: 'alert', message: 'alert-message', defaultValue: '' },
        { type: 'confirm', message: 'confirm-message', defaultValue: '' },
        { type: 'confirm', message: 'confirm-message', defaultValue: '' },
        { type: 'prompt', message: 'prompt-message', defaultValue: 'default-text' },
      ]), 'dialog event sequence must match', seen);

      return { seen, alertResult, confirmAccepted, confirmDismissed, promptResult, dialogCount: seen.length };
    } finally {
      await closePage(page);
    }
  },
};

const fullscreen = {
  name: 'interactions/fullscreen',
  timeoutMs: 30000,
  async run({ context, origin }) {
    const page = await openPage(context, origin, fullscreenDoc);
    try {
      await page.locator('#fs-start').click();
      await page.waitForFunction(() => window.__fs.state !== 'pending' && window.__fs.state !== 'idle');
      await page.waitForFunction(() => window.__fsChanges >= 1);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const request = await page.evaluate(() => window.__fs);
      const active = await page.evaluate(() => ({
        element: document.fullscreenElement ? document.fullscreenElement.id : null,
        enabled: document.fullscreenEnabled,
      }));
      const viewport = await page.evaluate(() => ({
        innerWidth,
        innerHeight,
        screenWidth: screen.width,
        screenHeight: screen.height,
        devicePixelRatio,
      }));

      assertThat(request.state === 'fulfilled' || request.state === 'void', 'requestFullscreen must be accepted from a trusted click', request);
      assertThat(request.state !== 'rejected' && request.state !== 'threw', 'requestFullscreen must not reject', request);
      assertThat(active.element === 'fs-target', 'the requested element must become the fullscreen element', active);
      assertThat(active.enabled === true, 'fullscreenEnabled must be true', active);

      await page.evaluate(() => document.exitFullscreen());
      await page.waitForFunction(() => document.fullscreenElement === null);
      await page.waitForFunction(() => window.__fsChanges >= 2);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const log = await readLog(page);
      const changes = eventsOf(log, 'fullscreenchange');

      assertThat(changes.length >= 2, 'enter and exit must each emit fullscreenchange', changes);
      assertThat(allTrusted(changes), 'fullscreenchange events must be trusted', changes);
      assertThat(changes[0].fullscreenElement === 'fs-target' || changes[0].laterElement === 'fs-target', 'enter transition must expose the fullscreen element', changes[0]);
      assertThat(changes.at(-1).fullscreenElement === null && changes.at(-1).laterElement === null, 'exit transition must clear the fullscreen element', changes.at(-1));

      return {
        request,
        active,
        viewport,
        changes: changes.map((entry) => ({
          index: entry.transitionIndex,
          syncElement: entry.fullscreenElement,
          laterElement: entry.laterElement === undefined ? null : entry.laterElement,
          enabled: entry.enabled,
          trusted: entry.trusted,
        })),
        changeCount: changes.length,
        afterExit: await page.evaluate(() => document.fullscreenElement === null),
      };
    } finally {
      await closePage(page);
    }
  },
};

const fullscreenViewport = pageProbe('interactions/window-geometry-emulated', viewportDoc, async ({ page }) => {
  const metrics = await page.evaluate(() => {
    const visual = window.visualViewport;
    return {
      fullscreenElement: document.fullscreenElement ? document.fullscreenElement.id : null,
      fullscreenEnabled: document.fullscreenEnabled,
      innerWidth,
      innerHeight,
      visual: visual ? { width: visual.width, height: visual.height, scale: visual.scale } : null,
      screen: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        colorDepth: screen.colorDepth,
        pixelDepth: screen.pixelDepth,
      },
      window: { outerWidth, outerHeight, screenX, screenY, screenLeft, screenTop },
      scrollingElement: { clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight },
    };
  });
  assertThat(metrics.fullscreenElement === null, 'no fullscreen element before an explicit request', metrics);
  assertThat(metrics.fullscreenEnabled === true, 'fullscreenEnabled must be true', metrics);
  assertThat(metrics.innerWidth === 1000 && metrics.innerHeight === 700, 'CDP viewport must be 1000x700', metrics);
  assertThat(metrics.visual && metrics.visual.width === metrics.innerWidth && metrics.visual.height === metrics.innerHeight, 'visual viewport must match the CDP viewport', metrics);
  assertThat(metrics.screen.width > 0 && metrics.screen.height > 0 && metrics.screen.availWidth > 0 && metrics.screen.availHeight > 0, 'screen bounds must be positive', metrics);
  assertThat(metrics.window.outerWidth > 0 && metrics.window.outerHeight > 0, 'outer window bounds must be positive', metrics);
  return metrics;
});

const fullscreenNativeBounds = pageProbe('interactions/window-geometry-native', viewportDoc, async ({ page }) => {
  const metrics = await page.evaluate(() => {
    const visual = window.visualViewport;
    return {
      fullscreenElement: document.fullscreenElement ? document.fullscreenElement.id : null,
      fullscreenEnabled: document.fullscreenEnabled,
      innerWidth,
      innerHeight,
      visual: visual ? { width: visual.width, height: visual.height, scale: visual.scale } : null,
      screen: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        availLeft: screen.availLeft,
        availTop: screen.availTop,
        colorDepth: screen.colorDepth,
        pixelDepth: screen.pixelDepth,
      },
      window: { outerWidth, outerHeight, screenX, screenY, screenLeft, screenTop },
      scrollingElement: { clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight },
    };
  });
  assertThat(metrics.fullscreenElement === null, 'no fullscreen element before an explicit request', metrics);
  assertThat(metrics.fullscreenEnabled === true, 'fullscreenEnabled must be true', metrics);
  assertThat(metrics.innerWidth > 0 && metrics.innerHeight > 0, 'window viewport must be positive', metrics);
  assertThat(metrics.visual && metrics.visual.width === metrics.innerWidth && metrics.visual.height === metrics.innerHeight, 'visual viewport must match the window', metrics);
  assertThat(metrics.screen.width > 0 && metrics.screen.height > 0 && metrics.screen.availWidth > 0 && metrics.screen.availHeight > 0, 'screen bounds must be positive', metrics);
  assertThat(metrics.window.outerWidth > 0 && metrics.window.outerHeight > 0, 'outer window bounds must be positive', metrics);
  return metrics;
}, { contextOptions: { viewport: null } });

const pointerLock = {
  name: 'interactions/pointer-lock',
  timeoutMs: 30000,
  diagnostics: {
    startupDiagnostic: 'physical headed cursor warp after lock vs virtual CDP origin; requested relative moves after controlled initialization remain compared',
  },
  async run({ context, origin }) {
    const page = await openPage(context, origin, pointerLockDoc);
    try {
      await page.locator('#pl-start').click();
      await page.waitForFunction(() => window.__pl.state !== 'pending' && window.__pl.state !== 'idle');
      const request = await page.evaluate(() => window.__pl);
      const locked = await page.evaluate(() => (document.pointerLockElement ? document.pointerLockElement.id : null));

      assertThat(request.state === 'fulfilled' || request.state === 'void', 'requestPointerLock must be accepted from a trusted click', request);
      assertThat(request.state !== 'rejected' && request.state !== 'threw', 'requestPointerLock must not fail', request);
      assertThat(locked === 'pl-canvas', 'the requested canvas must be pointer-locked', locked);

      // Pointer lock warps the OS cursor to the viewport centre in headed mode
      // and reports that warp as a move; headless starts from the last CDP
      // position. Settle at the centre, then measure only the requested moves.
      const centre = await page.evaluate(() => ({ x: Math.floor(innerWidth / 2), y: Math.floor(innerHeight / 2) }));
      await page.mouse.move(centre.x, centre.y);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const startupLog = await readLog(page);
      const startupCount = startupLog.length;
      const startupMoves = eventsOf(startupLog, 'mousemove').map((entry) => ({
        movementX: entry.movementX,
        movementY: entry.movementY,
        pointerLockElement: entry.pointerLockElement,
        trusted: entry.trusted,
      }));

      const first = { x: centre.x + 100, y: centre.y + 50 };
      const second = { x: first.x + 20, y: first.y + 10 };
      await page.mouse.move(first.x, first.y);
      await page.mouse.move(second.x, second.y);
      await page.evaluate(() => document.exitPointerLock());
      await page.waitForFunction(() => document.pointerLockElement === null);
      const log = await readLog(page);
      const measured = log.slice(startupCount);
      const moves = eventsOf(measured, 'mousemove').filter((entry) => entry.pointerLockElement === 'pl-canvas');
      const changes = eventsOf(log, 'pointerlockchange');
      const released = await page.evaluate(() => window.__pl);

      assertThat(startupMoves.length > 0, 'the lock baseline must observe at least one mouse move', startupMoves);
      assertThat(allTrusted(startupMoves), 'lock baseline moves must be trusted', startupMoves);
      assertThat(moves.length === 2, 'two requested moves after the lock baseline must be observed', moves);
      assertThat(moves[0].movementX === 100 && moves[0].movementY === 50, 'first requested move must report its delta from the viewport centre', moves[0]);
      assertThat(moves[1].movementX === 20 && moves[1].movementY === 10, 'second requested move must report its delta', moves[1]);
      assertThat(allTrusted(moves), 'measured moves must be trusted', moves);
      assertTrusted(changes, 'pointerlockchange');
      assertThat(changes[0].pointerLockElement === 'pl-canvas' && changes.at(-1).pointerLockElement === null, 'pointerlockchange must expose lock and release', changes);
      assertThat(released.state === 'released', 'exitPointerLock must release the pointer', released);

      return {
        request,
        locked,
        centre,
        moves: moves.map((entry) => ({ movementX: entry.movementX, movementY: entry.movementY, trusted: entry.trusted })),
        startupDiagnostic: startupMoves,
        changes: changes.map((entry) => ({ element: entry.pointerLockElement, trusted: entry.trusted })),
        released,
      };
    } finally {
      await closePage(page);
    }
  },
};

const touch = pageProbe('interactions/touch', touchDoc, async ({ page }) => {
  await page.locator('#tap-target').tap();
  const log = await readLog(page);
  const counts = await page.evaluate(() => window.__taps);
  const pointerDown = eventsOf(log, 'pointerdown').at(-1);
  const pointerUp = eventsOf(log, 'pointerup').at(-1);
  assertThat(pointerDown && pointerUp, 'tap must emit pointerdown and pointerup', { pointerDown, pointerUp });

  assertThat(counts.click === 1 && counts.touchstart === 1 && counts.touchend === 1, 'one tap must emit one touch and click sequence', counts);
  assertThat(pointerDown.pointerType === 'touch' && pointerUp.pointerType === 'touch', 'pointer events must be touch-typed', { pointerDown, pointerUp });
  assertThat(pointerDown.id === 'tap-target', 'pointerdown must target the tapped element', pointerDown);
  assertTrusted(eventsOf(log, 'touchstart'), 'touchstart');
  assertTrusted(eventsOf(log, 'touchend'), 'touchend');
  assertTrusted(eventsOf(log, 'pointerdown'), 'pointerdown');
  assertTrusted(eventsOf(log, 'click'), 'click');

  return {
    counts,
    pointerDown: { id: pointerDown.id, pointerType: pointerDown.pointerType, trusted: pointerDown.trusted },
    pointerUp: { pointerType: pointerUp.pointerType, trusted: pointerUp.trusted },
    trusted: {
      touchstart: allTrusted(eventsOf(log, 'touchstart')),
      touchend: allTrusted(eventsOf(log, 'touchend')),
      pointerdown: allTrusted(eventsOf(log, 'pointerdown')),
      pointerup: allTrusted(eventsOf(log, 'pointerup')),
      click: allTrusted(eventsOf(log, 'click')),
    },
  };
}, { contextOptions: { hasTouch: true } });


export const windowProbes = [fileUpload, download, popup, dialogs, fullscreen, fullscreenViewport, fullscreenNativeBounds, pointerLock, touch];
