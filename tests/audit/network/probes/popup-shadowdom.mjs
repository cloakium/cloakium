import { waitFor } from "../lab/util.mjs";
import { fail, inconclusive, pass, result, stageNeeded } from "./kit.mjs";

function flatten(node, out = []) {
  if (!node) return out;
  out.push(node);
  for (const child of node.children ?? []) flatten(child, out);
  for (const root of node.shadowRoots ?? []) flatten(root, out);
  if (node.contentDocument) flatten(node.contentDocument, out);
  return out;
}

function attributeValue(node, name) {
  const attributes = node.attributes ?? [];
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    if (attributes[index] === name) return attributes[index + 1];
  }
  return null;
}

/** Playwright passes --disable-popup-blocking by default; detect that launcher shape. */
function popupBlockerDisabled(config) {
  const args = config?.launchArgs ?? [];
  if (args.includes("--disable-popup-blocking")) return true;
  if (config?.playwrightDefaults === false) return false;
  if (config?.playwrightDefaults === true) {
    return !(config?.ignoreDefaultArgs ?? []).includes("--disable-popup-blocking");
  }
  return null;
}

export const probes = [
  {
    id: "dom.closed-shadow-cdp-diagnostic",
    family: "dom-diagnostics",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.origin"],
      launchArgs: [],
      contextOptions: {},
      profileLifecycle: "none",
      relaunch: false,
      needs: "CDP DOM.getDocument({pierce:true}); no page-visible encapsulation change",
    },
    async run({ context, origin }) {
      const page = await context.newPage();
      let cdp = null;
      try {
        await page.goto(`${origin}/closed-shadow`, { waitUntil: "domcontentloaded" });
        const jsView = await page.evaluate(() => {
          const host = document.getElementById("host");
          const source = Function.prototype.toString.call(Element.prototype.attachShadow);
          return {
            shadowRootVisible: host?.shadowRoot !== null && host?.shadowRoot !== undefined,
            queryableMarker: document.querySelector("#secret-marker") !== null,
            attachShadowNative: source.includes("[native code]"),
          };
        });

        try {
          cdp = await context.newCDPSession(page);
        } catch {
          return result({
            observations: { jsView },
            checks: [stageNeeded("cdp-dom-pierce", "no CDP session on this target")],
            limitations: ["CDP DOM diagnostics unavailable, so no supported diagnostic path could be exercised."],
          });
        }

        let documentNode = null;
        try {
          const response = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
          documentNode = response.root ?? null;
        } catch (error) {
          return result({
            observations: { jsView, cdpError: String(error.message).split("\n")[0] },
            checks: [stageNeeded("cdp-dom-pierce", "DOM.getDocument with pierce did not respond")],
            limitations: ["No supported diagnostic path could be exercised."],
          });
        }

        const nodes = flatten(documentNode);
        const closedRoots = nodes.filter((node) => node.shadowRootType === "closed");
        const markerNode = nodes.find((node) => attributeValue(node, "data-lab") === "closed-root");

        return result({
          observations: {
            jsView,
            nodeCount: nodes.length,
            closedRootCount: closedRoots.length,
            markerFound: Boolean(markerNode),
            markerNodeName: markerNode?.nodeName ?? null,
            markerBackendId: markerNode?.backendNodeId ?? null,
          },
          checks: [
            jsView.shadowRootVisible === false
              ? pass("js-encapsulation-intact", "host.shadowRoot is null from page script")
              : fail("js-encapsulation-intact", "page script could reach the closed shadow root"),
            jsView.queryableMarker === false
              ? pass("closed-content-not-queryable", "document.querySelector cannot see closed content")
              : fail("closed-content-not-queryable", "document.querySelector reached closed content"),
            closedRoots.length > 0
              ? pass("cdp-pierce-reveals-closed-root", `${closedRoots.length} closed shadow root(s) via pierce`)
              : fail("cdp-pierce-reveals-closed-root", "pierce returned no closed shadow root"),
            markerNode
              ? pass("cdp-reaches-closed-marker", `marker backendNodeId=${markerNode.backendNodeId}`)
              : inconclusive("cdp-reaches-closed-marker", "closed root present but the marker node was not returned"),
            jsView.attachShadowNative
              ? pass("attach-shadow-not-patched", "Element.prototype.attachShadow is still native")
              : fail("attach-shadow-not-patched", "attachShadow has been wrapped, which would weaken encapsulation"),
          ],
          limitations: [
            "CDP is a debugger capability for the automation client; it does not change what page script observes.",
            "The assertion is that encapsulation stays intact for page script while a supported diagnostic path still sees the tree.",
          ],
        });
      } finally {
        await cdp?.detach().catch(() => {});
        await page.close().catch(() => {});
      }
    },
  },
  {
    id: "page.popup-flood-protection",
    family: "popup-navigation",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.origin"],
      launchArgs: [],
      launchArgsAbsent: ["--disable-popup-blocking"],
      contextOptions: {},
      profileLifecycle: "none",
      relaunch: true,
      needs: "the Chromium popup blocker must be active: launch with ignoreDefaultArgs: ['--disable-popup-blocking'] (scenario `popup-blocker`)",
    },
    async run({ context, origin, config }) {
      const disabled = popupBlockerDisabled(config);
      const page = await context.newPage();
      const created = [];
      const onPage = (newPage) => created.push(newPage);
      context.on("page", onPage);
      try {
        await page.goto(`${origin}/popup-flood`, { waitUntil: "domcontentloaded" });
        const results = await page.evaluate(() => window.__labPopupFlood(10));
        if (!Array.isArray(results)) {
          return result({
            observations: { results },
            checks: [stageNeeded("popup-fixture-available", "the fixture page did not expose the popup routine")],
            limitations: ["Popup behaviour was not observable."],
          });
        }
        const blocked = results.filter((entry) => entry === "blocked").length;
        const opened = results.length - blocked;

        if (disabled === true) {
          return result({
            observations: { results, createdPages: created.length, popupBlockerDisabled: true },
            checks: [
              stageNeeded(
                "popup-blocker-active",
                "the browser was launched with --disable-popup-blocking (Playwright default), so ungated popups cannot be observed as blocked",
              ),
            ],
            limitations: [
              "Run the `popup-blocker` scenario with ignoreDefaultArgs: ['--disable-popup-blocking'] to test the real blocker.",
            ],
          });
        }

        return result({
          observations: { results, createdPages: created.length, popupBlockerDisabled: disabled },
          checks: [
            opened <= 1
              ? pass(
                  "popups-bounded-without-activation",
                  `${opened} of ${results.length} ungated window.open calls allowed; the rest were refused`,
                )
              : fail(
                  "popups-bounded-without-activation",
                  `${opened} of ${results.length} window.open calls were allowed without user activation`,
                ),
            created.length === 0
              ? pass("no-unbounded-page-creation", "no extra pages materialised")
              : fail("no-unbounded-page-creation", `${created.length} page(s) created by ungated window.open`),
          ],
          limitations: [
            "Chromium can allow a single ungated popup per page load; the asserted property is boundedness (<= 1), not zero.",
            "Popup blocking depends on activation state; no page gesture is simulated, on purpose.",
          ],
        });
      } finally {
        context.off("page", onPage);
        for (const extra of created) await extra.close().catch(() => {});
        await page.close().catch(() => {});
      }
    },
  },
  {
    id: "page.navigation-flood-resilience",
    family: "popup-navigation",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.originStats"],
      launchArgs: [],
      contextOptions: {},
      profileLifecycle: "none",
      relaunch: false,
      needs: "bounded burst only; the probe makes no claim about exhaustion limits",
    },
    async run({ context, lab }) {
      const page = await context.newPage();
      try {
        const before = lab.originStats().hits["/frame"] ?? 0;
        await page.goto(`${lab.origin}/flood`, { waitUntil: "domcontentloaded" });
        const flood = await page.evaluate(() => {
          const frames = window.__labIframeFlood(40);
          const historyLength = window.__labHistoryFlood(200);
          return { frames, historyLength };
        });
        if (!flood || typeof flood !== "object") {
          return result({
            observations: { flood },
            checks: [stageNeeded("flood-fixture-available", "the fixture page did not expose the flood routines")],
            limitations: ["Navigation flood behaviour was not observable."],
          });
        }
        const loaded = await waitFor(
          () => {
            const current = lab.originStats().hits["/frame"] ?? 0;
            return current - before >= 40 ? current - before : false;
          },
          { timeoutMs: 8_000, label: "iframe flood load" },
        ).catch(() => null);
        const alive = await page.evaluate(() => window.__labAlive()).catch(() => null);

        return result({
          observations: { flood, frameRequests: loaded, alive, historyCap: flood.historyLength },
          checks: [
            flood.frames === 40
              ? pass("iframe-flood-created-bounded", "40 frames created in one synchronous burst")
              : fail("iframe-flood-created-bounded", `frames=${flood.frames}`),
            alive === "flood"
              ? pass("page-responsive-after-flood", "page still evaluates script after the burst")
              : fail("page-responsive-after-flood", `alive=${alive}`),
            loaded !== null && loaded <= 80
              ? pass("no-request-amplification", `${loaded} frame requests for 40 frames`)
              : inconclusive("no-request-amplification", `frameRequests=${loaded}`),
            flood.historyLength >= 2 && flood.historyLength <= 200
              ? pass("history-storm-bounded", `history.length=${flood.historyLength} (Chromium caps session history; a smaller final value is expected)`)
              : fail("history-storm-bounded", `history.length=${flood.historyLength} outside [2, 200]`),
          ],
          limitations: [
            "A bounded burst is used; no memory-exhaustion attempt is made.",
            "Chromium caps session history, so the final length is not asserted to equal the number of pushState calls.",
          ],
        });
      } finally {
        await page.close().catch(() => {});
      }
    },
  },
];
