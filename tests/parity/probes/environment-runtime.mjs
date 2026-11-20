// Environment parity probes: user activation and audio state, plus value
// consistency across same-origin frames, workers and distinct origins.

import { invariant, openPage } from './environment-support.mjs';

const activationAudio = {
  name: 'environment/activation-audio-state',
  timeoutMs: 30000,
  async run({ context, origin }) {
    const page = await openPage(context, `${origin}/`);
    await page.setContent(
      '<!doctype html><html><body><button id="go" type="button">go</button></body></html>',
    );
    const before = await page.evaluate(() => ({
      userActivation: {
        isActive: navigator.userActivation.isActive,
        hasBeenActive: navigator.userActivation.hasBeenActive,
      },
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
    }));
    const audio = await page.evaluate(async () => {
      const bounded = (promise, ms) =>
        Promise.race([
          promise.then(
            (value) => ({ outcome: 'resolved', value: String(value) }),
            (error) => ({ outcome: 'rejected', value: error.name }),
          ),
          new Promise((resolve) => setTimeout(() => resolve({ outcome: 'timeout', value: null }), ms)),
        ]);
      const audioContext = new AudioContext();
      window.__ctx = audioContext;
      const initial = audioContext.state;
      const element = new Audio();
      const play = await bounded(element.play(), 1500);
      let resumeBeforeGesture = null;
      if (initial !== 'running') resumeBeforeGesture = await bounded(audioContext.resume(), 1500);
      return {
        initial,
        stateAfterUngesturedResume: audioContext.state,
        sampleRate: audioContext.sampleRate,
        baseLatency: audioContext.baseLatency ?? null,
        destinationChannels: audioContext.destination.channelCount,
        maxChannelCount: audioContext.destination.maxChannelCount,
        play,
        resumeBeforeGesture,
        elementMuted: element.muted,
        elementVolume: element.volume,
        elementPaused: element.paused,
      };
    });
    await page.click('#go', { timeout: 4000 });
    const after = await page.evaluate(async () => {
      const audioContext = window.__ctx;
      const bounded = (promise, ms) =>
        Promise.race([
          promise.then(
            (value) => ({ outcome: 'resolved', value: String(value) }),
            (error) => ({ outcome: 'rejected', value: error.name }),
          ),
          new Promise((resolve) => setTimeout(() => resolve({ outcome: 'timeout', value: null }), ms)),
        ]);
      const resume = audioContext.state === 'running' ? { outcome: 'already-running', value: null } : await bounded(audioContext.resume(), 1500);
      return {
        userActivation: {
          isActive: navigator.userActivation.isActive,
          hasBeenActive: navigator.userActivation.hasBeenActive,
        },
        audioContextState: audioContext.state,
        resume,
        buttonClicked: document.body.dataset.clicked ?? null,
      };
    });
    const observed = { before, audio, after };
    return invariant(observed, [
      ['activationHasBeenActiveAfterClick', after.userActivation.hasBeenActive === true],
      ['audioContextNotClosed', after.audioContextState !== 'closed'],
      ['audioContextRunsAfterGesture', after.audioContextState === 'running'],
      ['sampleRateStandard', audio.sampleRate >= 8000],
      ['destinationHasChannels', audio.destinationChannels >= 1],
    ]);
  },
};

