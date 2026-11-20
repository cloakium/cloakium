/** Fixture HTML. No external references: every URL resolves against the lab origin. */

export function indexPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>lab index</title></head>
<body><h1>cloakium network lab</h1>
<p>Loopback fixture origin. Probes attach here; nothing on this page contacts the network.</p>
</body></html>`;
}

export function blankPage(title) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body></body></html>`;
}

export function framePage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>lab frame</title></head>
<body><p id="frame-body">third-party frame</p>
<script>
window.__labFrame = {
  readCookie: () => document.cookie,
  writeCookie: (text) => { document.cookie = text; return document.cookie; },
  probeStorage: () => {
    try { localStorage.setItem("lab-frame", "1"); return localStorage.getItem("lab-frame"); }
    catch (error) { return "error:" + (error && error.name); }
  },
};
</script></body></html>`;
}

export function thirdPartyPage(crossOrigin) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>lab third party</title></head>
<body><p id="top">top-level</p>
<iframe id="third" src="${crossOrigin}/frame" width="320" height="120"></iframe>
<script>
window.__labTopCookie = () => document.cookie;
window.__labThirdFrameReady = () => {
  const frame = document.getElementById("third");
  return Boolean(frame && frame.contentWindow);
};
</script></body></html>`;
}

export function closedShadowPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>closed shadow</title></head>
<body><div id="host"></div>
<script>
const host = document.getElementById("host");
const root = host.attachShadow({ mode: "closed" });
root.innerHTML = '<span id="secret-marker" data-lab="closed-root">closed-content</span>';
window.__labClosedShadow = {
  shadowRootVisible: host.shadowRoot !== null,
  id: host.id,
};
</script></body></html>`;
}

export function popupFloodPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>popup flood</title></head>
<body><button id="go">go</button>
<script>
window.__labPopupFlood = (count) => {
  const results = [];
  for (let i = 0; i < count; i += 1) {
    let handle = null;
    try { handle = window.open("/popup-target", "_blank"); } catch (error) { results.push("throw"); continue; }
    results.push(handle === null || handle === undefined ? "blocked" : "opened");
    if (handle) { try { handle.close(); } catch (error) { /* ignore */ } }
  }
  return results;
};
window.__labPopupOnClick = (count) => {
  document.getElementById("go").addEventListener("click", () => window.__labPopupFlood(count), { once: true });
  return true;
};
</script></body></html>`;
}

export function floodPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>flood</title></head>
<body><div id="sink"></div>
<script>
window.__labIframeFlood = (count) => {
  const sink = document.getElementById("sink");
  for (let i = 0; i < count; i += 1) {
    const frame = document.createElement("iframe");
    frame.src = "/frame?flood=" + i;
    sink.appendChild(frame);
  }
  return sink.querySelectorAll("iframe").length;
};
window.__labHistoryFlood = (count) => {
  for (let i = 0; i < count; i += 1) history.pushState({ i }, "", "/flood?n=" + i);
  return history.length;
};
window.__labAlive = () => document.title;
</script></body></html>`;
}

export function storagePage() {
  return blankPage("lab storage");
}

export function inputPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>lab input</title></head>
<body><input id="target" type="text" aria-label="lab probe target" autocomplete="off">
<p id="lab-input-note">trusted input fixture</p></body></html>`;
}

export function popupPolicyPage() {
  const attempts = 4;
  return `<!doctype html><html><head><meta charset="utf-8"><title>lab popup policy</title></head>
<body><p>popup policy fixture</p>
<script>
window.popupResults = [];
window.popupActivationBefore = Boolean(navigator.userActivation && navigator.userActivation.isActive);
for (let index = 0; index < ${attempts}; index += 1) {
  let handle = null;
  try { handle = window.open("", "_blank"); } catch (error) { window.popupResults.push("throw"); continue; }
  window.popupResults.push(handle === null || handle === undefined ? "blocked" : "opened");
  if (handle) { try { handle.close(); } catch (error) { /* ignore */ } }
}
window.popupProbeDone = true;
</script></body></html>`;
}

export function navigationPolicyPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>lab navigation policy</title></head>
<body><p>navigation policy fixture</p>
<script>
const probe = { attempted: 0, replaced: 0, failed: 0 };
for (let index = 0; index < 400; index += 1) {
  probe.attempted += 1;
  try {
    if (index % 2 === 0) history.pushState({ index }, "", location.pathname + "?n=" + index);
    else { history.replaceState({ index }, "", location.pathname); probe.replaced += 1; }
  } catch (error) {
    probe.failed += 1;
  }
}
probe.historyLength = history.length;
probe.origin = location.origin;
window.navigationProbe = probe;
window.navigationProbeDone = true;
</script></body></html>`;
}

export function audioPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>lab audio</title></head>
<body><button id="audio-start">start</button></body></html>`;
}

export function cookieSetterPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>cookie setter</title></head>
<body><iframe id="third" src="/frame" width="200" height="80"></iframe></body></html>`;
}
