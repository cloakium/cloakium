// Harness mapping: probe → module → timeout → context options, the planned config
// rows, and which observations are expected to move between modes, seeds and
// config rows.
//
// Verdict meaning is profile-relative: a `false` verdict is a failed predicate
// that must be interpreted against the active profile policy. Under disabled or
// native control rows it is a diagnostic, not automatically a product defect.
// `null` (not evaluable) is coverage and is never scored as a pass or a failure.

export const outOfScope = [
  {
    area: 'cdp',
    reason:
      'Raw-CDP detection surface (Runtime/console serialisation, Target.attach signatures, Emulation focus state) is not covered here. The parent adds those descriptors.'
  },
  {
    area: 'input',
    reason:
      'Trusted input physics (pointer curves, wheel notches, key hold/rollover timing) is not covered here. The parent adds those descriptors.'
  },
  {
    area: 'native',
    reason:
      'Native/OS-level descriptors (process argv shape, sandbox flags, profile file layout, launcher behaviour) are not covered here. The parent adds those descriptors.'
  }
];

// The rows the parent plans to run. `args` are launch-argument templates that
// name a configuration; they are not literal switch values to reproduce.
export const configRows = [
  {
    id: 'headless-controlled-font',
    args: '--fingerprint=<seed> with the controlled font set, headless',
    expectation:
      'All checks that are evaluable must pass. Font-dependent checks may report coverage gaps but must not fail.',
    seedSensitive: true
  },
  {
    id: 'headed-private-display-controlled-font',
    args: '--fingerprint=<seed> with the controlled font set, headed on a private display',
    expectation:
      'Same verdicts as headless except window-framing checks, which may be coverage-unknown. Screen.* must not change.',
    seedSensitive: true
  },
  {
    id: 'persona-windows',
    args: '--fingerprint=<seed> --fingerprint-platform=windows (iterations 1 and 2)',
    expectation:
      'UA, Sec-CH-UA-Platform, navigator.platform and the GPU pool must move together: ch/*-matches-js, navigator/platform-coherent-with-ua and webgl identity checks must stay true. Iteration 2 must be identical to iteration 1.',
    seedSensitive: true
  },
  {
    id: 'persona-macos',
    args: '--fingerprint=<seed> --fingerprint-platform=macos (iterations 1 and 2)',
    expectation:
      'As windows, with the macOS colour/geometry set. Font checks may report fewer samples; that is a gap, not a failure.',
    seedSensitive: true
  },
  {
    id: 'altseed',
    args: '--fingerprint=<alternate-seed> in the same mode',
    expectation:
      'Seed-sensitive observations may differ from the primary seed. Every coherence, determinism and arithmetic check must still pass. Repeat reads inside the run must remain identical.',
    seedSensitive: true
  },
  {
    id: 'noise-off',
    args: 'omit --fingerprint entirely (Cloakium disable switch). --fingerprint=off is the Pro disable token, not a Cloakium mode; do not copy the Pro switch.',
    expectation:
      'Canvas/audio perturbation is absent: flat.changed may be 0 and digests may equal the native run. Nothing asserts that noise exists, so failed predicates here are diagnostics of the disabled policy, not automatic defects. Origin-scope comparisons become coverage-unknown.',
    seedSensitive: false
  },
  {
    id: 'noise-disabled-keep-seed',
    args: 'unsupported-policy-control: no independent --fingerprint-noise toggle is documented for Cloakium; this row is a control label, not a claimed mode',
    expectation:
      'Recorded as an unsupported policy control. Do not pretend noise was disabled independently; interpret any failed predicate as a diagnostic under an undocumented control, not as a product defect.',
    seedSensitive: true
  },
  {
    id: 'explicit-overrides',
    args: '--fingerprint=<seed> with explicit hardware-concurrency / device-memory / screen / max-touch-points / platform-version overrides',
    expectation:
      'navigator/screen observations equal the requested values; media-query coherence must hold (a non-zero touch count must not create a coarse primary pointer claim without support).',
    seedSensitive: true
  },
  {
    id: 'native-seedless',
    args: 'no fingerprint arguments (raw native defaults)',
    expectation:
      'All host-native values are recorded verbatim. Coherence checks must pass; automation-signal checks (UA headless token, navigator.webdriver) are the only ones expected to differ from a patched row.',
    seedSensitive: false
  }
];

