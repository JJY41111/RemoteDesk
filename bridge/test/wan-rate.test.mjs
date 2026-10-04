import assert from 'node:assert/strict';
import test from 'node:test';
import { WanRateController } from '../wan-rate.mjs';

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
