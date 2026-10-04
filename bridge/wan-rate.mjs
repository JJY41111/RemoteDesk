// Receiver feedback controls only tailnet video. Keep the LAN encoder unchanged.
export class WanRateController {
  constructor(maxKbps = 8000) {
    this.maxKbps = maxKbps;
    this.targetKbps = maxKbps;
    this.previous = null;
    this.cleanSamples = 0;
    this.lastLossPercent = null;
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
    // NACK counts requests, not unrecovered packets. The iPad trace contains
    // repeated NACKs with zero new loss; cutting bitrate for those blurred
    // the picture even though retransmission had already repaired it.
    if (lossRate >= 0.02) {
      this.targetKbps = Math.max(2200, Math.floor(old * 0.7 / 100) * 100);
      this.cleanSamples = 0;
    } else if (lossRate >= 0.003) {
      this.targetKbps = Math.max(2200, Math.floor(old * 0.85 / 100) * 100);
      this.cleanSamples = 0;
    } else if (lossRate < 0.001) {
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
      kbps: this.targetKbps, lossRate, arrived, missing, retransmits
    };
  }
}
