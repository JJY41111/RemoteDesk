import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { handleTransfer, safeTransferName } from '../transfer.mjs';

test('filenames cannot escape destination and collisions keep both files', async () => {
  assert.equal(safeTransferName('..%2F..%5Cmain.cpp'), '.._.._main.cpp');
  assert.equal(safeTransferName('CON.txt'), '_CON.txt');
  assert.throws(() => safeTransferName('%2E%2E'));
  const root = await mkdtemp(join(tmpdir(), 'remotedesk-transfer-'));
  const folder = join(root, 'received');
  const current = { authorized: true, closed: false, transferToken: 'a'.repeat(64) };
  const server = createServer((req, res) => {
    void handleTransfer(req, res, { current, origin: `http://127.0.0.1:${server.address().port}`,
      folder, privateFolder: join(root, 'private'), clipboardScript: join(root, 'clipboard.ps1') });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const send = (path, body, token = current.transferToken, name = 'project.zip') =>
    new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method: 'POST',
        headers: { origin: `http://127.0.0.1:${port}`,
          'x-remotedesk-token': token, 'x-remotedesk-name': name,
          'content-type': 'application/octet-stream' } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.on('error', reject);
      req.end(body);
    });
  try {
    assert.equal((await send('/api/upload', 'secret', 'wrong')).status, 403);
    assert.equal((await readdir(root)).length, 0);
    const first = await send('/api/upload', 'first');
    const second = await send('/api/upload', 'second');
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.body.name, 'project.zip');
    assert.equal(second.body.name, 'project (1).zip');
    assert.equal((await readFile(join(folder, 'project.zip'))).toString(), 'first');
    assert.equal((await readFile(join(folder, 'project (1).zip'))).toString(), 'second');
    const traversal = await send('/api/upload', 'code', current.transferToken,
      '..%2F..%5Cmain.cpp');
    assert.equal(traversal.status, 200);
    assert.equal((await readFile(join(folder, '.._.._main.cpp'))).toString(), 'code');
    current.closed = true;
    assert.equal((await send('/api/upload', 'nope')).status, 403);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('paired clipboard request passes UTF-8 data to bounded helper', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remotedesk-clipboard-'));
  const marker = join(root, 'received.txt');
  const script = join(root, 'fake-clipboard.ps1');
  await writeFile(script, `param($Kind, $InputPath)\n[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', $Kind + ':' + [IO.File]::ReadAllText($InputPath))\n`);
  const current = { authorized: true, closed: false, transferToken: 'b'.repeat(64) };
  const server = createServer((req, res) => {
    void handleTransfer(req, res, { current, origin: `http://127.0.0.1:${server.address().port}`,
      folder: join(root, 'received'), privateFolder: join(root, 'private'),
      clipboardScript: script });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port,
        path: '/api/clipboard', method: 'POST', headers: {
          origin: `http://127.0.0.1:${server.address().port}`,
          'x-remotedesk-token': current.transferToken,
          'content-type': 'text/plain; charset=utf-8' } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.on('error', reject);
      req.end('繁體中文 😀');
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.kind, 'text');
    assert.equal(await readFile(marker, 'utf8'), 'text:繁體中文 😀');
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});
