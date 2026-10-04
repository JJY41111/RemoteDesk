import { createServer } from 'node:https';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { PairingAdmin } from '../pairing-admin.mjs';
const directory = await mkdtemp(join(tmpdir(), 'remotedesk-admin-http-'));
const admin = await new PairingAdmin({ directory, mode: 'lan', port: 19565, host: '127.0.0.1' }).init();
const server = createServer({ key: await readFile('private/key.pem'), cert: await readFile('private/cert.pem') }, (req, res) => {
  void admin.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } });
});
await new Promise(done => server.listen(19565, '127.0.0.1', done));
async function client(action, input = {}) {
  const child = spawn(process.execPath, ['launcher-admin-client.mjs'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = ''; child.stdout.on('data', chunk => output += chunk);
  child.stdin.end(JSON.stringify({ url: 'https://127.0.0.1:19565/', action, input }));
  await new Promise(done => child.once('exit', done));
  return JSON.parse(output);
}
try {
  assert.equal((await client('status')).configured, false);
  const password = '測試管理密碼123';
  assert.equal((await client('setup', { password, confirmPassword: password })).status, 200);
  assert.equal((await client('change', { password: 'wrong', code: '12345678' })).status, 403);
  assert.equal((await client('change', { password, code: '12345678' })).code, '12345678');
  const script = `. '${resolve('../launcher/Launcher.Core.ps1').replaceAll("'", "''")}'; $c=New-RemoteDeskConfig '${resolve('..').replaceAll("'", "''")}' 'lan' '127.0.0.1' 19565 19566; Invoke-RemoteDeskAdmin $c 'status' | ConvertTo-Json -Compress`;
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '', error = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => error += chunk);
  const exit = await new Promise(done => child.once('exit', done));
  assert.equal(exit, 0, error); assert.equal(JSON.parse(output).code, '12345678');
  console.log('HTTPS CA validation, stdin-only Unicode password, denied change and Windows launcher client passed.');
} finally {
  await new Promise(done => server.close(done));
  await rm(directory, { recursive: true, force: true });
}
