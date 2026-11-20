// Original MV3 fixture content script: exposes the extension id on the document
// so the scenario can confirm the content-script path actually ran.

document.documentElement.dataset.labExtensionId = chrome.runtime.id;
