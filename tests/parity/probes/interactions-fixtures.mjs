// Inline fixtures for the interaction probes. Every page is loaded with
// page.setContent after page.goto(origin + '/') so the loopback origin is kept.
import { doc } from './interactions-support.mjs';

export const typingDoc = doc('typing', `
<label for="text">Text</label>
<input id="text" type="text" autocomplete="off" value="">
<p id="mirror"></p>`, `
var input = document.getElementById('text');
__listen(['keydown', 'keyup', 'beforeinput', 'input', 'select'], input, function (entry, event) {
  if (entry.type === 'keydown' || entry.type === 'keyup') {
    entry.key = event.key;
    entry.code = event.code;
    entry.ctrl = event.ctrlKey;
    entry.shift = event.shiftKey;
    entry.alt = event.altKey;
    entry.isComposing = event.isComposing;
  } else if (entry.type === 'select') {
    entry.start = input.selectionStart;
    entry.end = input.selectionEnd;
  } else {
    entry.inputType = event.inputType;
    entry.data = event.data;
    entry.value = input.value;
  }
  document.getElementById('mirror').textContent = input.value;
});
`);

export const shortcutsDoc = doc('shortcuts', `
<form id="form" action="#blocked">
  <input id="field" type="text" autocomplete="off" value="">
  <button id="submit" type="submit">Submit</button>
</form>
<p id="status"></p>`, `
var field = document.getElementById('field');
window.__submitted = 0;
window.__submitTrusted = null;
document.getElementById('form').addEventListener('submit', function (event) {
  event.preventDefault();
  window.__submitted += 1;
  window.__submitTrusted = event.isTrusted === true;
  document.getElementById('status').textContent = 'submitted';
});
__listen(['keydown', 'keyup', 'beforeinput', 'input', 'select'], field, function (entry, event) {
  if (entry.type === 'keydown' || entry.type === 'keyup') {
    entry.key = event.key;
    entry.code = event.code;
    entry.ctrl = event.ctrlKey;
    entry.shift = event.shiftKey;
    entry.alt = event.altKey;
  } else if (entry.type === 'select') {
    entry.start = field.selectionStart;
    entry.end = field.selectionEnd;
  } else {
    entry.inputType = event.inputType;
    entry.data = event.data;
  }
});
`);

export const formControlsDoc = doc('form-controls', `
<input id="check" type="checkbox">
<input id="radio-a" type="radio" name="group" value="a" checked>
<input id="radio-b" type="radio" name="group" value="b">
<select id="select" aria-label="Choice">
  <option value="a">A</option>
  <option value="b">B</option>
  <option value="c">C</option>
</select>
<input id="range" type="range" min="0" max="10" step="1" value="5">
<textarea id="ta" rows="4" cols="20"></textarea>`, `
__listen(['click', 'input', 'change'], document, function (entry, event) {
  var target = event.target;
  if (!target || !target.id) return;
  entry.id = target.id;
  if (target.type === 'checkbox' || target.type === 'radio') entry.checked = target.checked;
  if (target.tagName === 'SELECT') entry.selectValue = target.value;
  if (target.type === 'range') entry.rangeValue = target.value;
  if (target.tagName === 'TEXTAREA') entry.taValue = target.value;
  if (entry.type === 'input' && typeof event.inputType === 'string') entry.inputType = event.inputType;
});
`);

export const focusTabDoc = doc('focus-tab', `
<a id="link" href="#nowhere">Link</a>
<input id="first" type="text">
<input id="disabled" type="text" disabled>
<button id="button" type="button">Button</button>
<div id="box" tabindex="0">Box</div>
<textarea id="last"></textarea>`, `
__listen(['focus', 'blur', 'focusin', 'focusout', 'keydown'], document, function (entry, event) {
  entry.id = (event.target && event.target.id) || null;
  if (entry.type === 'keydown') {
    entry.key = event.key;
    entry.shift = event.shiftKey;
  }
});
`);

