import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionGrace } from '../connection-grace.mjs';
test('transient disconnect recovers and a later disconnect gets a fresh deadline', () => {
  const grace = new ConnectionGrace(15000);
  assert.equal(grace.update('disconnected', 0), false);
  assert.equal(grace.update('connecting', 14000), false);
  assert.equal(grace.update('connected', 14500), false);
  assert.equal(grace.update('disconnected', 20000), false);
  assert.equal(grace.update('disconnected', 34999), false);
  assert.equal(grace.update('disconnected', 35000), true);
});
test('terminal failure is not hidden by the recovery grace period', () => {
  assert.equal(new ConnectionGrace().update('failed', 0), true);
  assert.equal(new ConnectionGrace().update('closed', 0), true);
});
