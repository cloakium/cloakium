// Same-origin and cross-origin iframe interaction probes.
import {
  allTrusted,
  assertThat,
  findFrame,
  frameLog,
  instrumentFrame,
  pageProbe,
} from './interactions-support.mjs';
import { iframeDoc } from './interactions-fixtures.mjs';

const iframeSameOrigin = pageProbe('interactions/iframe-same-origin', '', async ({ page, origin }) => {
  await page.setContent(iframeDoc('frame-same', origin.replace(/\/+$/, '') + '/frame', 'same-frame'), { waitUntil: 'load' });
  const frameLocator = page.frameLocator('#same-frame');
  await frameLocator.locator('#frame-input').waitFor();
  const frame = findFrame(page, origin.replace(/\/+$/, '') + '/frame');
  await instrumentFrame(frame);

  await frameLocator.locator('#frame-input').pressSequentially('frame text');
  await frameLocator.locator('#frame-button').click();
  const inputValue = await frameLocator.locator('#frame-input').inputValue();
  const frameEvents = await frameLog(frame);
  const keydowns = frameEvents.filter((entry) => entry.type === 'keydown');
  const inputs = frameEvents.filter((entry) => entry.type === 'input');
  const clicks = frameEvents.filter((entry) => entry.type === 'click');
  const sameOrigin = await page.evaluate(() => ({
    buttonText: document.getElementById('same-frame').contentDocument.getElementById('frame-button').textContent,
    frameTitle: document.getElementById('same-frame').contentDocument.title,
    activeElement: document.activeElement ? document.activeElement.id : null,
    focusEvents: window.__log.filter((entry) => entry.type === 'focusin').map((entry) => entry.id),
  }));
  const frameView = await frame.evaluate(() => ({
    origin: location.origin,
    pathname: location.pathname,
    parentTitle: window.parent.document.title,
    parentPath: window.parent.location.pathname,
    buttonText: document.getElementById('frame-button').textContent,
    title: document.title,
  }));

  assertThat(inputValue === 'frame text', 'typing inside a same-origin iframe must update its input', inputValue);
  assertThat(keydowns.length > 0 && allTrusted(keydowns), 'iframe keydown events must be trusted', keydowns);
  assertThat(inputs.length > 0 && allTrusted(inputs), 'iframe input events must be trusted', inputs);
  assertThat(clicks.length === 1 && clicks[0].trusted === true && clicks[0].target === 'frame-button', 'iframe click must be trusted and targeted', clicks);
  assertThat(sameOrigin.buttonText === 'Frame button', 'parent must read the same-origin frame DOM', sameOrigin);
  assertThat(sameOrigin.frameTitle === frameView.title && frameView.title.length > 0, 'parent and frame must agree on the frame document title', { parentRead: sameOrigin.frameTitle, frameRead: frameView.title });
  assertThat(frameView.parentTitle === 'frame-same' && frameView.parentPath === '/', 'frame must read the same-origin parent DOM', frameView);
  assertThat(sameOrigin.activeElement === 'same-frame', 'clicking inside the iframe must focus the iframe element in the parent', sameOrigin.activeElement);
  assertThat(frameView.origin === origin.replace(/\/+$/, ''), 'same-origin frame must keep the loopback origin', frameView.origin);
  assertThat(frameView.buttonText === 'Frame button', 'frame must render the served /frame fixture', frameView);

  return {
    inputValue,
    frameOrigin: frameView.origin,
    keydownKeys: keydowns.map((entry) => entry.key),
    keydownTargets: [...new Set(keydowns.map((entry) => entry.target))],
    inputTrusted: allTrusted(inputs),
    click: { count: clicks.length, target: clicks[0].target, trusted: clicks[0].trusted },
    sameOrigin,
    frameView,
  };
});

const iframeCrossOrigin = pageProbe('interactions/iframe-cross-origin', '', async ({ page, origin, crossOrigin }) => {
  const base = origin.replace(/\/+$/, '');
  const cross = crossOrigin.replace(/\/+$/, '');
  await page.setContent(iframeDoc('frame-cross', cross + '/frame', 'cross-frame'), { waitUntil: 'load' });
  const frameLocator = page.frameLocator('#cross-frame');
  await frameLocator.locator('#frame-input').waitFor();
  const frame = findFrame(page, cross + '/frame');
  await instrumentFrame(frame);

  await frameLocator.locator('#frame-input').pressSequentially('frame text');
  await frameLocator.locator('#frame-button').click();
  const inputValue = await frameLocator.locator('#frame-input').inputValue();
  const frameEvents = await frameLog(frame);
  const keydowns = frameEvents.filter((entry) => entry.type === 'keydown');
  const inputs = frameEvents.filter((entry) => entry.type === 'input');
  const clicks = frameEvents.filter((entry) => entry.type === 'click');

  const parentView = await page.evaluate(() => {
    const iframe = document.getElementById('cross-frame');
    const result = {
      contentDocument: iframe.contentDocument === null ? 'null' : 'object',
      documentAccess: null,
      hrefAccess: null,
    };
    try {
      void iframe.contentWindow.document;
      result.documentAccess = 'allowed';
    } catch (error) {
      result.documentAccess = error.name;
    }
    try {
      void iframe.contentWindow.location.href;
      result.hrefAccess = 'allowed';
    } catch (error) {
      result.hrefAccess = error.name;
    }
    return result;
  });
  const frameView = await frame.evaluate(() => {
    const result = { origin: location.origin, buttonText: document.getElementById('frame-button').textContent, parentDocument: null, parentLocation: null };
    try {
      void window.parent.document;
      result.parentDocument = 'allowed';
    } catch (error) {
      result.parentDocument = error.name;
    }
    try {
      void window.parent.location.href;
      result.parentLocation = 'allowed';
    } catch (error) {
      result.parentLocation = error.name;
    }
    return result;
  });

  assertThat(inputValue === 'frame text', 'typing inside a cross-origin iframe must update its input', inputValue);
  assertThat(keydowns.length > 0 && allTrusted(keydowns), 'cross-origin keydown events must be trusted', keydowns);
  assertThat(inputs.length > 0 && allTrusted(inputs), 'cross-origin input events must be trusted', inputs);
  assertThat(clicks.length === 1 && clicks[0].trusted === true && clicks[0].target === 'frame-button', 'cross-origin click must be trusted and targeted', clicks);
  assertThat(parentView.contentDocument === 'null', 'parent must not obtain a cross-origin contentDocument', parentView);
  assertThat(parentView.documentAccess === 'SecurityError' && parentView.hrefAccess === 'SecurityError', 'parent must be denied cross-origin frame document and location', parentView);
  assertThat(frameView.parentDocument === 'SecurityError' && frameView.parentLocation === 'SecurityError', 'frame must be denied parent document and location', frameView);
  assertThat(frameView.origin === cross, 'cross-origin frame must report the localhost origin', frameView.origin);
  assertThat(frameView.buttonText === 'Frame button', 'cross-origin frame must render the served /frame fixture', frameView);

  return {
    inputValue,
    parentOrigin: base,
    frameOrigin: frameView.origin,
    keydownKeys: keydowns.map((entry) => entry.key),
    inputTrusted: allTrusted(inputs),
    click: { count: clicks.length, target: clicks[0].target, trusted: clicks[0].trusted },
    parentView,
    frameView,
  };
});


export const frameProbes = [iframeSameOrigin, iframeCrossOrigin];
