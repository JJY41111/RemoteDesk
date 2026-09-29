import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameReader, HEADER_BYTES, containsH264Keyframe } from '../protocol.mjs';

test('reads a split C++ network packet and rejects invalid sequence', () => {
  const header = Buffer.alloc(HEADER_BYTES);
  const payload = Buffer.from([0, 0, 0, 1, 0x65, 0x12]);
  [0x5244534b, 4, 0, 1280, 720, payload.length, 0, 166667, 0, 166667,
    0, 0, 0, 0, 0, 0, 60].forEach((value, i) => header.writeUInt32BE(value, i * 4));
  const frames = [];
  const reader = new FrameReader((meta, data) => frames.push({ meta, data }));
  reader.push(header.subarray(0, 40));
  reader.push(Buffer.concat([header.subarray(40), payload]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].meta.fps, 60);
  assert.deepEqual(frames[0].data, payload);
  assert.equal(containsH264Keyframe(payload), true);
  assert.throws(() => reader.push(Buffer.concat([header, payload])), /Invalid H.264/);
});
