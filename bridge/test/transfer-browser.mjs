import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const port = 8549;
const name = `remotedesk-upload-check-${process.pid}.cpp`;
const project = fileURLToPath(new URL('../..', import.meta.url));
const destination = join(dirname(project), 'ipad傳輸', name);
const server = spawn(process.execPath,
  ['server.mjs', '--host=127.0.0.1', `--port=${port}`, '--tcp-port=55449',
    '--no-launch'],
  { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });
let browser;
try {
  const deadline = Date.now() + 15000;
  while (!output.includes('One-time pairing code') && Date.now() < deadline &&
      server.exitCode === null) await new Promise(resolve => setTimeout(resolve, 100));
  const code = output.match(/One-time pairing code for this server run: (\d{8})/)?.[1];
  assert.ok(code, `Isolated bridge did not start: ${output.slice(-1000)}`);
  browser = await chromium.launch({ headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await page.goto(`https://127.0.0.1:${port}/`);
  await page.locator('#code').fill(code);
  await page.locator('#connect').click();
  await page.locator('#session').waitFor({ state: 'visible' });
  await page.locator('#menuToggle').click();
  await page.locator('#uploadFiles').setInputFiles({ name, mimeType: 'text/x-c++src',
    buffer: Buffer.from('int main() { return 42; }\n') });
  await page.locator('#sendFiles').click();
  await page.getByText(`已接收 1/1：${name}`, { exact: false }).waitFor();
  assert.equal(await readFile(destination, 'utf8'), 'int main() { return 42; }\n');
  console.log('Paired browser upload of a C++ source file passed');
} finally {
  await browser?.close();
  server.kill();
  if (server.exitCode === null) await once(server, 'exit');
  await rm(destination, { force: true });
}
