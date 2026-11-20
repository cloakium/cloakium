// Original MV3 fixture service worker. Exposes one observable marker and answers
// one local message; it performs no network access and stores nothing.

globalThis.LAB_MARKER = 'profile-lifecycle-extension-marker-v1';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'lab-ping') {
    sendResponse({ marker: globalThis.LAB_MARKER, id: chrome.runtime.id });
  }
  return false;
});
