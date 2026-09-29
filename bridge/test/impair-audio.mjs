// Test-only preload: disturb audio delivery without changing production code.
import rtc from 'node-datachannel';
const NativePeer = rtc.PeerConnection;
rtc.PeerConnection = new Proxy(NativePeer, {
  construct(Target, args) {
    const peer = new Target(...args);
    const addTrack = peer.addTrack.bind(peer);
    Object.defineProperty(peer, 'addTrack', { value(media) {
      const track = addTrack(media);
      if (media.mid() !== 'audio') return track;
      const send = track.sendMessageBinary.bind(track);
      let started = 0;
      Object.defineProperty(track, 'sendMessageBinary', { value(data) {
        if (!started) started = performance.now();
        const elapsed = (performance.now() - started) % 40000;
        const delay = elapsed >= 8000 && elapsed < 25000 ? 600 : 0;
        if (!delay) return send(data);
        const copy = Buffer.from(data);
        setTimeout(() => { try { if (track.isOpen()) send(copy); } catch {} }, delay);
        return true;
      } });
      return track;
    } });
    return peer;
  }
});
