const HEADER_FIELDS = 17;
export const HEADER_BYTES = HEADER_FIELDS * 4;
const MAGIC = 0x5244534b;
const VERSION = 4;
const MAX_PAYLOAD = 4 * 1024 * 1024;

export function parseHeader(buffer, expectedSequence) {
  if (buffer.length !== HEADER_BYTES) throw new Error('Invalid frame header size');
  const field = index => buffer.readUInt32BE(index * 4);
  const width = field(3), height = field(4), fps = field(16);
  const validFormat = (width === 1280 && height === 720 && (fps === 30 || fps === 60)) ||
    (width === 1920 && height === 1080 && (fps === 30 || fps === 60)) ||
    (width === 2560 && height === 1440 && fps === 60);
  if (field(0) !== MAGIC || field(1) !== VERSION || field(2) !== expectedSequence ||
      !validFormat || field(5) === 0 || field(5) > MAX_PAYLOAD) {
    throw new Error('Invalid H.264 frame header');
  }
  return {
    sequence: field(2), width, height, fps, length: field(5),
    sampleTime: (BigInt(field(6)) << 32n) | BigInt(field(7)),
    sourceEventQpc: (BigInt(field(12)) << 32n) | BigInt(field(13))
  };
}

export class FrameReader {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.headerBuffer = Buffer.alloc(HEADER_BYTES);
    this.headerBytes = 0;
    this.header = null;
    this.payload = null;
    this.payloadBytes = 0;
    this.sequence = 0;
  }
  push(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.header) {
        const count = Math.min(HEADER_BYTES - this.headerBytes, chunk.length - offset);
        chunk.copy(this.headerBuffer, this.headerBytes, offset, offset + count);
        this.headerBytes += count; offset += count;
        if (this.headerBytes < HEADER_BYTES) continue;
        // Validate before allocating a payload; malformed lengths remain bounded.
        this.header = parseHeader(this.headerBuffer, this.sequence);
      }
      const remaining = this.header.length - this.payloadBytes;
      if (!this.payload && chunk.length - offset >= remaining) {
        const data = chunk.subarray(offset, offset + remaining);
        offset += remaining;
        const header = this.header;
        this.header = null; this.headerBytes = 0; this.sequence++;
        this.onFrame(header, data);
        continue;
      }
      // Allocate once for a fragmented frame instead of copying the accumulated
      // frame again for every TCP chunk. Each payload byte is copied once.
      this.payload ??= Buffer.allocUnsafe(this.header.length);
      const count = Math.min(remaining, chunk.length - offset);
      chunk.copy(this.payload, this.payloadBytes, offset, offset + count);
      this.payloadBytes += count; offset += count;
      if (this.payloadBytes === this.header.length) {
        const header = this.header, data = this.payload;
        this.header = null; this.headerBytes = 0;
        this.payload = null; this.payloadBytes = 0; this.sequence++;
        this.onFrame(header, data);
      }
    }
  }
}

export function containsH264Keyframe(data) {
  for (let i = 0; i + 4 < data.length; i++) {
    const start = data[i] === 0 && data[i + 1] === 0 &&
      ((data[i + 2] === 1) || (data[i + 2] === 0 && data[i + 3] === 1));
    if (start) {
      const offset = data[i + 2] === 1 ? 3 : 4;
      if ((data[i + offset] & 0x1f) === 5) return true;
    }
  }
  return false;
}

export function h264SpsProfile(data) {
  for (let i = 0; i + 7 < data.length; i++) {
    const start = data[i] === 0 && data[i + 1] === 0 &&
      ((data[i + 2] === 1) || (data[i + 2] === 0 && data[i + 3] === 1));
    if (!start) continue;
    const nalu = i + (data[i + 2] === 1 ? 3 : 4);
    if ((data[nalu] & 0x1f) === 7) {
      return Buffer.from(data.subarray(nalu + 1, nalu + 4)).toString('hex');
    }
  }
  return null;
}
