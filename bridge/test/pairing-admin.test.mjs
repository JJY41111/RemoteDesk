import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { PairingAdmin } from '../pairing-admin.mjs';

test('initialization does not overwrite a running service state before listening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remotedesk-admin-state-'));
  try {
    const config = { directory, mode: 'lan', port: 19561, host: '127.0.0.1' };
    const first = await new PairingAdmin(config).init();
    await first.publish();
    const original = await readFile(first.stateFile, 'utf8');
    await new PairingAdmin(config).init();
    assert.equal(await readFile(first.stateFile, 'utf8'), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('every code change requires password, custom code persists, LAN/WAN stay independent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remotedesk-admin-'));
  try {
    const config = { directory, mode: 'lan', port: 19561, host: '127.0.0.1' };
    const admin = await new PairingAdmin(config).init();
    const original = admin.code;
    await assert.rejects(admin.execute('change', { code: '12345678', password: 'incorrect' }), /先設定/);
    const password = '測試管理密碼123';
    await admin.execute('setup', { password, confirmPassword: password });
    assert.ok(!(await readFile(admin.passwordFile, 'utf8')).includes(password));
    await assert.rejects(admin.execute('setup', { password, confirmPassword: password }), /已設定/);
    await assert.rejects(admin.execute('change', { code: '12345678', password: 'incorrect' }), /錯誤/);
    assert.equal(admin.code, original);
    await admin.execute('change', { code: '12345678', password });
    await assert.rejects(admin.execute('change', { code: '22222222', password: '' }), /錯誤/);
    assert.equal(admin.code, '12345678');
    const restarted = await new PairingAdmin(config).init();
    assert.equal(restarted.code, '12345678');
    const wan = await new PairingAdmin({ ...config, mode: 'wan', port: 19563 }).init();
    await wan.execute('change', { code: '22222222', password });
    assert.equal(admin.code, '12345678');
    for (let i = 0; i < 5; i++) await assert.rejects(wan.execute('change', { code: '33333333', password: 'wrong' }), /錯誤/);
    await assert.rejects(wan.execute('change', { code: '33333333', password }), /60秒/);
    assert.equal(wan.code, '22222222');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('management rejects remote devices, browser origins and missing launcher header', async () => {
  const admin = new PairingAdmin({ directory: tmpdir(), mode: 'lan', port: 19561, host: '192.168.1.100' });
  for (const [remote, origin, launcher] of [['192.168.1.101', undefined, '1'], ['192.168.1.100', 'https://evil.test', '1'], ['192.168.1.100', undefined, undefined]]) {
    const req = Readable.from(['{}']); req.url = '/api/launcher/pairing/setup'; req.method = 'POST';
    req.socket = { remoteAddress: remote }; req.headers = { origin, 'x-remotedesk-launcher': launcher, 'content-type': 'application/json' };
    let status;
    await admin.handle(req, { writeHead(value) { status = value; }, end() {} });
    assert.equal(status, 403);
  }
});
