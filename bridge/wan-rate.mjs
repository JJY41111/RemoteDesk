// Receiver feedback controls only tailnet video. Keep the LAN encoder unchanged.
export function rttControlEnabled(value = process.env.RTT_CONTROL) {
  if (value === undefined || value === 'on') return true;
  if (value === 'off') return false;
  throw new Error('RTT_CONTROL must be on or off');
}

export class WanRateController {
  constructor(maxKbps = 8000, { rttBackoffEnabled = true } = {}) {
    this.maxKbps = maxKbps;
    this.targetKbps = maxKbps;
    this.previous = null;
    this.cleanSamples = 0;
    this.lastLossPercent = null;
    this.rttWindow = [];
    this.delaySamples = 0;
    this.lastQueueDelayMs = null;
    this.rttBackoffEnabled = rttBackoffEnabled !== false;
  }

  setRttBackoffEnabled(enabled) {
    if (typeof enabled !== 'boolean' || enabled === this.rttBackoffEnabled) return;
    this.rttBackoffEnabled = enabled;
    this.rttWindow = [];
    this.delaySamples = 0;
    this.lastQueueDelayMs = null;
    this.cleanSamples = 0;
  }

  update(report) {
    const received = report.received;
    const lost = report.lost;
    const nacks = report.nacks;
    if (![received, lost, nacks].every(value =>
      Number.isSafeInteger(value) && value >= 0)) return null;
    if (!this.previous || received < this.previous.received ||
        nacks < this.previous.nacks) {
      this.previous = { received, lost, nacks };
      this.rttWindow = this.rttBackoffEnabled && Number.isFinite(report.rttMs) && report.rttMs >= 0 && report.rttMs <= 60000 ?
        [report.rttMs] : [];
      this.delaySamples = 0;
      this.cleanSamples = 0;
      return null;
    }
    const arrived = received - this.previous.received;
    // packetsLost can fall when late/retransmitted packets arrive. That is
    // recovery, not a new session, and must not erase clean-link recovery.
    const missing = Math.max(0, lost - this.previous.lost);
    const retransmits = nacks - this.previous.nacks;
    this.previous = { received, lost, nacks };
    if (arrived + missing < 100) return null;
    const lossRate = missing / (arrived + missing);
    this.lastLossPercent = Math.round(lossRate * 10000) / 100;
    const old = this.targetKbps;
    // Keep a rolling route baseline: fixed propagation delay is not congestion.
    // Only fresh packet progress reaches here; duplicate reports cannot back off.
    let delayCongestion = false;
    let delaySafe = true;
    const rtt = this.rttBackoffEnabled ? report.rttMs : undefined;
    if (this.rttBackoffEnabled && Number.isFinite(rtt) && rtt >= 0 && rtt <= 60000) {
      this.rttWindow.push(rtt);
      if (this.rttWindow.length > 30) this.rttWindow.shift();
      const baseline = Math.min(...this.rttWindow);
      this.lastQueueDelayMs = Math.max(0, rtt - baseline);
      const threshold = Math.max(100, baseline * 1.5);
      this.delaySamples = this.lastQueueDelayMs >= threshold ? this.delaySamples + 1 : 0;
      delayCongestion = this.delaySamples >= 2 || this.lastQueueDelayMs >= Math.max(250, threshold * 2);
      delaySafe = this.lastQueueDelayMs < 80;
    } else {
      this.lastQueueDelayMs = null;
      this.delaySamples = 0;
    }
    let reason = 'loss';
    // NACK counts requests, not unrecovered packets. The iPad trace contains
    // repeated NACKs with zero new loss; cutting bitrate for those blurred
    // the picture even though retransmission had already repaired it.
    if (lossRate >= 0.02) {
      this.targetKbps = Math.max(2200, Math.floor(old * 0.7 / 100) * 100);
      this.cleanSamples = 0;
    } else if (lossRate >= 0.003) {
      this.targetKbps = Math.max(2200, Math.floor(old * 0.85 / 100) * 100);
      this.cleanSamples = 0;
    } else if (delayCongestion) {
      // RTT can rise before packetsLost. Do not continue loading the queue.
      this.targetKbps = Math.max(2200, Math.floor(old * 0.85 / 100) * 100);
      this.cleanSamples = 0;
      this.delaySamples = 0;
      reason = 'rtt-rise';
    } else if (lossRate < 0.001 && delaySafe) {
      reason = 'clean-recovery';
      this.cleanSamples++;
      if (this.cleanSamples >= 3) {
        const step = Math.max(300, Math.floor(old * 0.1 / 100) * 100);
        this.targetKbps = Math.min(this.maxKbps, old + step);
        this.cleanSamples = 0;
      }
    } else {
      this.cleanSamples = 0;
    }
    return this.targetKbps === old ? null : {
      kbps: this.targetKbps, lossRate, arrived, missing, retransmits,
      reason, queueDelayMs: this.lastQueueDelayMs
    };
  }
}
