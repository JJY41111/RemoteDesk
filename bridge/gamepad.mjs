import { connect } from 'node:net';

// Standard Gamepad API button order; the host emits an Xbox 360 device, not keys.
const buttonBits = [0x1000, 0x2000, 0x4000, 0x8000, 0x0100, 0x0200,
  0, 0, 0x0020, 0x0010, 0x0040, 0x0080, 0x0001, 0x0002, 0x0004, 0x0008, 0x0400];
export const neutralGamepad = Object.freeze({ buttons: Array(17).fill(0), axes: [0, 0, 0, 0] });

export function validGamepad(value) {
  return value && Array.isArray(value.buttons) && value.buttons.length === 17 &&
    value.buttons.every(n => Number.isFinite(n) && n >= 0 && n <= 1) &&
    Array.isArray(value.axes) && value.axes.length === 4 &&
    value.axes.every(n => Number.isFinite(n) && n >= -1 && n <= 1);
}

export function xbox360Packet(value) {
  if (!validGamepad(value)) throw new Error('Invalid gamepad state');
  let buttons = 0;
  value.buttons.forEach((n, i) => { if (n >= 0.5) buttons |= buttonBits[i]; });
  const packet = Buffer.alloc(20);
  packet.writeUInt32LE(buttons, 0);
  packet[4] = Math.round(value.buttons[6] * 255);
  packet[5] = Math.round(value.buttons[7] * 255);
  value.axes.forEach((n, i) => {
    // Browser Y grows downward; XInput Y grows upward.
    const axis = i === 1 || i === 3 ? -n : n;
    packet.writeInt16LE(Math.round(axis < 0 ? axis * 32768 : axis * 32767), 6 + i * 2);
  });
  return packet;
}

function request(command, port, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const chunks = [];
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => socket.write(command + '\0'));
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('timeout', () => socket.destroy(new Error('VIIPER timed out')));
    socket.on('error', reject);
    socket.on('close', hadError => {
      if (hadError) return;
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString('utf8').trim());
        if (response.status >= 400) reject(new Error(response.detail || response.title));
        else resolve(response);
      } catch { reject(new Error('Invalid VIIPER response')); }
    });
  });
}

export class ViiperGamepad {
  constructor({ port = 3242, onStatus = () => {} } = {}) {
    this.port = port;
    this.onStatus = onStatus;
    this.closed = false;
    this.stream = null;
    this.busId = null;
    this.devId = null;
    this.lastInput = 0;
  }

  async open() {
    const identity = await request('ping', this.port);
    if (identity.server !== 'VIIPER') throw new Error('Port is not VIIPER');
    const bus = await request('bus/create', this.port);
    if (!Number.isSafeInteger(bus.busId)) throw new Error('Invalid VIIPER bus');
    this.busId = bus.busId;
    if (this.closed) {
      await request(`bus/remove ${this.busId}`, this.port).catch(() => {});
      return;
    }
    const device = await request(`bus/${this.busId}/add {"type":"xbox360"}`, this.port);
    if (!/^\d+$/.test(String(device.devId))) throw new Error('Invalid VIIPER device');
    this.devId = String(device.devId);
    if (this.closed) {
      await request(`bus/remove ${this.busId}`, this.port).catch(() => {});
      return;
    }
    await new Promise((resolve, reject) => {
      const stream = connect({ host: '127.0.0.1', port: this.port });
      this.stream = stream;
      stream.setTimeout(1500);
      stream.once('connect', () => {
        stream.write(`bus/${this.busId}/${this.devId}\0`);
        stream.setTimeout(0);
        resolve();
      });
      stream.once('error', reject);
      stream.on('close', () => {
        this.stream = null;
        if (!this.closed) this.onStatus('虛擬手把資料流中斷');
      });
    });
    this.watchdog = setInterval(() => {
      if (this.lastInput && Date.now() - this.lastInput > 500) {
        this.neutral();
        this.lastInput = 0;
      }
    }, 100);
    this.onStatus('VIIPER 資料流已連線；請在 Windows 遊戲控制器中確認裝置');
  }

  send(value) {
    if (!this.stream?.writable || this.stream.writableLength > 4096) return;
    this.stream.write(xbox360Packet(value));
    this.lastInput = Date.now();
  }

  neutral() {
    if (this.stream?.writable) this.stream.write(xbox360Packet(neutralGamepad));
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    clearInterval(this.watchdog);
    this.neutral();
    this.stream?.end();
    this.closePromise = this.busId !== null ?
      request(`bus/remove ${this.busId}`, this.port).catch(() => {}) : Promise.resolve();
    return this.closePromise;
  }
}
