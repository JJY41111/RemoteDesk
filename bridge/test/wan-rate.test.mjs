import assert from 'node:assert/strict';
import test from 'node:test';
import { WanRateController, rttControlEnabled } from '../wan-rate.mjs';

test('RTT_CONTROL accepts on/off and defaults to existing enabled behavior', () => {
  const previous = process.env.RTT_CONTROL;
  try {
    delete process.env.RTT_CONTROL;
    assert.equal(rttControlEnabled(), true);
    process.env.RTT_CONTROL = 'off';
    assert.equal(rttControlEnabled(), false);
    assert.equal(rttControlEnabled('on'), true);
    assert.throws(() => rttControlEnabled('false'), /RTT_CONTROL must be on or off/);
  } finally {
    if (previous === undefined) delete process.env.RTT_CONTROL;
    else process.env.RTT_CONTROL = previous;
  }
});

test('disabled RTT mode never reads RTT, including initialization and counter reset', () => {
  const c = new WanRateController(8000, { rttBackoffEnabled: false });
  const report = (received, lost) => ({ received, lost, nacks: 0,
    get rttMs() { throw new Error('RTT must not be consumed in loss-only mode'); } });
  c.update(report(1000, 0));
  assert.equal(c.update(report(2000, 100)).reason, 'loss');
  for (let i = 3; i <= 5; i++) c.update(report(i * 1000, 100));
  assert.equal(c.targetKbps, 6100);
  c.update(report(100, 0));
  assert.deepEqual(c.rttWindow, []);
  assert.equal(c.lastQueueDelayMs, null);
});

test('loss-only mode ignores RTT cuts and RTT recovery holds but still reacts to loss', () => {
  const c = new WanRateController(8000, { rttBackoffEnabled: false });
  c.update({ received: 1000, lost: 0, nacks: 0, rttMs: 30 });
  c.update({ received: 2000, lost: 0, nacks: 100, rttMs: 700 });
  assert.equal(c.targetKbps, 8000);
  assert.equal(c.update({ received: 3000, lost: 100, nacks: 200, rttMs: 900 }).kbps, 5600);
  for (let i = 4; i <= 6; i++) c.update({ received: i * 1000, lost: 100, nacks: 200, rttMs: 900 });
  assert.equal(c.targetKbps, 6100, 'high RTT must not block loss-only clean recovery');
});

test('live RTT switch resets delay history without resetting loss accounting or current bitrate', () => {
  const c = new WanRateController();
  c.update({ received: 1000, lost: 0, nacks: 0, rttMs: 30 });
  c.update({ received: 2000, lost: 0, nacks: 0, rttMs: 500 });
  assert.equal(c.targetKbps, 6800);
  c.setRttBackoffEnabled(false);
  assert.equal(c.targetKbps, 6800);
  assert.equal(c.update({ received: 3000, lost: 100, nacks: 10, rttMs: 900 }).kbps, 4700);
  c.setRttBackoffEnabled(true);
  assert.equal(c.update({ received: 4000, lost: 100, nacks: 10, rttMs: 900 }), null);
  assert.equal(c.targetKbps, 4700, 'old low RTT baseline must not survive re-enabling');
  assert.equal(c.update({ received: 5000, lost: 100, nacks: 10, rttMs: 4000 }).reason, 'rtt-rise');
});

test('severe loss backs off without changing frame rate or resolution', () => {
  const controller = new WanRateController();
  assert.equal(controller.update({ received: 1000, lost: 0, nacks: 0 }), null);
  assert.equal(controller.update({ received: 2000, lost: 100, nacks: 80 }).kbps, 5600);
  assert.equal(controller.update({ received: 3000, lost: 200, nacks: 160 }).kbps, 3900);
  assert.equal(controller.update({ received: 4000, lost: 300, nacks: 240 }).kbps, 2700);
  assert.equal(controller.update({ received: 5000, lost: 400, nacks: 320 }).kbps, 2200);
});

