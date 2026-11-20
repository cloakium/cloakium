import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceLimitsWithinAdapter } from '../support/gpu-contracts.mjs';

test('default device limits may legitimately be lower than adapter capabilities', () => {
  const adapter = { maxTextureDimension2D: 16384, maxBufferSize: 2147483648 };
  assert.equal(deviceLimitsWithinAdapter({ maxTextureDimension2D: 8192, maxBufferSize: 268435456 }, adapter), true);
  assert.equal(deviceLimitsWithinAdapter(adapter, adapter), true);
});

test('device limits cannot exceed the adapter or contain invalid values', () => {
  const adapter = { maxTextureDimension2D: 16384, maxBufferSize: 2147483648 };
  assert.equal(deviceLimitsWithinAdapter({ maxTextureDimension2D: 32768, maxBufferSize: 268435456 }, adapter), false);
  assert.equal(deviceLimitsWithinAdapter({ maxTextureDimension2D: 8192, maxBufferSize: Infinity }, adapter), false);
  assert.equal(deviceLimitsWithinAdapter({}, adapter), false);
});
