// A temporary ICE disconnect can recover without replacing the peer.
export class ConnectionGrace {
  constructor(timeoutMs = 15000) { this.timeoutMs = timeoutMs; this.since = null; }
  update(state, now) {
    if (state === 'failed' || state === 'closed') return true;
    if (state === 'connected') { this.since = null; return false; }
    if (state === 'disconnected' && this.since === null) this.since = now;
    return this.since !== null && now - this.since >= this.timeoutMs;
  }
}
