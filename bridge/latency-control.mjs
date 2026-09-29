// The RTP playout-delay experiment froze real iPad presentation despite 60 fps
// decoding. Never send that extension. This control only bounds host PCM backlog.
export class LatencyControl {
  constructor(rtp) {
    this.rtp = rtp;
    this.rtp.playoutDelayId = 0;
    this.enabled = false;
    this.audioBuffer = null;
  }
  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Latency mode requires a boolean');
    this.enabled = enabled;
    return this.apply();
  }
  attachAudioBuffer(buffer) {
    this.audioBuffer = buffer;
    return this.apply();
  }
  apply() {
    this.rtp.playoutDelayId = 0;
    this.audioBuffer?.setLowLatency(this.enabled);
    return this.state();
  }
  state() {
    return { type: 'latency-state', version: 4, enabled: this.enabled,
      applied: this.enabled && Boolean(this.audioBuffer),
      videoHintNegotiated: false, videoHintSuppressed: true,
      videoMinMs: null, videoMaxMs: null,
      audioQueueLimitMs: this.audioBuffer?.maxBufferedMs ?? null };
  }
}
