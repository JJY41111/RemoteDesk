import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioBuffer } from '../audio-buffer.mjs';

test('uneven capture delivery preserves continuous stereo PCM after small prebuffer', () => {
  const queue = new AudioBuffer();
  const source = Buffer.alloc(192000);
  for (let i = 0; i < source.length / 2; i++) source.writeInt16LE((i % 20000) - 10000, i * 2);
  queue.push(source.subarray(0, 7680));
  let offset = 7680;
  const output = [];
  for (let tick = 0; tick < 48; tick++) {
    output.push(queue.take());
    // Alternate 10 / 30 ms capture batches, including split samples.
    const size = tick % 2 ? 5760 : 1920;
    queue.push(source.subarray(offset, offset + 7));
    queue.push(source.subarray(offset + 7, offset + size));
    offset += size;
  }
  assert.deepEqual(Buffer.concat(output), source.subarray(0, 48 * 3840));
  assert.equal(queue.underruns, 0);
});

test('backlog trimming retains sample boundaries even with incomplete pipe chunks', () => {
  const queue = new AudioBuffer();
  const source = Buffer.alloc(30003);
  for (let i = 0; i < source.length; i++) source[i] = i % 251;
  queue.push(source);
  assert.equal(queue.droppedSamples, 5580);
  assert.deepEqual(queue.take(), source.subarray(22320, 26160));
  assert.ok(queue.bufferedMs < 41);
});

test('silence before capture is not counted repeatedly as capture failure', () => {
  const queue = new AudioBuffer();
  for (let i = 0; i < 100; i++) queue.take();
  assert.equal(queue.underruns, 0);
  queue.push(Buffer.alloc(7680, 1));
  queue.take(); queue.take(); queue.take(); queue.take();
  assert.equal(queue.underruns, 1);
});