// Which observations must be identical, and which may legitimately move.
// Paths are relative to the probe result's `observations` object.
export const comparison = {
  legend: {
    mustBeEqualAcrossModes: 'Identical in headless and headed runs with the same seed/persona.',
    mustBeEqualAcrossSeeds: 'Identical under two different seeds in the same mode.',
    mayVaryAcrossSeeds: 'Expected to change when the seed changes; compare shape, not value.',
    mayVaryAcrossConfig: 'Expected to change with a persona or explicit override row.',
    mayVaryAcrossModes: 'Window/viewport framing only; not a fingerprint value.'
  },
  probes: {
    'navigator-core': {
      module: 'navigator/core.mjs',
      mustBeEqualAcrossModes: ['navigator.userAgent', 'navigator.vendor', 'navigator.product', 'navigator.appName', 'navigator.appCodeName', 'navigator.plugins', 'navigator.languages'],
      mustBeEqualAcrossSeeds: ['navigator.userAgent', 'navigator.vendor', 'navigator.languages'],
      mayVaryAcrossSeeds: ['navigator.hardwareConcurrency', 'navigator.deviceMemory', 'navigator.maxTouchPoints'],
      mayVaryAcrossConfig: ['navigator.userAgent', 'navigator.platform', 'navigator.userAgentData', 'navigator.hardwareConcurrency', 'navigator.deviceMemory', 'navigator.maxTouchPoints']
    },
    'navigator-client-hints': {
      module: 'navigator/client-hints.mjs',
      mustBeEqualAcrossModes: ['js.base', 'js.highEntropy', 'entropy'],
      mustBeEqualAcrossSeeds: ['js.base', 'js.highEntropy'],
      mayVaryAcrossSeeds: [],
      mayVaryAcrossConfig: ['js.base.platform', 'entropy.platformVersion', 'entropy.architecture', 'entropy.bitness', 'entropy.model', 'js.base.brands']
    },
    'navigator-media-queries': {
      module: 'navigator/media-queries.mjs',
      mustBeEqualAcrossModes: ['queries'],
      mustBeEqualAcrossSeeds: ['queries', 'devicePixelRatio'],
      mayVaryAcrossSeeds: [],
      mayVaryAcrossConfig: ['queries["(pointer: coarse)"]', 'queries["(any-pointer: coarse)"]', 'queries["(hover: none)"]', 'queries["(color-gamut: p3)"]', 'resolutions'],
      mayVaryAcrossModes: ['queries["(orientation: landscape)"]']
    },
    'screen-geometry': {
      module: 'screen/geometry.mjs',
      mustBeEqualAcrossModes: ['first.screen'],
      mustBeEqualAcrossSeeds: ['first.screen.colorDepth', 'first.screen.pixelDepth'],
      mayVaryAcrossSeeds: ['first.screen.width', 'first.screen.height', 'first.screen.availWidth', 'first.screen.availHeight', 'first.screen.orientation', 'first.window.devicePixelRatio'],
      mayVaryAcrossConfig: ['first.screen', 'first.window'],
      mayVaryAcrossModes: ['first.window', 'first.visualViewport']
    },
    'screen-multidisplay': {
      module: 'screen/multidisplay.mjs',
      mustBeEqualAcrossModes: ['isExtended', 'permission'],
      mustBeEqualAcrossSeeds: ['isExtended', 'permission'],
      mayVaryAcrossSeeds: [],
      mayVaryAcrossConfig: ['details']
    },
    'canvas2d-readback': {
      module: 'render/canvas2d.mjs',
      mustBeEqualAcrossModes: ['digests', 'flat', 'encode', 'decoded', 'size'],
      mustBeEqualAcrossSeeds: [],
      mayVaryAcrossSeeds: ['digests', 'flat', 'echo', 'encode.blobDigest', 'decoded'],
      mayVaryAcrossConfig: ['digests', 'flat', 'echo', 'encode.blobDigest']
    },
    'canvas2d-text': {
      module: 'render/canvas2d-text.mjs',
      mustBeEqualAcrossModes: ['widths', 'metrics'],
      mustBeEqualAcrossSeeds: ['widths', 'metrics'],
      mayVaryAcrossSeeds: ['digests'],
      mayVaryAcrossConfig: ['widths', 'metrics', 'digests']
    },
    'offscreen-worker': {
      module: 'render/offscreen-worker.mjs',
      mustBeEqualAcrossModes: ['domDigest'],
      mustBeEqualAcrossSeeds: [],
      mayVaryAcrossSeeds: ['domDigest', 'offscreenDigest', 'offscreenRepeatDigest', 'blob.digest', 'blob.repeatDigest'],
      mayVaryAcrossConfig: ['domDigest', 'offscreenDigest', 'blob.digest']
    },
    'svg-raster': {
      module: 'render/svg.mjs',
      mustBeEqualAcrossModes: ['digests'],
      mustBeEqualAcrossSeeds: [],
      mayVaryAcrossSeeds: ['digests'],
      mayVaryAcrossConfig: ['digests']
    },
    'webgl-surface': {
      module: 'render/webgl.mjs',
      mustBeEqualAcrossModes: ['webgl1.params', 'webgl1.unmasked', 'webgl1.extensions', 'webgl1.precision'],
      mustBeEqualAcrossSeeds: ['webgl1.extensions', 'webgl1.precision'],
      mayVaryAcrossSeeds: ['webgl1.params', 'webgl1.unmasked', 'webgl1.digest', 'webgl2.params', 'webgl2.unmasked', 'webgl2.digest'],
      mayVaryAcrossConfig: ['webgl1.params', 'webgl1.unmasked', 'webgl1.extensions', 'webgl2']
    },
    'webgpu-adapter': {
      module: 'render/webgpu.mjs',
      mustBeEqualAcrossModes: ['preferredFormat'],
      mustBeEqualAcrossSeeds: [],
      mayVaryAcrossSeeds: ['adapter.vendor', 'adapter.architecture', 'adapter.device', 'adapter.description', 'adapter.features', 'adapter.limits'],
      mayVaryAcrossConfig: ['adapter', 'adapterRepeat', 'device']
    },
    'audio-offline': {
      module: 'render/audio-offline.mjs',
      mustBeEqualAcrossModes: ['offline', 'first.channels', 'first.length', 'first.sampleRate', 'first.peak', 'first.headPeak', 'first.tailPeak', 'ramp'],
      mustBeEqualAcrossSeeds: ['offline.frames', 'offline.sampleRate', 'offline.renderedSeconds', 'first.peak', 'ramp'],
      mayVaryAcrossSeeds: ['first.digest', 'first.rightDigest', 'second.digest'],
      mayVaryAcrossConfig: ['first.digest', 'second.digest']
    },
    'audio-worklet': {
      module: 'render/audio-worklet.mjs',
      mustBeEqualAcrossModes: ['first.length', 'first.sampleRate', 'first.minimum', 'first.maximum'],
      mustBeEqualAcrossSeeds: ['first.length', 'first.minimum', 'first.maximum'],
      mayVaryAcrossSeeds: ['first.digest', 'second.digest'],
      mayVaryAcrossConfig: ['first.digest']
    },
    'math-numeric': {
      module: 'numeric/math.mjs',
      mustBeEqualAcrossModes: ['constants', 'exact', 'integrals', 'violations'],
      mustBeEqualAcrossSeeds: ['constants', 'exact', 'integrals', 'violations'],
      mayVaryAcrossSeeds: [],
      mayVaryAcrossConfig: []
    },
    'font-metrics': {
      module: 'text/font-metrics.mjs',
      mustBeEqualAcrossModes: ['widths', 'widthsAt32', 'scaling'],
      mustBeEqualAcrossSeeds: ['widths', 'widthsAt32', 'availability'],
      mayVaryAcrossSeeds: ['digests'],
      mayVaryAcrossConfig: ['widths', 'widthsAt32', 'availability', 'digests']
    },
    'system-colors': {
      module: 'text/system-colors.mjs',
      mustBeEqualAcrossModes: ['canvas', 'computed'],
      mustBeEqualAcrossSeeds: ['canvas', 'computed'],
      mayVaryAcrossSeeds: [],
      mayVaryAcrossConfig: ['canvas', 'computed']
    },
    'speech-voices': {
      module: 'api/speech-voices.mjs',
      mustBeEqualAcrossModes: ['voices'],
      mustBeEqualAcrossSeeds: ['voices'],
      mayVaryAcrossSeeds: [],
      mayVaryAcrossConfig: ['voices']
    },
    'media-devices': {
      module: 'api/media-devices.mjs',
      mustBeEqualAcrossModes: ['devices', 'constraints', 'codecSupport'],
      mustBeEqualAcrossSeeds: ['devices', 'constraints', 'codecSupport'],
      mayVaryAcrossSeeds: [],
      mayVaryAcrossConfig: ['devices']
    },
    'api-drm': {
      module: 'api/drm.mjs',
      mustBeEqualAcrossModes: ['first', 'probedKeySystems'],
      mustBeEqualAcrossSeeds: ['first', 'probedKeySystems'],
      mayVaryAcrossSeeds: [],
      mayVaryAcrossConfig: []
    },
    'api-webauthn': {
      module: 'api/webauthn.mjs',
      mustBeEqualAcrossModes: ['uvpaa', 'conditional', 'capabilities'],
      mustBeEqualAcrossSeeds: ['uvpaa', 'conditional', 'capabilities'],
      mayVaryAcrossSeeds: [],
      mayVaryAcrossConfig: []
    },
    'api-capability-presence': {
      module: 'api/capability-presence.mjs',
      mustBeEqualAcrossModes: ['inventory'],
      mustBeEqualAcrossSeeds: ['inventory', 'storageApis'],
      mayVaryAcrossSeeds: [],
      mayVaryAcrossConfig: ['inventory.share', 'inventory.canShare']
    },
    'origin-scope': {
      module: 'origin/origin-scope.mjs',
      mustBeEqualAcrossModes: ['primary.first.canvasDigest', 'primary.first.audioDigest'],
      mustBeEqualAcrossSeeds: [],
      mayVaryAcrossSeeds: ['primary.first.canvasDigest', 'primary.first.audioDigest', 'cross.first.canvasDigest', 'cross.first.audioDigest'],
      mayVaryAcrossConfig: ['primary', 'cross']
    }
  }
};

