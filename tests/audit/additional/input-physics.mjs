// Raw CDP input physics with an optional humanizer annotation.
//
// The probe asserts only observable event mechanics: trust, coordinates, wheel
// deltas, key identity, ordering and target hit. It does not claim that any
// timing distribution looks human, and it never fabricates human statistics.

import { STATUS, acquirePage, closeQuietly, finish, recorder, round } from "./support.mjs";

const probe = {
  id: "input/event-physics",
  family: "input",
  timeoutMs: 40_000,
  contextOptions: {},
  async run({ page, context, origin, config }) {
    const rec = recorder();
    const owned = await acquirePage({ page, context, origin });
    let client = null;
    try {
      const coords = await owned.page.evaluate(() => {
        const host = document.createElement("div");
        host.style.cssText = "all:initial;position:absolute;left:0;top:0";
        document.body.append(host);
        const make = (id, css) => {
          const element = document.createElement(id === "field" ? "input" : "button");
          element.id = id;
          element.textContent = id === "field" ? "" : "probe";
          element.style.cssText = `position:fixed;box-sizing:border-box;${css}`;
          host.append(element);
          return element;
        };
        const target = make("target", "left:20%;top:20%;width:120px;height:60px");
        const target2 = make("target2", "left:45%;top:20%;width:120px;height:60px");
        const field = make("field", "left:20%;top:45%;width:200px;height:40px");
        window.__cloakiumInputProbe = { events: [] };
        const record = (event) => {
          const row = {
            type: event.type,
            trusted: event.isTrusted,
            timeStamp: event.timeStamp,
            target: event.target?.id ?? null,
            clientX: event.clientX ?? null,
            clientY: event.clientY ?? null,
            screenX: event.screenX ?? null,
            screenY: event.screenY ?? null,
            pageX: event.pageX ?? null,
            pageY: event.pageY ?? null,
            movementX: event.movementX ?? null,
            movementY: event.movementY ?? null,
            button: event.button ?? null,
            buttons: event.buttons ?? null,
            pointerType: event.pointerType ?? null,
            pointerId: event.pointerId ?? null,
            deltaX: event.deltaX ?? null,
            deltaY: event.deltaY ?? null,
            deltaMode: event.deltaMode ?? null,
            key: event.key ?? null,
            code: event.code ?? null,
            value: event.target?.id === "field" ? event.target.value : null,
          };
          window.__cloakiumInputProbe.events.push(row);
        };
        for (const type of ["pointermove", "pointerdown", "pointerup", "mousedown", "mouseup", "click", "keydown", "keypress", "keyup", "input", "wheel"]) {
          document.addEventListener(type, record, { capture: true, passive: true });
        }
        const center = (element) => {
          const rect = element.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        };
        return {
          target: center(target), target2: center(target2), field: center(field),
          free: { x: Math.round(innerWidth * 0.7), y: Math.round(innerHeight * 0.7) },
          viewport: { width: innerWidth, height: innerHeight },
        };
      });

      client = await context.newCDPSession(owned.page).catch((error) => {
        const reason = `${error.name}: ${error.message}`;
        for (const name of [
          "CDP pointer and mouse events arrive",
          "all dispatched events are trusted",
          "pressed coordinates echo the requested point",
          "click lands on the requested element",
          "wheel deltas echo the requested pixels",
          "keyboard identity is preserved",
          "typed text reaches the focused field",
          "event timestamps are ordered",
          "Playwright pointer movement echoes its coordinates",
        ]) rec.unknown(name, STATUS.unsupported, reason);
        rec.limit("cdp-only", "This probe needs a Chromium CDP session; other engines are reported as unsupported rather than failed.");
        return null;
      });
      if (!client) return finish(rec, { cdpUnavailable: true });
      const dispatch = (type, x, y, extra = {}) =>
        client.send("Input.dispatchMouseEvent", {
          type, x, y, button: "left", clickCount: 1, pointerType: "mouse", ...extra,
        });
      await dispatch("mouseMoved", coords.target.x, coords.target.y, { button: "none", clickCount: 0 });
      await dispatch("mousePressed", coords.target.x, coords.target.y);
      await dispatch("mouseReleased", coords.target.x, coords.target.y);
      await dispatch("mouseMoved", coords.field.x, coords.field.y, { button: "none", clickCount: 0 });
      await dispatch("mousePressed", coords.field.x, coords.field.y);
      await dispatch("mouseReleased", coords.field.x, coords.field.y);
      await client.send("Input.dispatchKeyEvent", {
        type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
        text: "a", unmodifiedText: "a",
      });
      await client.send("Input.dispatchKeyEvent", {
        type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
      });
      await dispatch("mouseWheel", coords.target.x, coords.target.y, { deltaX: 7, deltaY: 120, button: "none" });
      await owned.page.mouse.move(coords.free.x, coords.free.y);

      const events = await owned.page.evaluate(() => window.__cloakiumInputProbe.events.slice());
      let humanizer = { installed: false, targetHit: null, pointerSteps: null };
      const install = config?.humanizer?.install;
      if (typeof install === "function") {
        await install(owned.page);
        await owned.page.click("#target2", { timeout: 10_000 });
        const after = await owned.page.evaluate(() => window.__cloakiumInputProbe.events.slice());
        const moves = after.filter((event) => event.type === "pointermove" && event.target === "target2").length;
        humanizer = {
          installed: true,
          targetHit: after.some((event) => event.type === "click" && event.target === "target2" && event.trusted === true),
          pointerSteps: moves,
        };
      }

      const byType = (type) => events.filter((event) => event.type === type);
      const pressed = byType("mousedown").find((event) => Math.abs(event.clientX - coords.target.x) <= 1 && Math.abs(event.clientY - coords.target.y) <= 1);
      const clickTarget = byType("click").find((event) => event.target === "target");
      const wheel = byType("wheel").at(-1);
      const keyDown = byType("keydown").at(-1);
      const timeOrdered = events.every((event, index) => index === 0 || event.timeStamp >= events[index - 1].timeStamp);
      const playwrightMove = byType("pointermove").filter((event) => Math.abs(event.clientX - coords.free.x) <= 1 && Math.abs(event.clientY - coords.free.y) <= 1);

      rec.expect("CDP pointer and mouse events arrive", ["pointermove", "pointerdown", "pointerup", "mousedown", "mouseup"].every((type) => byType(type).length > 0));
      rec.expect("all dispatched events are trusted", events.every((event) => event.trusted === true));
      rec.expect("pressed coordinates echo the requested point", Boolean(pressed), pressed ? `x=${round(pressed.clientX, 2)} y=${round(pressed.clientY, 2)}` : "no matching mousedown");
      rec.expect("click lands on the requested element", Boolean(clickTarget));
      rec.expect("wheel deltas echo the requested pixels", wheel ? wheel.deltaX === 7 && wheel.deltaY === 120 : false, wheel ? `dx=${wheel.deltaX} dy=${wheel.deltaY} mode=${wheel.deltaMode}` : "no wheel event");
      rec.expect("keyboard identity is preserved", keyDown ? keyDown.key === "a" && keyDown.code === "KeyA" : false);
      const fieldValue = byType("input").at(-1)?.value ?? null;
      rec.expect("typed text reaches the focused field", fieldValue === "a");
      rec.expect("event timestamps are ordered", timeOrdered);
      rec.expect("Playwright pointer movement echoes its coordinates", playwrightMove.length > 0);
      if (humanizer.installed) {
        rec.expect("humanized click reaches the requested target", humanizer.targetHit === true, `${humanizer.pointerSteps} pointermove steps`);
        rec.limit("humanizer-shape", "Step count is recorded, not asserted against a human distribution.");
      } else {
        rec.limit("humanizer-absent", "No config.humanizer.install annotation was supplied; only the raw CDP path was measured.");
      }
      rec.limit("cdp-scope", "This measures the native CDP input path, not a physical pointer device or OS-level event source.");
      rec.limit("coordinate-units", "Coordinates are CSS pixels at the context viewport; devicePixelRatio scaling is not asserted.");

      return finish(rec, {
        coords,
        counts: Object.fromEntries(["pointermove", "pointerdown", "pointerup", "mousedown", "mouseup", "click", "keydown", "keypress", "keyup", "input", "wheel"].map((type) => [type, byType(type).length])),
        pressed: pressed ?? null,
        clickTarget: clickTarget ?? null,
        wheel: wheel ?? null,
        keyDown: keyDown ?? null,
        fieldValue,
        playwrightMove: playwrightMove.at(-1) ?? null,
        humanizer,
        viewport: coords.viewport,
      });
    } finally {
      if (client) await client.detach().catch(() => {});
      if (!owned.owned) await owned.page.evaluate(() => { delete window.__cloakiumInputProbe; }).catch(() => {});
      if (owned.owned) await closeQuietly(owned.page);
    }
  },
};

export const probes = [probe];
