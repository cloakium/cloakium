export const MEDIA_QUERIES = [
  '(pointer: fine)',
  '(pointer: coarse)',
  '(pointer: none)',
  '(any-pointer: fine)',
  '(any-pointer: coarse)',
  '(hover: hover)',
  '(hover: none)',
  '(any-hover: hover)',
  '(color)',
  '(min-color: 8)',
  '(color-gamut: srgb)',
  '(color-gamut: p3)',
  '(color-gamut: rec2020)',
  '(dynamic-range: standard)',
  '(dynamic-range: high)',
  '(video-dynamic-range: high)',
  '(forced-colors: active)',
  '(prefers-color-scheme: light)',
  '(prefers-color-scheme: dark)',
  '(prefers-reduced-motion: reduce)',
  '(prefers-reduced-transparency: reduce)',
  '(prefers-contrast: more)',
  '(inverted-colors: inverted)',
  '(monochrome)',
  '(display-mode: browser)',
  '(orientation: landscape)',
  '(pointer: fine) and (hover: hover)',
];

export const HINTS = ['platformVersion', 'architecture', 'bitness', 'model', 'uaFullVersion', 'fullVersionList', 'wow64'];

export const PERMISSIONS = [
  'clipboard-read',
  'clipboard-write',
  'notifications',
  'camera',
  'microphone',
  'geolocation',
  'midi',
  'persistent-storage',
  'local-fonts',
  'window-management',
  'storage-access',
];

export const NATIVE_APIS = [
  "Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver')",
  "Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency')",
  "Object.getOwnPropertyDescriptor(Navigator.prototype, 'plugins')",
  "Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgentData')",
  "Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'getImageData')",
  "Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'putImageData')",
  "Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'toDataURL')",
  "Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'toBlob')",
  "Object.getOwnPropertyDescriptor(WebGLRenderingContext.prototype, 'getParameter')",
  "Object.getOwnPropertyDescriptor(WebGL2RenderingContext.prototype, 'readPixels')",
  "Object.getOwnPropertyDescriptor(OfflineAudioContext.prototype, 'startRendering')",
  "Object.getOwnPropertyDescriptor(AudioBuffer.prototype, 'getChannelData')",
  "Object.getOwnPropertyDescriptor(Permissions.prototype, 'query')",
  "Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, 'getHighEntropyValues')",
];

export function invariant(observations, checks) {
  const failed = checks.filter(([, ok]) => !ok).map(([label]) => label);
  if (failed.length) {
    const error = new Error(`invariant failed: ${failed.join(', ')}\n${JSON.stringify(observations)}`);
    throw error;
  }
  return observations;
}

export async function openPage(context, url) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load' });
  return page;
}
