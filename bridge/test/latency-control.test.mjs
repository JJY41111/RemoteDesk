import test from 'node:test';
import assert from 'node:assert/strict';
import rtc from 'node-datachannel';
import { LatencyControl } from '../latency-control.mjs';
import { AudioBuffer } from '../audio-buffer.mjs';

test('audio queue control never activates the RTP extension that froze iPad rendering', () => {
  const rtp = new rtc.RtpPacketizationConfig(77, 'test', 96, 90000);
  const mode = new LatencyControl(rtp);
  for (const enabled of [true, false, true]) {
    const state = mode.setEnabled(enabled);
    assert.equal(rtp.playoutDelayId, 0);
    assert.equal(state.videoHintNegotiated, false);
    assert.equal(state.videoMaxMs, null);
    assert.equal(state.applied, false);
  }
  assert.throws(() => mode.setEnabled('false'), /boolean/);
});

test('mode trims existing and future audio backlog with sample alignment, and can be undone', () => {
  const mode = new LatencyControl({});
  const pcm = new AudioBuffer();
  mode.attachAudioBuffer(pcm);
  const source = Buffer.alloc(19203);
  for (let i = 0; i < source.length; i++) source[i] = i % 251;
  pcm.push(source);
  const state = mode.setEnabled(true);
  assert.equal(state.videoHintNegotiated, false);
  assert.equal(state.applied, true);
  assert.equal(state.audioQueueLimitMs, 60);
  assert.equal(pcm.pcm.length, 7683);
  assert.deepEqual(pcm.take(), source.subarray(11520, 15360));
  mode.setEnabled(false);
  pcm.resetSource();
  pcm.push(source);
  assert.equal(pcm.pcm.length, source.length);
  mode.setEnabled(true);
  pcm.push(source);
  assert.ok(pcm.bufferedMs < 41);
});
