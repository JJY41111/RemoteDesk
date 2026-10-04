import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { get } from 'node:https';
import { once } from 'node:events';

const port = 8546;
const server = spawn(process.execPath, ['server.mjs', `--port=${port}`,
  '--tcp-port=55446', '--no-launch'], { cwd: new URL('..', import.meta.url),
  stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });
function request(path) {
  return new Promise((resolve, reject) => {
    get({ hostname: '127.0.0.1', port, path, rejectUnauthorized: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode,
        headers: response.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
try {
  const deadline = Date.now() + 12000;
  while (!output.includes('One-time pairing code') && Date.now() < deadline &&
      server.exitCode === null) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.match(output, /One-time pairing code/, 'isolated HTTPS server did not start');
  const page = await request('/');
  assert.equal(page.status, 200);
  const html = page.body.toString();
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon"[^>]+remotedesk-180\.png/);
  const manifestResponse = await request('/manifest.webmanifest');
  assert.equal(manifestResponse.status, 200);
  assert.match(manifestResponse.headers['content-type'], /application\/manifest\+json/);
  const manifest = JSON.parse(manifestResponse.body.toString());
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  for (const size of [180, 192, 512]) {
    const icon = await request(`/icons/remotedesk-${size}.png`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers['content-type'], 'image/png');
    assert.equal(icon.body.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(icon.body.readUInt32BE(16), size);
    assert.equal(icon.body.readUInt32BE(20), size);
  }
  console.log('Standalone manifest, Apple metadata, and HTTPS icons passed');
} finally {
  server.kill();
  if (server.exitCode === null) await once(server, 'exit');
}