// Checks that may legitimately stay null in some rows. Everything else that is
// evaluable must pass in every row.
export const optionalChecks = {
  'navigator-core': ['navigator/device-memory-standard', 'navigator/user-activation-coherent'],
  'navigator-client-hints': [],
  'navigator-media-queries': ['mq/coarse-implies-touch', 'mq/hover-implies-any-hover', 'mq/color-gamut-hierarchy', 'mq/resolution-matches-dpr'],
  'screen-geometry': ['screen/outer-not-smaller-than-half-inner', 'screen/visual-viewport-within-layout'],
  'screen-multidisplay': ['multidisplay/get-screen-details-present', 'multidisplay/details-consistent-when-granted', 'multidisplay/screen-count-matches-extended'],
  'canvas2d-readback': [],
  'canvas2d-text': ['text/families-distinguished', 'text/emoji-glyph-present', 'text/cjk-glyph-present'],
  'offscreen-worker': [],
  'svg-raster': [],
  'webgl-surface': ['webgl/unmasked-non-empty', 'webgl/webgl2-available', 'webgl/webgl2-version-string', 'webgl/context-loss-restores-identity'],
  'webgpu-adapter': [],
  'audio-offline': ['audio/ramp-accuracy'],
  'audio-worklet': [],
  'math-numeric': [],
  'font-metrics': ['font/families-distinguished', 'font/check-agrees-with-render'],
  'system-colors': ['colors/canvas-text-contrast', 'colors/highlight-contrast', 'colors/css-and-canvas-agree'],
  'speech-voices': ['speech/voices-populated', 'speech/voice-fields-valid', 'speech/default-unique', 'speech/voice-uri-unique'],
  'media-devices': ['media/open-codecs-playable'],
  'api-drm': [],
  'api-webauthn': ['webauthn/conditional-mediation', 'webauthn/client-capabilities'],
  'api-capability-presence': ['presence/share-consistent'],
  'origin-scope': ['origin/cross-origin-differs', 'origin/audio-cross-origin-differs']
};
