import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the exact browser policy without requiring Safari or a DOM.
const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const policy = source.slice(source.indexOf('function receiverTargetFor('),
  source.indexOf('function applyReceiverLatency('));
const calculate = vm.runInNewContext(`${policy}; receiverTargetFor`);

test('receiver control never inflates an already low default or guesses missing measurements', () => {
  assert.equal(calculate('video', {videoTargetMs: 28}, null), null);
  assert.equal(calculate('video', {}, null), null);
  assert.equal(calculate('audio', {audioTargetMs: 90}, null), null);
});
test('actual jitter buffer enables control when target counters are missing', () => {
  assert.equal(calculate('video', {videoBufferMs: 240}, null), 80);
  assert.equal(calculate('audio', {audioBufferMs: 600}, null), 100);
  assert.equal(calculate('video', {videoBufferMs: 240}, null, 160), 160);
});
test('receiver target respects measured network floor and route changes without a conflicting cap', () => {
  assert.equal(calculate('video', {videoTargetMs: 200, videoMinimumMs: 90, rttMs: 35}, null), 120);
  assert.equal(calculate('video', {videoMinimumMs: 330, rttMs: 700}, 80), 400);
  assert.equal(calculate('audio', {audioMinimumMs: 400}, 100), 420);
  assert.equal(calculate('video', {videoTargetMs: 150, videoMinimumMs: 140}, null), null);
});
test('active target adapts down on a clean route and invalid floor stats cannot poison it', () => {
  assert.equal(calculate('video', {videoMinimumMs: NaN, rttMs: -1}, 400), 80);
  assert.equal(calculate('video', {}, 80, 120), 120);
});
