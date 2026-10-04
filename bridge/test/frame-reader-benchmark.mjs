import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { FrameReader, HEADER_BYTES, parseHeader } from '../protocol.mjs';

// Retain the former implementation as a measured comparison, not production code.
class FormerReader {
  constructor(onFrame) { this.onFrame = onFrame; this.buffer = Buffer.alloc(0); this.sequence = 0; }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= HEADER_BYTES) {
      const header = parseHeader(this.buffer.subarray(0, HEADER_BYTES), this.sequence);
      if (this.buffer.length < HEADER_BYTES + header.length) break;
      const data = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + header.length);
      this.buffer = this.buffer.subarray(HEADER_BYTES + header.length);
      this.sequence++; this.onFrame(header, data);
    }
  }
}
const result = [];
for (const chunkBytes of [1024, 16384, 65536]) {
  const packet = Buffer.alloc(HEADER_BYTES + 256 * 1024, 17);
  packet.fill(0, 0, HEADER_BYTES);
  [0x5244534b, 4, 0, 1920, 1080, packet.length - HEADER_BYTES].forEach((v, i) => packet.writeUInt32BE(v, i * 4));
  packet.writeUInt32BE(60, 64);
  for (const Reader of [FormerReader, FrameReader]) {
    const times = [];
    for (let round = 0; round < 4; round++) {
      let frames = 0;
      const reader = new Reader((meta, bytes) => {
        assert.equal(bytes.length, 256 * 1024); assert.equal(bytes[bytes.length - 1], 17); frames++;
      });
      const started = performance.now();
      for (let frame = 0; frame < 60; frame++) {
        packet.writeUInt32BE(frame, 8);
        for (let offset = 0; offset < packet.length; offset += chunkBytes)
          reader.push(packet.subarray(offset, offset + chunkBytes));
      }
      assert.equal(frames, 60);
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    result.push({ reader: Reader.name, chunkBytes, frames: 60,
      payloadBytes: 256 * 1024, medianMs: Number(((times[1] + times[2]) / 2).toFixed(2)) });
  }
}
await writeFile(new URL('../test-results/frame-reader-benchmark.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