test('clean connection retains quality and recovers within three fresh reports', () => {
  const controller = new WanRateController(8000);
  controller.update({ received: 1000, lost: 0, nacks: 0 });
  for (let i = 1; i <= 12; i++)
    controller.update({ received: 1000 + i * 1000, lost: 0, nacks: 0 });
  assert.equal(controller.targetKbps, 8000);
  controller.update({ received: 14000, lost: 10, nacks: 20 });
  assert.equal(controller.targetKbps, 6800);
  for (let i = 1; i <= 3; i++)
    controller.update({ received: 14000 + i * 1000, lost: 10, nacks: 20 });
  assert.equal(controller.targetKbps, 7400);
  for (let i = 4; i <= 6; i++)
    controller.update({ received: 14000 + i * 1000, lost: 10, nacks: 20 });
  assert.equal(controller.targetKbps, 8000);
});

test('stale and malformed reports do not alter bitrate', () => {
  const controller = new WanRateController(5000);
  assert.equal(controller.update({ received: -1, lost: 0, nacks: 0 }), null);
  controller.update({ received: 1000, lost: 0, nacks: 0 });
  assert.equal(controller.update({ received: 1000, lost: 0, nacks: 0 }), null);
  assert.equal(controller.update({ received: 800, lost: 0, nacks: 0 }), null);
  assert.equal(controller.targetKbps, 5000);
});

test('a burst with almost no received packets still backs off', () => {
  const controller = new WanRateController();
  controller.update({ received: 1000, lost: 0, nacks: 0 });
  assert.equal(controller.update({ received: 1001, lost: 300, nacks: 30 }).kbps,
    5600);
});

test('repaired packets do not trigger repeated bitrate cuts for NACK requests alone', () => {
  const controller = new WanRateController();
  controller.update({ received: 1000, lost: 0, nacks: 0 });
  for (let i = 1; i <= 12; i++) {
    controller.update({ received: 1000 + i * 1000, lost: 0, nacks: i * 80 });
    assert.equal(controller.targetKbps, 8000);
  }
});

test('late packet recovery does not keep bitrate stuck below the requested quality', () => {
  const controller = new WanRateController(5000);
  controller.update({ received: 1000, lost: 0, nacks: 0 });
  controller.update({ received: 2000, lost: 100, nacks: 80 });
  assert.equal(controller.targetKbps, 3500);
  controller.update({ received: 3000, lost: 90, nacks: 90 });
  controller.update({ received: 4000, lost: 70, nacks: 110 });
  controller.update({ received: 5000, lost: 50, nacks: 120 });
  assert.equal(controller.targetKbps, 3800);
  for (let i = 1; i <= 30; i++)
    controller.update({ received: 5000 + i * 1000, lost: 50, nacks: 120 + i * 20 });
  assert.equal(controller.targetKbps, 5000, 'mobile mode must keep its 5 Mbps ceiling');
});


test('RTT surge backs off before any loss and holds recovery while queue delay persists', () => {
  const c = new WanRateController();
  c.update({ received: 1000, lost: 0, nacks: 0, rttMs: 35 });
  assert.equal(c.update({ received: 2000, lost: 0, nacks: 0, rttMs: 441 }).kbps, 6800);
  assert.equal(c.targetKbps, 6800);
  assert.equal(c.update({ received: 2000, lost: 0, nacks: 0, rttMs: 765 }), null);
  for (let i = 3; i <= 5; i++) c.update({ received: i * 1000, lost: 0, nacks: 0, rttMs: 130 });
  assert.equal(c.targetKbps, 6800, 'zero loss cannot regrow bitrate while RTT is inflated');
  for (let i = 6; i <= 8; i++) c.update({ received: i * 1000, lost: 0, nacks: 0, rttMs: 35 });
  assert.equal(c.targetKbps, 7400);
});

test('fixed high RTT and a one-sample moderate mobile fluctuation preserve quality', () => {
  const c = new WanRateController();
  for (let i = 1; i <= 12; i++) c.update({ received: i * 1000, lost: 0, nacks: 0, rttMs: 300 });
  assert.equal(c.targetKbps, 8000);
  c.update({ received: 13000, lost: 0, nacks: 0, rttMs: 500 });
  c.update({ received: 14000, lost: 0, nacks: 0, rttMs: 300 });
  assert.equal(c.targetKbps, 8000);
});

test('a route change ages out its old RTT baseline instead of permanently crushing quality', () => {
  const c = new WanRateController();
  c.update({ received: 1000, lost: 0, nacks: 0, rttMs: 30 });
  for (let i = 2; i <= 100; i++) c.update({ received: i * 1000, lost: 0, nacks: 0, rttMs: 350 });
  assert.equal(c.targetKbps, 8000);
});