export const pointerScrollDoc = doc('pointer-scroll', `
<div id="hover-target">Hover target</div>
<button id="click-target" type="button">Click target</button>
<div id="spacer"></div>
<div id="bottom">Bottom</div>`, `
__listen(['pointerover', 'pointerdown', 'pointerup', 'mouseover', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'scroll', 'mousemove'], document, function (entry, event) {
  entry.id = (event.target && event.target.id) || null;
  if (typeof event.pointerType === 'string') entry.pointerType = event.pointerType;
  if (entry.type === 'mousemove') {
    entry.clientX = event.clientX;
    entry.clientY = event.clientY;
  }
  if (entry.type === 'pointerover') {
    entry.clientX = event.clientX;
    entry.clientY = event.clientY;
    entry.scrollY = window.scrollY;
  }
  if (entry.type === 'pointerdown' || entry.type === 'pointerup' || entry.type === 'mousedown' || entry.type === 'mouseup' || entry.type === 'click' || entry.type === 'dblclick') {
    entry.button = event.button;
  }
  if (entry.type === 'click' || entry.type === 'dblclick') entry.detail = event.detail;
  if (entry.type === 'wheel') {
    entry.deltaY = event.deltaY;
    entry.deltaMode = event.deltaMode;
  }
  if (entry.type === 'scroll') entry.scrollY = window.scrollY;
});
`);

export const dragDropDoc = doc('drag-drop', `
<div id="drag-source" draggable="true">Drag source</div>
<div id="drop-target">Drop target</div>`, `
window.__drop = { text: null, types: null, dropped: false };
__listen(['dragstart', 'dragenter', 'dragover', 'drop', 'dragend'], document, function (entry, event) {
  entry.id = (event.target && event.target.id) || null;
  var data = event.dataTransfer;
  if (entry.type === 'dragstart') {
    data.setData('text/plain', 'cloakium-payload');
    data.effectAllowed = 'copy';
  } else if (entry.type === 'dragover') {
    event.preventDefault();
    data.dropEffect = 'copy';
  } else if (entry.type === 'drop') {
    event.preventDefault();
    window.__drop.text = data.getData('text/plain');
    window.__drop.types = Array.from(data.types).sort().join(',');
    window.__drop.dropped = true;
    event.target.textContent = 'Dropped ' + window.__drop.text;
    event.target.dataset.dropped = 'yes';
  }
});
`);

export const fileUploadDoc = doc('file-upload', `
<input id="files" type="file" multiple accept=".txt">
<p id="summary"></p>`, `
var input = document.getElementById('files');
__listen(['input', 'change'], input, function (entry) {
  var files = Array.from(input.files);
  entry.fileCount = files.length;
  entry.names = files.map(function (file) { return file.name; }).join(',');
  entry.sizes = files.map(function (file) { return file.size; }).join(',');
  entry.types = files.map(function (file) { return file.type; }).join(',');
  document.getElementById('summary').textContent = 'count=' + files.length;
});
`);

export function downloadDoc(origin) {
  const base = origin.replace(/\/+$/, '');
  return doc('download', `
<a id="download" download="hello.txt">Download payload</a>
<br>
<a id="server-download" href="${base}/download">Server download</a>`, `
var anchor = document.getElementById('download');
anchor.href = URL.createObjectURL(new Blob(['cloakium-download-payload'], { type: 'text/plain' }));
window.__downloadReady = true;
`);
}

export const popupDoc = doc('popup', `
<button id="open-popup" type="button">Open popup</button>
<p id="main-status">main</p>`, `
window.__popup = null;
__listen(['click'], document, function (entry, event) {
  entry.id = (event.target && event.target.id) || null;
});
document.getElementById('open-popup').addEventListener('click', function () {
  var popup = window.open('', 'cloakium-popup', 'width=360,height=240');
  window.__popup = popup;
  if (popup) {
    popup.document.title = 'cloakium-popup';
    popup.document.body.innerHTML = '<p id="popup-text">popup ready</p><button id="popup-button" type="button">Popup button</button>';
    popup.__marker = 'popup-marker';
  }
});
`);

export const dialogsDoc = doc('dialogs', `
<button id="alert" type="button">Alert</button>
<button id="confirm" type="button">Confirm</button>
<button id="prompt" type="button">Prompt</button>
<p id="after"></p>`, `
window.__results = {};
document.getElementById('alert').addEventListener('click', function () {
  window.__results.alert = window.alert('alert-message');
  window.__results.afterAlert = document.getElementById('after').textContent = 'after-alert';
});
document.getElementById('confirm').addEventListener('click', function () {
  window.__results.confirm = window.confirm('confirm-message');
});
document.getElementById('prompt').addEventListener('click', function () {
  window.__results.prompt = window.prompt('prompt-message', 'default-text');
});
`);

