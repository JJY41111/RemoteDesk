import test from 'node:test';
import assert from 'node:assert/strict';
import { nextInputRestart } from '../input-restart.mjs';

test('READY followed by immediate crashes exhausts the retry budget', () => {
  let retries = 0;
  for (const expected of [1, 2, 3, null]) {
    retries = nextInputRestart(retries, 100);
    assert.equal(retries, expected);
  }
});
test('startup failures are bounded and only stable operation resets retries', () => {
  assert.equal(nextInputRestart(3, 0), null);
  assert.equal(nextInputRestart(3, 29_999), null);
  assert.equal(nextInputRestart(3, 30_000), 1);
});
