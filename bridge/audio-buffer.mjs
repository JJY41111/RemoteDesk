// PCM16 stereo, 48 kHz. Keep incomplete pipe chunks until the next read;
// dropping an arbitrary byte count would swap channels or corrupt samples.
export class AudioBuffer {
  constructor() {
    this.pcm = Buffer.alloc(0);
    this.ready = false;
    this.underruns = 0;
    this.droppedSamples = 0;
    this.maxBufferedMs = 120;
  }
  get bufferedMs() { return this.pcm.length / 192; }
  setLowLatency(enabled) {
    this.maxBufferedMs = enabled ? 60 : 120;
    if (this.bufferedMs > this.maxBufferedMs) this.trim();
  }
  resetSource() {
    this.pcm = Buffer.alloc(0);
    this.ready = false;
  }
  push(chunk) {
    this.pcm = Buffer.concat([this.pcm, chunk]);
    if (this.bufferedMs > this.maxBufferedMs) this.trim();
  }
  trim() {
    const drop = Math.max(0, Math.floor((this.pcm.length - 7680) / 4) * 4);
    this.pcm = this.pcm.subarray(drop); // retain 40 ms plus partial sample
    this.droppedSamples += drop / 4;
  }
  take() {
    if (!this.ready && this.pcm.length >= 7680) this.ready = true;
    if (this.ready && this.pcm.length >= 3840) {
      const frame = this.pcm.subarray(0, 3840);
      this.pcm = this.pcm.subarray(3840);
      return frame;
    }
    if (this.ready) this.underruns++;
    this.ready = false;
    return Buffer.alloc(3840);
  }
}