export const fullscreenDoc = doc('fullscreen', `
<div id="fs-target">target</div>
<button id="fs-start" type="button">Fullscreen</button>`, `
__listen(['fullscreenchange', 'fullscreenerror', 'click'], document, function (entry) {
  entry.fullscreenElement = document.fullscreenElement ? document.fullscreenElement.id : null;
  entry.enabled = document.fullscreenEnabled;
  if (entry.type === 'fullscreenchange') {
    window.__fsChanges += 1;
    entry.transitionIndex = window.__fsChanges;
    requestAnimationFrame(function () {
      entry.laterElement = document.fullscreenElement ? document.fullscreenElement.id : null;
    });
  }
});
window.__fsChanges = 0;
window.__fs = { state: 'idle' };
document.getElementById('fs-start').addEventListener('click', function () {
  var target = document.getElementById('fs-target');
  window.__fs = { state: 'pending' };
  var request;
  try {
    request = target.requestFullscreen();
  } catch (error) {
    window.__fs = { state: 'threw', name: error.name };
    return;
  }
  if (request && typeof request.then === 'function') {
    request.then(function () {
      window.__fs = { state: 'fulfilled' };
    }, function (error) {
      window.__fs = { state: 'rejected', name: error.name };
    });
  } else {
    window.__fs = { state: 'void' };
  }
});
`);

export const pointerLockDoc = doc('pointer-lock', `
<canvas id="pl-canvas" width="240" height="120"></canvas>
<button id="pl-start" type="button">Lock pointer</button>`, `
__listen(['pointerlockchange', 'pointerlockerror', 'mousemove', 'click'], document, function (entry, event) {
  entry.pointerLockElement = document.pointerLockElement ? document.pointerLockElement.id : null;
  if (entry.type === 'mousemove') {
    entry.movementX = event.movementX;
    entry.movementY = event.movementY;
  }
});
window.__pl = { state: 'idle' };
document.getElementById('pl-start').addEventListener('click', function () {
  var canvas = document.getElementById('pl-canvas');
  window.__pl = { state: 'pending' };
  var request;
  try {
    request = canvas.requestPointerLock();
  } catch (error) {
    window.__pl = { state: 'threw', name: error.name };
    return;
  }
  if (request && typeof request.then === 'function') {
    request.then(function () {
      window.__pl = { state: 'fulfilled' };
    }, function (error) {
      window.__pl = { state: 'rejected', name: error.name };
    });
  } else {
    window.__pl = { state: 'void' };
  }
});
document.addEventListener('pointerlockchange', function () {
  if (!document.pointerLockElement) window.__pl = { state: 'released' };
});
`);

export const touchDoc = doc('touch', `
<button id="tap-target" type="button">Tap</button>`, `
window.__taps = { click: 0, touchstart: 0, touchend: 0, mousedown: 0 };
__listen(['touchstart', 'touchend', 'touchcancel', 'pointerdown', 'pointerup', 'click', 'mousedown'], document, function (entry, event) {
  entry.id = (event.target && event.target.id) || null;
  if (typeof event.pointerType === 'string') entry.pointerType = event.pointerType;
  if (entry.type === 'click') window.__taps.click += 1;
  if (entry.type === 'touchstart') window.__taps.touchstart += 1;
  if (entry.type === 'touchend') window.__taps.touchend += 1;
  if (entry.type === 'mousedown') window.__taps.mousedown += 1;
});
`);

export const viewportDoc = doc('viewport', `
<p id="marker">viewport</p>`);

export function iframeDoc(title, frameSrc, frameId) {
  return doc(title, `
<iframe id="${frameId}" src="${frameSrc}" width="420" height="160"></iframe>`, `
__listen(['focusin', 'focusout', 'click'], document, function (entry, event) {
  entry.id = (event.target && event.target.id) || (event.target && event.target.nodeName) || null;
});
`);
}
