// Integration test: isolated bridge, real VIIPER device, same-machine Chrome.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const bridge = new URL('..', import.meta.url);
const server = spawn(process.execPath, ['server.mjs', '--host=127.0.0.1',
  '--port=8545', '--tcp-port=55446', '--no-launch', '--enable-input'],
  { cwd: bridge, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let output = '', browser;
server.stdout.on('data', data => output += data);
server.stderr.on('data', data => output += data);
async function waitFor(check) {
  const deadline = Date.now() + 15000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timeout: ${output}`);
    await delay(50);
  }
}
try {
  await waitFor(() => output.includes('One-time pairing code'));
  const code = output.match(/One-time pairing code for this server run: (\d{8})/)[1];
  browser = await chromium.launch({ headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await page.goto('https://127.0.0.1:8545');
  await page.locator('#code').fill(code);
  await page.locator('#connect').click();
  await page.waitForFunction(() => peer?.connectionState === 'connected');
  await page.evaluate(() => sendSignal({ type: 'set-control', enabled: true }));
  await page.waitForFunction(() => controlReady);
  await page.evaluate(() => sendSignal({ type: 'set-gamepad', enabled: true }));
  await page.waitForFunction(() => gamepadActive);
  await page.waitForFunction(() => gamepadChannel?.readyState === 'open');
  await page.evaluate(() => {
    document.querySelector('#control').checked = true;
    sendGamepadState(neutralGamepad());
  });
  await page.waitForFunction(() => Number.isFinite(gamepadAckRttMs));
  console.log('Real VIIPER neutral input acknowledged through fast channel: ' +
    await page.evaluate(() => gamepadAckRttMs) + ' ms (local, not game response)');
  // Closing just the gamepad transport must detach the device while video stays connected.
  await page.evaluate(() => gamepadChannel.close());
  await page.waitForFunction(() => !gamepadActive && !gamepadRequested);
  assert.equal(await page.evaluate(() => peer.connectionState), 'connected');
  console.log('Closed gamepad channel: virtual device removed, peer remains connected');
  await page.evaluate(() => sendSignal({ type: 'set-gamepad', enabled: true }));
  await page.waitForFunction(() => gamepadActive);
  await page.close();
  await waitFor(() => output.includes('Virtual Xbox removed on session disconnect'));
  assert.ok(!output.includes('removal failed'), output);
  console.log('Closed browser: virtual device removal acknowledged by real VIIPER');
} finally {
  await browser?.close();
  server.kill();
}
