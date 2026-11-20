const contract = (id, run) => ({
  id, family: 'CDP, native descriptors, trusted input and browser defaults',
  timeoutMs: 25000, run,
});

export const probes = [
  contract('native-property-contract', async ({ page }) => {
    const observations = await page.evaluate(async () => {
      const names = ['webdriver', 'platform', 'hardwareConcurrency', 'deviceMemory', 'languages', 'maxTouchPoints'];
      const descriptors = Object.fromEntries(names.map(name => {
        const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, name);
        if (!descriptor) return [name, { available: false }];
        let invalidReceiver;
        try { descriptor.get.call({}); invalidReceiver = 'accepted'; }
        catch (error) { invalidReceiver = error.name; }
        return [name, {
          available: true, ownNavigator: Object.hasOwn(navigator, name),
          enumerable: descriptor.enumerable, configurable: descriptor.configurable,
          getterSource: descriptor.get?.toString(), invalidReceiver,
          value: navigator[name],
        }];
      }));
      const frame = document.createElement('iframe');
      document.body.append(frame);
      const frameNavigator = frame.contentWindow.navigator;
      const iframe = Object.fromEntries(names.map(name => [name, frameNavigator[name]]));
      frame.remove();
      return { descriptors, iframe };
    });
    const available = Object.entries(observations.descriptors).filter(([, row]) => row.available);
    return {
      observations,
      checks: [
        { name: 'available getters reject an invalid receiver', passed: available.every(([, row]) => row.invalidReceiver === 'TypeError') },
        { name: 'no own navigator replacements', passed: available.every(([, row]) => !row.ownNavigator) },
        { name: 'main and same-origin iframe values agree', passed: available.every(([name, row]) =>
          JSON.stringify(row.value) === JSON.stringify(observations.iframe[name])) },
      ],
      limitations: ['Native-looking function text is an observation, not proof of an unmodified implementation.'],
    };
  }),
  contract('cdp-console-observation', async ({ page, context }) => {
    await page.evaluate(() => { window.probeGetterReads = 0; });
    const logError = () => page.evaluate(() => {
      const error = new Error('original-local-probe');
      Object.defineProperty(error, 'stack', { get() { window.probeGetterReads++; return 'local-fixture'; } });
      console.log(error);
      return window.probeGetterReads;
    });
    const before = await logError();
    const client = await context.newCDPSession(page);
    let consoleEvents = 0;
    client.on('Runtime.consoleAPICalled', () => consoleEvents++);
    try {
      await client.send('Runtime.enable');
      const afterEnable = await logError();
      const snapshot = await client.send('Runtime.evaluate', {
        expression: '({getterReads:window.probeGetterReads, webdriver:navigator.webdriver})',
        returnByValue: true,
      });
      return {
        observations: { before, afterEnable, consoleEvents, explicitRuntimeEvaluation: snapshot.result.value },
        checks: [{ name: 'explicit CDP evaluation remains functional', passed: typeof snapshot.result.value?.getterReads === 'number' }],
        limitations: [
          'Vanilla Playwright already has its own protocol sessions; before is not an unattached-browser baseline.',
          'A local Error getter does not reproduce every automation-detection technique.',
        ],
      };
    } finally { await client.detach(); }
  }),
  contract('trusted-input-metadata', async ({ page, origin }) => {
    await page.goto(`${origin}/input`);
    await page.evaluate(() => {
      window.probeEvents = [];
      for (const type of ['pointermove', 'pointerdown', 'pointerup', 'click', 'keydown', 'keyup', 'input', 'wheel']) {
        document.addEventListener(type, event => window.probeEvents.push({
          type, trusted: event.isTrusted, time: event.timeStamp,
          x: event.clientX ?? null, y: event.clientY ?? null,
          screenX: event.screenX ?? null, screenY: event.screenY ?? null,
          key: event.key ?? null, code: event.code ?? null,
          deltaY: event.deltaY ?? null, wheelDeltaY: event.wheelDeltaY ?? null,
          movementX: event.movementX ?? null, movementY: event.movementY ?? null,
          target: event.target.id ?? null,
        }), { passive: true });
      }
    });
    await page.locator('#target').scrollIntoViewIfNeeded();
    await page.mouse.move(20, 20);
    await page.locator('#target').click();
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Shift');
    await page.keyboard.type('bc');
    const wheelObserved = page.evaluate(() => new Promise(resolve => {
      document.addEventListener('wheel', () => resolve(true), { once: true });
    }));
    await page.mouse.wheel(0, 120);
    await wheelObserved;
    const observations = await page.evaluate(() => ({
      events: window.probeEvents, value: document.querySelector('#target').value,
      geometry: {
        screenX, screenY, innerWidth, innerHeight, outerWidth, outerHeight,
        devicePixelRatio,
      },
    }));
    return {
      observations,
      checks: [
        { name: 'events were observed for pointer, keyboard and wheel', passed:
          ['click', 'keydown', 'keyup', 'input', 'wheel'].every(type => observations.events.some(event => event.type === type)) },
        { name: 'dispatched input is trusted', passed: observations.events.every(event => event.trusted) },
        { name: 'click reaches requested input', passed: observations.events.some(event => event.type === 'click' && event.target === 'target') },
        { name: 'keyboard text is correct', passed: observations.value === 'Abc' },
      ],
      limitations: ['This measures the native CDP input path, not any humanized input layer or timing distribution.'],
    };
  }),
  contract('unactivated-popup-policy', async ({ page, context, origin, config }) => {
    await page.goto(`${origin}/popup`);
    await page.waitForFunction(() => window.popupProbeDone === true);
    const results = await page.evaluate(() => ({
      opened: window.popupResults,
      activation: window.popupActivationBefore,
    }));
    // Playwright passes --disable-popup-blocking unless the caller ignores it.
    // When the driver owns that policy the browser's own blocker is not under
    // test, so this is a driver-policy control, never a browser defect.
    const driverDisablesBlocker = config?.playwrightDefaults !== false
      && !(config?.ignoreDefaultArgs ?? []).includes('--disable-popup-blocking');
    const openCount = results.opened.filter((value) => value === 'opened' || value === true).length;
    const bounded = openCount <= 1;
    return {
      observations: { ...results, openCount, pageCount: context.pages().length, driverDisablesBlocker },
      checks: [driverDisablesBlocker
        ? {
          name: 'parser-initiated popups bounded without activation',
          passed: null,
          detail: 'driver policy: Playwright passes --disable-popup-blocking by default; ignore it to exercise the browser blocker',
        }
        : { name: 'parser-initiated popups bounded without activation', passed: bounded }],
      limitations: [
        'Four unactivated popups are tested; this does not establish navigation-flood throttling or user-activated popup policy.',
        ...(driverDisablesBlocker
          ? ['Driver policy control: the Playwright default disables the browser popup blocker; this row is not a browser verdict.']
          : [])
      ],
    };
  }),
  contract('closed-shadow-encapsulation', async ({ page, context }) => {
    const dom = await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'closed-host';
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = '<button id="closed-button">Original local fixture</button>';
      document.body.append(host);
      return { exposed: host.shadowRoot !== null, queryFindsInternal: document.querySelector('#closed-button') !== null };
    });
    const client = await context.newCDPSession(page);
    try {
      const document = await client.send('DOM.getDocument', { depth: -1, pierce: true });
      const counts = { closed: 0, fixtureButton: 0 };
      const visit = node => {
        if (node.shadowRootType === 'closed') counts.closed++;
        if (node.attributes?.includes('closed-button')) counts.fixtureButton++;
        for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) visit(child);
      };
      visit(document.root);
      return {
        observations: { dom, cdp: counts },
        checks: [
          { name: 'ordinary DOM preserves closed-root encapsulation', passed: !dom.exposed && !dom.queryFindsInternal },
          { name: 'CDP diagnostic tree can inspect closed roots', passed: counts.closed > 0 && counts.fixtureButton > 0 },
        ],
        limitations: ['No encapsulation-weakening flag is enabled.'],
      };
    } finally { await client.detach(); }
  }),
  contract('navigation-flood-policy-observation', async ({ page, origin }) => {
    await page.goto(`${origin}/navigation-policy`);
    await page.waitForFunction(() => window.navigationProbeDone === true);
    const observations = await page.evaluate(() => ({
      ...window.navigationProbe, finalOrigin: location.origin, historyLength: history.length,
    }));
    return {
      observations,
      checks: [{ name: 'history mutation cannot change origin', passed: observations.finalOrigin === origin }],
      limitations: [
        'This is a 400-operation same-document burst, not a full cross-process navigation-flood benchmark.',
        'Effective operation count is recorded without asserting a fixed cross-version throttle threshold.',
      ],
    };
  }),
  contract('default-search-ui-observation', async () => ({
    observations: { requiredScenario: 'profile-lifecycle/search-engine', clientRequiresPersistentContext: true },
    checks: [{ name: 'search provider observed in a persistent profile', passed: null }],
    limitations: ['Playwright 1.65.1 rejects settings navigation in an isolated context; the persistent-profile scenario owns this observation.'],
  })),
  contract('realtime-audio-clock', async ({ page, origin }) => {
    await page.goto(`${origin}/audio`);
    await page.evaluate(() => {
      window.audioClockProbe = new Promise(resolve => {
        document.querySelector('#audio-start').addEventListener('click', async () => {
          let audio;
          let timer;
          try {
            audio = new AudioContext({ sampleRate: 48000 });
            await audio.resume();
            const oscillator = audio.createOscillator();
            const silence = audio.createGain();
            silence.gain.value = 0;
            oscillator.connect(silence).connect(audio.destination);
            const start = { audio: audio.currentTime, wall: performance.now() };
            const ended = new Promise(finish => {
              oscillator.addEventListener('ended', () => finish('ended'), { once: true });
              timer = setTimeout(() => finish('deadline'), 5000);
            });
            oscillator.start();
            oscillator.stop(start.audio + 0.25);
            const outcome = await ended;
            const end = { audio: audio.currentTime, wall: performance.now() };
            resolve({
              outcome, start, end, state: audio.state, sampleRate: audio.sampleRate,
              baseLatency: audio.baseLatency, outputLatency: audio.outputLatency ?? null,
              timestamp: audio.getOutputTimestamp?.() ?? null,
              audioSeconds: end.audio - start.audio, wallSeconds: (end.wall - start.wall) / 1000,
            });
          } catch (error) {
            resolve({ unavailable: error.name, message: error.message });
          } finally {
            clearTimeout(timer);
            await audio?.close().catch(() => {});
          }
        }, { once: true });
      });
    });
    await page.locator('#audio-start').scrollIntoViewIfNeeded();
    await page.locator('#audio-start').click();
    const observations = await page.evaluate(() => window.audioClockProbe);
    const available = !observations.unavailable && observations.outcome === 'ended';
    return {
      observations,
      checks: available ? [
        { name: 'scheduled realtime audio clock advances', passed: observations.audioSeconds >= 0.24 && observations.audioSeconds < 1 },
        { name: 'realtime audio does not use offline rendering speed', passed:
          observations.wallSeconds > 0.05 && observations.wallSeconds < 5 },
        { name: 'latency metadata is nonnegative', passed:
          observations.baseLatency >= 0 && (observations.outputLatency === null || observations.outputLatency >= 0) },
      ] : [{ name: 'realtime clock available', passed: null }],
      limitations: [
        'The graph is silent; no audible output or physical output-device latency is measured.',
        ...(available ? [] : ['A usable running output clock was not established on this host.']),
      ],
    };
  }),
  contract('cdp-focus-state', async ({ page, context }) => {
    const client = await context.newCDPSession(page);
    const sample = () => page.evaluate(() => ({
      focused: document.hasFocus(), visibility: document.visibilityState,
      hidden: document.hidden, activation: navigator.userActivation.isActive,
    }));
    try {
      const before = await sample();
      await client.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      const enabled = await sample();
      await client.send('Emulation.setFocusEmulationEnabled', { enabled: false });
      const disabled = await sample();
      return {
        observations: { before, enabled, disabled },
        checks: [{ name: 'visibility fields agree during focus changes', passed:
          [before, enabled, disabled].every(row => row.hidden === (row.visibility === 'hidden')) }],
        limitations: ['Focus emulation is explicitly exercised; this does not establish absence of all CDP signals.'],
      };
    } finally { await client.detach(); }
  }),
  contract('playwright-document-load-contract', async ({ page, context }) => {
    const client = await context.newCDPSession(page);
    const events = [];
    client.on('Runtime.consoleAPICalled', event => {
      events.push({
        type: event.type,
        arguments: (event.args ?? []).map(argument => ({
          type: argument.type, subtype: argument.subtype ?? null,
          hasValue: Object.hasOwn(argument, 'value'),
          fixtureValue: typeof argument.value === 'string' && argument.value.startsWith('original-console-')
            ? argument.value : null,
        })),
      });
    });
    try {
      await client.send('Runtime.enable');
      await page.evaluate(() => {
        console.debug('original-console-debug');
        console.log('original-console-log');
        console.info('original-console-info');
      });
      await client.send('Runtime.evaluate', { expression: '1', returnByValue: true });
      let completed = true;
      let error = null;
      try {
        await page.setContent('<!doctype html><p id="setcontent-marker">Original local document</p>', { timeout: 1500 });
      } catch (caught) {
        completed = false;
        error = caught.message.split('\n')[0];
      }
      const documentWritten = await page.locator('#setcontent-marker').count() === 1;
      return {
        observations: { events, completed, error, documentWritten },
        checks: [
          { name: 'document replacement writes its DOM', passed: documentWritten },
          { name: 'vanilla Playwright setContent completes', passed: completed },
        ],
        limitations: ['The other probes use HTTP fixtures so this client compatibility result cannot mask their Web API coverage.'],
      };
    } finally { await client.detach(); }
  }),
];