const workerIframeConsistency = {
  name: 'environment/worker-iframe-consistency',
  async run({ context, origin }) {
    const page = await openPage(context, `${origin}/`);
    await page.setContent(
      `<!doctype html><html><body><iframe id="same" style="width:300px;height:200px"></iframe></body></html>`,
    );
    const observed = await page.evaluate(async () => {
      const collect = (navigatorObject, windowObject) => ({
        userAgent: navigatorObject.userAgent,
        platform: navigatorObject.platform,
        languages: navigatorObject.languages.join(','),
        hardwareConcurrency: navigatorObject.hardwareConcurrency,
        deviceMemory: navigatorObject.deviceMemory ?? null,
        maxTouchPoints: navigatorObject.maxTouchPoints ?? null,
        webdriver: navigatorObject.webdriver,
        screenWidth: windowObject?.screen?.width ?? null,
        screenHeight: windowObject?.screen?.height ?? null,
        devicePixelRatio: windowObject ? Number(windowObject.devicePixelRatio.toFixed(4)) : null,
      });
      const top = collect(navigator, window);

      const frame = document.querySelector('#same');
      await new Promise((resolve) => {
        frame.addEventListener('load', resolve, { once: true });
        frame.srcdoc = '<!doctype html><html><body>frame</body></html>';
      });
      const frameValues = collect(frame.contentWindow.navigator, frame.contentWindow);

      const workerSource = `self.onmessage = () => postMessage(${JSON.stringify('collect')});`;
      const httpFrame = document.createElement('iframe');
      httpFrame.style.cssText = 'width:320px;height:200px';
      document.body.append(httpFrame);
      await new Promise((resolve) => {
        httpFrame.addEventListener('load', resolve, { once: true });
        httpFrame.src = '/frame';
      });
      const httpDocument = httpFrame.contentDocument;
      const fixture = {
        hasInput: Boolean(httpDocument?.querySelector('#frame-input')),
        hasButton: Boolean(httpDocument?.querySelector('#frame-button')),
        values: collect(httpFrame.contentWindow.navigator, httpFrame.contentWindow),
      };

      const worker = new Worker(URL.createObjectURL(new Blob([`
        self.onmessage = () => postMessage({
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          languages: navigator.languages.join(','),
          hardwareConcurrency: navigator.hardwareConcurrency,
          deviceMemory: navigator.deviceMemory ?? null,
          maxTouchPoints: navigator.maxTouchPoints ?? null,
          webdriver: navigator.webdriver,
          devicePixelRatio: self.devicePixelRatio ?? null,
        });
      `], { type: 'text/javascript' })));
      const workerValues = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker timeout')), 5000);
        worker.addEventListener('message', (event) => {
          clearTimeout(timer);
          resolve(event.data);
        });
        worker.addEventListener('error', (event) => {
          clearTimeout(timer);
          reject(new Error(`worker error: ${event.message}`));
        });
        worker.postMessage(workerSource);
      });
      worker.terminate();

      return {
        top,
        frame: frameValues,
        worker: workerValues,
        fixture,
        frameSrc: frame.src || 'about:srcdoc',
      };
    });
    const compare = (left, right, keys) =>
      keys.filter((key) => right[key] !== null && right[key] !== undefined && left[key] !== right[key]);
    const sharedKeys = ['userAgent', 'platform', 'languages', 'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints', 'webdriver'];
    const frameDiffs = compare(observed.top, observed.frame, sharedKeys);
    const workerDiffs = compare(observed.top, observed.worker, sharedKeys);
    const fixtureDiffs = compare(observed.top, observed.fixture.values, sharedKeys);
    observed.differences = { frame: frameDiffs, worker: workerDiffs, fixture: fixtureDiffs };
    return invariant(observed, [
      ['iframeIsSameOrigin', observed.frameSrc.includes('srcdoc')],
      ['frameMatchesTop', frameDiffs.length === 0],
      ['workerMatchesTop', workerDiffs.length === 0],
      ['servedFrameHasFixtureControls', observed.fixture.hasInput && observed.fixture.hasButton],
      ['servedFrameMatchesTop', fixtureDiffs.length === 0],
      ['workerSharesUserAgent', observed.worker.userAgent === observed.top.userAgent],
      ['workerSharesHardwareConcurrency', observed.worker.hardwareConcurrency === observed.top.hardwareConcurrency],
    ]);
  },
};

const crossOriginCoherence = {
  name: 'environment/cross-origin-coherence',
  async run({ context, origin, crossOrigin }) {
    const collect = async (url) => {
      const page = await openPage(context, `${url}/`);
      await page.setContent('<!doctype html><html><body></body></html>');
      const values = await page.evaluate(() => ({
        origin: location.origin,
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        languages: navigator.languages.join(','),
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory ?? null,
        webdriver: navigator.webdriver,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        screen: [screen.width, screen.height, screen.availWidth, screen.availHeight],
        brands: navigator.userAgentData?.brands?.map((brand) => `${brand.brand}/${brand.version}`).join(',') ?? null,
      }));
      await page.close();
      return values;
    };
    const first = await collect(origin);
    const second = await collect(crossOrigin);
    const keys = Object.keys(first).filter((key) => key !== 'origin');
    const differences = keys.filter((key) => JSON.stringify(first[key]) !== JSON.stringify(second[key]));
    const observed = { primary: first, secondary: second, differences };
    return invariant(observed, [
      ['originsAreDistinct', first.origin !== second.origin],
      ['hostValuesOriginIndependent', differences.length === 0],
      ['timezoneApplied', first.timezone === 'UTC' && second.timezone === 'UTC'],
    ]);
  },
};


export const probes = [activationAudio, workerIframeConsistency, crossOriginCoherence];
