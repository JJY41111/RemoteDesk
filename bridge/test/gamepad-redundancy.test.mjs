import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { acceptsGamepadSequence } from '../gamepad.mjs';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function sendGamepadState('), source.indexOf('function reportGamepad('));
function harness() {
  const packets = [], timers = [];
  const context = vm.createContext({ gamepadSequence: 0, gamepadSent: 0, gamepadSkipped: 0,
    gamepadRedundant: 0, gamepadActive: true, controlReady: true, canControl: true,
    gamepadChannel: { readyState: 'open', bufferedAmount: 0, send: data => packets.push(JSON.parse(data)) },
    performance: { now: () => 100 }, $: () => ({ checked: true }),
    setTimeout: (fn, ms) => timers.push({fn, ms}) });
  const send = vm.runInContext(`${code}; sendGamepadState`, context);
  return {context, packets, timers, send};
}
test('lost initial pad state recovers within short repeats instead of waiting for keepalive', () => {
  const h = harness();
  h.send({type: 'gamepad', buttons: Array(17).fill(1), axes: [0,0,0,0]});
  assert.equal(h.timers[0].ms, 12);
  assert.equal(h.timers[1].ms, 28);
  for (const timer of h.timers) timer.fn();
  assert.equal(h.packets.length, 3);
  assert.equal(h.context.gamepadRedundant, 2);
  assert.ok(acceptsGamepadSequence(h.packets[1], -1)); // initial packet lost
  assert.equal(acceptsGamepadSequence(h.packets[2], h.packets[1].seq), false);
});
test('a newer release cancels old button repeats and congested channels are never queued', () => {
  const h = harness();
  h.send({type: 'gamepad', buttons: Array(17).fill(1), axes: [0,0,0,0]});
  h.send({type: 'gamepad', buttons: Array(17).fill(0), axes: [0,0,0,0]});
  for (const timer of h.timers) timer.fn();
  assert.equal(h.packets.length, 4);
  assert.deepEqual(h.packets.slice(2).map(p => p.buttons[0]), [0,0]);
  h.context.gamepadChannel.bufferedAmount = 2048;
  assert.equal(h.send({type: 'gamepad'}), false);
  assert.equal(h.context.gamepadSkipped, 1);
});
