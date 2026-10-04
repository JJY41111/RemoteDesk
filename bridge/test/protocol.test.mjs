import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameReader, HEADER_BYTES, containsH264Keyframe } from '../protocol.mjs';

test('fragmented and coalesced frames retain exact bytes without aliasing later headers', () => {
  const packets = Array.from({ length: 3 }, (_, seq) => {
    const header = Buffer.alloc(HEADER_BYTES);
    [0x5244534b, 4, seq, 1920, 1080, 8193 + seq].forEach((v, i) => header.writeUInt32BE(v, i * 4));
    header.writeUInt32BE(60, 64);
    return Buffer.concat([header, Buffer.alloc(8193 + seq, seq + 1)]);
  });
  for (const size of [1, 67, 68, 1024, 65536]) {
    const frames = [];
    const reader = new FrameReader((meta, data) => frames.push({ meta, data }));
    const stream = Buffer.concat(packets);
    for (let offset = 0; offset < stream.length; offset += size)
      reader.push(stream.subarray(offset, offset + size));
    assert.equal(frames.length, 3);
    frames.forEach(({ meta, data }, seq) => {
      assert.equal(meta.sequence, seq);
      assert.deepEqual(data, packets[seq].subarray(HEADER_BYTES));
    });
  }
});

test('invalid payload lengths are rejected before allocation', () => {
  for (const size of [0, 4 * 1024 * 1024 + 1]) {
    const header = Buffer.alloc(HEADER_BYTES);
    [0x5244534b, 4, 0, 1920, 1080, size].forEach((v, i) => header.writeUInt32BE(v, i * 4));
    header.writeUInt32BE(60, 64);
    assert.throws(() => new FrameReader(() => {}).push(header), /Invalid H.264/);
  }
});

test('reads a split C++ network packet and rejects invalid sequence', () => {
  const header = Buffer.alloc(HEADER_BYTES);
  const payload = Buffer.from([0, 0, 0, 1, 0x65, 0x12]);
  [0x5244534b, 4, 0, 1280, 720, payload.length, 0, 166667, 0, 166667,
    0, 0, 0x12, 0x34, 0, 0, 60].forEach((value, i) => header.writeUInt32BE(value, i * 4));
  const frames = [];
  const reader = new FrameReader((meta, data) => frames.push({ meta, data }));
  reader.push(header.subarray(0, 40));
  reader.push(Buffer.concat([header.subarray(40), payload]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].meta.fps, 60);
  assert.equal(frames[0].meta.sourceEventQpc, 0x1200000034n);
  assert.deepEqual(frames[0].data, payload);
  assert.equal(containsH264Keyframe(payload), true);
  assert.throws(() => reader.push(Buffer.concat([header, payload])), /Invalid H.264/);
});

test('accepts 1080p30 and rejects unsupported video sizes', () => {
  const packet = Buffer.alloc(HEADER_BYTES);
  [0x5244534b, 4, 0, 1920, 1080, 1, 0, 0, 0, 333333,
    0, 0, 0, 0, 0, 0, 30].forEach((value, i) =>
    packet.writeUInt32BE(value, i * 4));
  const frames = [];
  new FrameReader(meta => frames.push(meta)).push(Buffer.concat([packet, Buffer.of(1)]));
  assert.equal(frames[0].fps, 30);
  packet.writeUInt32BE(31, 16 * 4);
  assert.throws(() => new FrameReader(() => {}).push(Buffer.concat([packet, Buffer.of(1)])),
    /Invalid H.264/);
});
