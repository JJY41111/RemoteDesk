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
    (width === 1920 && height === 1080 && fps === 60) ||
    (width === 2560 && height === 1440 && fps === 60);
  if (field(0) !== MAGIC || field(1) !== VERSION || field(2) !== expectedSequence ||
      !validFormat || field(5) === 0 || field(5) > MAX_PAYLOAD) {
    throw new Error('Invalid H.264 frame header');
  }
  return {
    sequence: field(2), width, height, fps, length: field(5),
    sampleTime: (BigInt(field(6)) << 32n) | BigInt(field(7))
  };
}

export class FrameReader {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buffer = Buffer.alloc(0);
    this.sequence = 0;
  }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= HEADER_BYTES) {
      const header = parseHeader(this.buffer.subarray(0, HEADER_BYTES), this.sequence);
      if (this.buffer.length < HEADER_BYTES + header.length) break;
      const data = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + header.length);
      this.buffer = this.buffer.subarray(HEADER_BYTES + header.length);
      this.sequence++;
      this.onFrame(header, data);
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
