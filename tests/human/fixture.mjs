/**
 * Localhost fixture for the humanize suite: a button, a text field, a checkbox,
 * duplicate-class buttons, a covered button, an iframe with its own controls,
 * and a control far enough down the page to require wheel scrolling.
 */

import http from "node:http";

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>cloakium fixture</title>
<style>
  body { font: 16px sans-serif; margin: 12px; }
  input[type=text] { width: 240px; padding: 4px; }
  #cover-wrap { position: relative; width: 180px; height: 44px; margin: 12px 0; }
  #covered { position: absolute; inset: 0; width: 100%; height: 100%; }
  #overlay { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.12); }
  iframe { width: 320px; height: 120px; }
  #spacer { height: 2600px; }
</style>
</head>
<body>
  <button id="btn">Click</button>
  <input id="input" type="text">
  <input id="disabled" type="text" disabled>
  <output id="out">0</output>
  <label><input type="checkbox" id="agree"> Agree</label>
  <button class="dup" id="dup-a">A</button><button class="dup" id="dup-b">B</button>
  <div id="cover-wrap">
    <button id="covered">Covered</button>
    <div id="overlay"></div>
  </div>
  <button id="hidden" style="display: none">Hidden</button>
  <iframe id="frame" srcdoc='<!doctype html><html><body><button id="inner-btn">Inner</button><input id="inner-input"></body></html>'></iframe>
  <div id="spacer"></div>
  <button id="deep">Deep</button>
<script>
window.log = {
  clicks: 0,
  innerClicks: 0,
  deepClicks: 0,
  coveredClicks: 0,
  dupClicks: 0,
  checks: 0,
  mouseMoves: 0,
  keydowns: 0,
  trustedClicks: 0,
  trustedKeys: 0,
  touches: 0,
  trustedTouches: 0,
  wheels: [],
};
addEventListener('mousemove', () => { window.log.mouseMoves += 1; }, true);
addEventListener('wheel', (event) => {
  window.log.wheels.push({ dy: event.deltaY, trusted: event.isTrusted });
}, true);
addEventListener('keydown', (event) => {
  window.log.keydowns += 1;
  if (event.isTrusted) window.log.trustedKeys += 1;
}, true);
addEventListener('touchstart', (event) => {
  window.log.touches += 1;
  if (event.isTrusted) window.log.trustedTouches += 1;
}, true);
document.getElementById('btn').addEventListener('click', (event) => {
  window.log.clicks += 1;
  if (event.isTrusted) window.log.trustedClicks += 1;
  document.getElementById('out').textContent = String(window.log.clicks);
});
document.getElementById('agree').addEventListener('click', () => { window.log.checks += 1; });
for (const id of ['dup-a', 'dup-b']) {
  document.getElementById(id).addEventListener('click', () => { window.log.dupClicks += 1; });
}
document.getElementById('deep').addEventListener('click', () => { window.log.deepClicks += 1; });
document.getElementById('covered').addEventListener('click', () => { window.log.coveredClicks += 1; });
const frame = document.getElementById('frame');
frame.addEventListener('load', () => {
  const doc = frame.contentDocument;
  doc.getElementById('inner-btn').addEventListener('click', () => { window.log.innerClicks += 1; });
});
</script>
</body>
</html>`;

/**
 * Start the fixture on an ephemeral localhost port.
 * @returns {{url: string, close: () => Promise<void>}}
 */
export async function startFixture() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
