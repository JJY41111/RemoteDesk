import { randomBytes, randomInt, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
const scrypt = promisify(derive);

export class PairingAdmin {
  constructor({ directory, mode, port, host }) {
    this.directory = directory; this.host = host; this.port = port;
    this.passwordFile = join(directory, 'launcher-admin-password.json');
    this.codeFile = join(directory, `custom-pairing-${mode}.json`);
    this.stateFile = join(directory, `pairing-state-${port}.json`);
    this.code = String(randomInt(10000000, 99999999));
    this.failures = 0; this.lockedUntil = 0; this.busy = false;
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.codeFile, 'utf8'));
      if (/^\d{8}$/.test(saved.code)) this.code = saved.code;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this;
  }
  async atomic(file, value) {
    const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await rename(temporary, file);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  async publish() {
    await this.atomic(this.stateFile, { processId: process.pid, host: this.host,
      port: this.port, code: this.code });
  }
  async passwordRecord() {
    try { return JSON.parse(await readFile(this.passwordFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async execute(action, input = {}) {
    const record = await this.passwordRecord();
    if (action === 'status') return { configured: Boolean(record), code: this.code };
    if (this.busy || Date.now() < this.lockedUntil) throw Object.assign(new Error('請稍後再試；連續錯誤後需等候60秒。'), { status: 429 });
    this.busy = true;
    try {
      if (action === 'setup') {
        if (record) throw Object.assign(new Error('管理密碼已設定。'), { status: 409 });
        if (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128 || input.password !== input.confirmPassword)
          throw Object.assign(new Error('管理密碼須為8至128字，且兩次輸入相同。'), { status: 400 });
        const salt = randomBytes(16).toString('hex');
        const hash = (await scrypt(input.password, salt, 32)).toString('hex');
        // Exclusive creation also protects simultaneous setup in LAN and WAN.
        await writeFile(this.passwordFile, JSON.stringify({ salt, hash }), { flag: 'wx', mode: 0o600 });
        return { configured: true };
      }
      if (action !== 'change') throw Object.assign(new Error('不支援的操作。'), { status: 400 });
      if (!record) throw Object.assign(new Error('請先設定管理密碼。'), { status: 409 });
      if (typeof input.password !== 'string' || input.password.length > 128)
        throw Object.assign(new Error('請輸入管理密碼。'), { status: 400 });
      const actual = await scrypt(input.password, record.salt, 32);
      const expected = Buffer.from(record.hash, 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        if (++this.failures >= 5) { this.lockedUntil = Date.now() + 60000; this.failures = 0; }
        throw Object.assign(new Error('管理密碼錯誤，配對碼未更改。'), { status: 403 });
      }
      if (typeof input.code !== 'string' || !/^\d{8}$/.test(input.code))
        throw Object.assign(new Error('配對碼須為8位數字。'), { status: 400 });
      await this.atomic(this.codeFile, { code: input.code });
      this.code = input.code; this.failures = 0;
      await this.publish();
      return { code: this.code };
    } finally { this.busy = false; }
  }
  async handle(req, res) {
    if (!req.url.startsWith('/api/launcher/pairing')) return false;
    const reply = (status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
    // Desktop-only management, with a custom header and no browser origin.
    // iPad requests and cross-origin browser forms cannot initialize passwords.
    const remote = req.socket.remoteAddress?.replace(/^::ffff:/, '');
    if (remote !== this.host || req.headers.origin || req.headers['x-remotedesk-launcher'] !== '1') {
      reply(403, { error: '僅允許本機啟動器管理。' }); return true;
    }
    const action = req.url.split('/').at(-1);
    if (req.method !== 'POST' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
      reply(405, { error: '不支援的請求。' }); return true;
    }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) { reply(413, { error: '資料過大。' }); return true; }
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      reply(200, await this.execute(action, data));
    } catch (error) {
      reply(error.status || (error instanceof SyntaxError ? 400 : 500), { error: error.status ? error.message : '管理操作失敗。' });
    }
    return true;
  }
}
