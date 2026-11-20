export function deviceLimitsWithinAdapter(device, adapter) {
  return ['maxTextureDimension2D', 'maxBufferSize'].every(name =>
    Number.isFinite(device?.[name]) && device[name] > 0 &&
    Number.isFinite(adapter?.[name]) && device[name] <= adapter[name]);
}
