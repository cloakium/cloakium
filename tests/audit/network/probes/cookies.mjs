import { waitFor } from "../lab/util.mjs";
import { fail, inconclusive, pass, result, stageNeeded, unavailable } from "./kit.mjs";

const CDP_MISSING = /wasn't found|not found|does not exist|Unknown method/i;

/** Frames commit asynchronously; `domcontentloaded` on the parent can precede them. */
async function frameFor(page, prefix, timeoutMs = 5_000) {
  try {
    return await waitFor(
      () => page.frames().find((frame) => frame.url().startsWith(prefix)) ?? false,
      { timeoutMs, label: "third-party frame" },
    );
  } catch {
    return null;
  }
}

const SET_COOKIE_CONTROLS = { enableThirdPartyCookieRestriction: true };

export const probes = [
  {
    id: "cookies.chips-partition",
    family: "cookies",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.crossOrigin"],
      launchArgs: [],
      contextOptions: {},
      profileLifecycle: "none",
      relaunch: false,
      needs: "crossOrigin must be a distinct site (lab binds IPv6 loopback so it never depends on localhost resolution)",
    },
    async run({ context, origin, crossOrigin }) {
      const page = await context.newPage();
      try {
        await page.goto(`${origin}/thirdparty?peer=${encodeURIComponent(crossOrigin)}`, { waitUntil: "domcontentloaded" });
        const frame = await frameFor(page, crossOrigin);
        if (!frame) {
          return result({
            observations: { frameUrls: page.frames().map((entry) => entry.url()), crossOrigin },
            checks: [stageNeeded("third-party-frame-available", "the cross-origin frame did not load")],
            limitations: ["Cross-site frame missing, so partition behaviour is unobserved."],
          });
        }

        const frameCookie = await frame.evaluate(() => {
          document.cookie = "lab_part=1; SameSite=None; Secure; Path=/; Partitioned";
          return document.cookie;
        });
        const cookies = await context.cookies();
        const partitioned = cookies.find((cookie) => cookie.name === "lab_part");

        await page.goto(`${origin}/thirdparty?peer=${encodeURIComponent(crossOrigin)}`, { waitUntil: "domcontentloaded" });
        const frameAgain = await frameFor(page, crossOrigin);
        const visibleInSamePartition = frameAgain ? await frameAgain.evaluate(() => document.cookie) : "";

        await page.goto(crossOrigin, { waitUntil: "domcontentloaded" });
        const visibleAtOtherTopLevel = await page.evaluate(() => document.cookie);

        return result({
          observations: {
            frameCookie,
            contextCookie: partitioned
              ? { name: partitioned.name, partitionKey: partitioned.partitionKey, sameSite: partitioned.sameSite, secure: partitioned.secure }
              : null,
            visibleInSamePartition,
            visibleAtOtherTopLevel,
            cookieCount: cookies.length,
            crossOrigin,
          },
          checks: [
            partitioned
              ? pass("partitioned-cookie-accepted", `partitionKey=${partitioned.partitionKey ?? "undefined"}`)
              : fail("partitioned-cookie-accepted", "the Partitioned cookie was not stored"),
            partitioned?.partitionKey
              ? pass("partition-key-reported", `partitionKey=${partitioned.partitionKey}`)
              : fail("partition-key-reported", "context.cookies() reported no partitionKey"),
            frameCookie.includes("lab_part")
              ? pass("cookie-readable-in-owning-frame", "frame sees its partitioned cookie")
              : fail("cookie-readable-in-owning-frame", "frame cannot read the cookie it just set"),
            visibleInSamePartition.includes("lab_part")
              ? pass("cookie-visible-in-matching-partition", "same top-level site sees the cookie")
              : fail("cookie-visible-in-matching-partition", "same top-level site could not read the cookie"),
            visibleAtOtherTopLevel.includes("lab_part")
              ? fail("cookie-hidden-outside-partition", "the partitioned cookie was visible under a different top-level site")
              : pass("cookie-hidden-outside-partition", "different top-level site did not see the cookie"),
          ],
          limitations: [
            "127.0.0.1 and the crossOrigin host are distinct sites, which is what makes this a genuine cross-site partition test.",
            "Secure cookies are exercised on loopback, which Chromium treats as a trustworthy origin.",
          ],
        });
      } finally {
        await page.close().catch(() => {});
      }
    },
  },
  {
    id: "cookies.third-party-control-cdp",
    family: "cookies",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.crossOrigin"],
      launchArgs: [],
      contextOptions: {},
      profileLifecycle: "none",
      relaunch: false,
      needs: "CDP Network.setCookieControls({enableThirdPartyCookieRestriction})",
    },
    async run({ context, origin, crossOrigin }) {
      const page = await context.newPage();
      let cdp = null;
      try {
        await page.goto(`${origin}/thirdparty?peer=${encodeURIComponent(crossOrigin)}`, { waitUntil: "domcontentloaded" });
        try {
          cdp = await context.newCDPSession(page);
        } catch (error) {
          return result({
            observations: { cdpError: String(error.message).split("\n")[0] },
            checks: [unavailable("cdp-cookie-controls", "no CDP session on this target")],
            limitations: ["Cookie controls require CDP, which this target did not provide."],
          });
        }

        try {
          await cdp.send("Network.enable");
          await cdp.send("Network.setCookieControls", SET_COOKIE_CONTROLS);
        } catch (error) {
          const message = String(error.message);
          return result({
            observations: { cdpError: message.split("\n")[0] },
            checks: [
              CDP_MISSING.test(message)
                ? unavailable("cdp-cookie-controls", "Network.setCookieControls is not exposed by this target")
                : fail("cdp-cookie-controls", message.split("\n")[0]),
            ],
            limitations: ["Network.setCookieControls is experimental; absence is reported as unavailable, not as a failure."],
          });
        }

        await page.reload({ waitUntil: "domcontentloaded" });
        const frame = await frameFor(page, crossOrigin);
        if (!frame) {
          return result({
            observations: {},
            checks: [stageNeeded("third-party-frame-available", "the cross-origin frame did not reload")],
            limitations: ["Cross-site frame missing after the control change."],
          });
        }

        const blockedWrite = await frame.evaluate(() => {
          document.cookie = "lab_blocked=1; SameSite=None; Secure; Path=/";
          return document.cookie;
        });
        const stored = (await context.cookies()).filter((cookie) => cookie.name === "lab_blocked");

        return result({
          observations: { blockedFrameCookie: blockedWrite, stored: stored.length },
          checks: [
            blockedWrite.includes("lab_blocked")
              ? fail("third-party-cookie-write-blocked", "the frame still stored a third-party cookie")
              : pass("third-party-cookie-write-blocked", "third-party cookie write was refused"),
            stored.length === 0
              ? pass("third-party-cookie-absent-from-store", "no lab_blocked cookie in the store")
              : fail("third-party-cookie-absent-from-store", `${stored.length} lab_blocked cookie(s) present`),
          ],
          limitations: [
            "Controls are applied through CDP for this page only; the assertion is scoped to this context.",
            "Experimental CDP surface may change between browser builds.",
          ],
        });
      } finally {
        await cdp?.detach().catch(() => {});
        await page.close().catch(() => {});
      }
    },
  },
  {
    id: "cookies.store-coherence",
    family: "cookies",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.origin", "CDP Storage.getCookies"],
      launchArgs: [],
      contextOptions: {},
      profileLifecycle: "none",
      relaunch: false,
      needs: "nothing beyond a fresh context",
    },
    async run({ context, origin }) {
      const page = await context.newPage();
      let cdp = null;
      try {
        await context.addCookies([{ name: "lab_coherent", value: "one", url: origin, sameSite: "Lax" }]);
        await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
        try {
          cdp = await context.newCDPSession(page);
        } catch (error) {
          return result({
            observations: { cdpError: String(error.message).split("\n")[0] },
            checks: [unavailable("cdp-storage-cookies", "no CDP session on this target")],
            limitations: ["CDP cookie store could not be read."],
          });
        }

        let cdpCookies = null;
        try {
          // Per-target API: Storage.getCookies reads the default browser context,
          // which is not the isolated context Playwright creates for a probe.
          const resultSet = await cdp.send("Network.getCookies", { urls: [origin] });
          cdpCookies = resultSet.cookies ?? [];
        } catch (error) {
          return result({
            observations: { cdpError: String(error.message).split("\n")[0] },
            checks: [unavailable("cdp-storage-cookies", "Network.getCookies did not respond")],
            limitations: ["CDP cookie store could not be read."],
          });
        }

        const documentCookie = await page.evaluate(() => document.cookie);
        const playwrightCookies = await context.cookies([origin]);
        const names = new Set(playwrightCookies.map((cookie) => cookie.name));
        const cdpNames = new Set(cdpCookies.map((cookie) => cookie.name));

        return result({
          observations: { documentCookie, playwrightNames: [...names].sort(), cdpNames: [...cdpNames].sort() },
          checks: [
            names.has("lab_coherent")
              ? pass("playwright-store-has-cookie", "context.cookies() lists lab_coherent")
              : fail("playwright-store-has-cookie", "context.cookies() is missing lab_coherent"),
            cdpNames.has("lab_coherent")
              ? pass("cdp-store-has-cookie", "CDP lists lab_coherent")
              : fail("cdp-store-has-cookie", "CDP store is missing lab_coherent"),
            documentCookie.includes("lab_coherent=one")
              ? pass("document-cookie-agrees", "page sees lab_coherent=one")
              : inconclusive("document-cookie-agrees", `document.cookie=${documentCookie || "<empty>"}`),
          ],
          limitations: ["Coherence is asserted for a non-HttpOnly cookie only; HttpOnly cookies are intentionally not visible to script."],
        });
      } finally {
        await cdp?.detach().catch(() => {});
        await page.close().catch(() => {});
      }
    },
  },
  {
    id: "cookies.third-party-default-behavior",
    family: "cookies",
    stage: "runtime",
    requirements: {
      endpoints: ["lab.crossOrigin"],
      launchArgs: [],
      contextOptions: {},
      profileLifecycle: "none",
      relaunch: false,
      needs: "records the effective default third-party policy instead of assuming allowed or blocked",
    },
    async run({ context, origin, crossOrigin }) {
      const page = await context.newPage();
      try {
        await page.goto(`${origin}/thirdparty?peer=${encodeURIComponent(crossOrigin)}`, { waitUntil: "domcontentloaded" });
        const frame = await frameFor(page, crossOrigin);
        if (!frame) {
          return result({
            observations: { frameUrls: page.frames().map((entry) => entry.url()), crossOrigin },
            checks: [stageNeeded("third-party-frame-available", "the cross-origin frame did not load")],
            limitations: ["Cross-site frame missing."],
          });
        }

        const frameCookie = await frame.evaluate(() => {
          document.cookie = "lab_default=1; SameSite=None; Secure; Path=/";
          return document.cookie;
        });
        const stored = (await context.cookies()).filter((cookie) => cookie.name === "lab_default");
        const frameSees = frameCookie.includes("lab_default");
        const defaultMode = stored.length > 0 ? "allowed" : "blocked";

        return result({
          observations: {
            defaultMode,
            frameSees,
            storedCount: stored.length,
            partitionKey: stored[0]?.partitionKey ?? null,
            crossOrigin,
          },
          checks: [
            typeof frameCookie === "string"
              ? pass("default-3pc-write-evaluated", `default policy observed as ${defaultMode}`)
              : fail("default-3pc-write-evaluated", "the frame could not be evaluated"),
            frameSees === (stored.length > 0)
              ? pass("default-mode-coherent", `frame sees=${frameSees} store=${stored.length}`)
              : fail("default-mode-coherent", `frame sees=${frameSees} but store has ${stored.length} cookie(s)`),
            defaultMode === "allowed" || defaultMode === "blocked"
              ? pass("default-mode-classified", `defaultMode=${defaultMode}`)
              : fail("default-mode-classified", `defaultMode=${defaultMode}`),
          ],
          limitations: [
            "This probe records policy, it does not assert that either mode is correct for the audited build.",
            "127.0.0.1 and the crossOrigin host are distinct sites, so the write is genuinely third-party.",
          ],
        });
      } finally {
        await page.close().catch(() => {});
      }
    },
  },
];
