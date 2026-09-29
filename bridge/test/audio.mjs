import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const bridge = resolve(fileURLToPath(new URL('..', import.meta.url)));
const server = spawn(process.execPath,
  ['server.mjs', '--port=8444', '--tcp-port=55000', '--no-launch', '--audio'],
  { cwd: bridge, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
let output = '';
try {
  server.stdout.on('data', data => { output += String(data); });
  server.stderr.on('data', data => { output += String(data); });
  const deadline = Date.now() + 12000;
  while (!output.includes('One-time pairing code') && Date.now() < deadline && server.exitCode === null) {
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  const code = output.match(/One-time pairing code for this server run: (\d{8})/)?.[1];
  if (!code) throw new Error('Audio test server did not start: ' + output);
  browser = await chromium.launch({ headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await page.goto('https://127.0.0.1:8444');
  await page.locator('#code').fill(code);
  await page.locator('#connect').click();
  await page.locator('#playAudio').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('#playAudio').disabled);
  await page.locator('#playAudio').click();
  await page.waitForFunction(() => audioStats?.packetsSent > 50, null, { timeout: 15000 });
  const initialSent = await page.evaluate(() => audioStats.packetsSent);
  const sampleStarted = Date.now();
  await page.waitForTimeout(3000);
  const sampleSeconds = (Date.now() - sampleStarted) / 1000;
  await page.waitForFunction(async () => {
    const stats = await peer.getStats();
    return [...stats.values()].some(item => item.type === 'inbound-rtp' &&
      item.kind === 'audio' && item.packetsReceived > 30);
  }, null, { timeout: 15000 });
  const result = await page.evaluate(async () => {
    const stats = await peer.getStats();
    const inbound = [...stats.values()].find(item => item.type === 'inbound-rtp' && item.kind === 'audio');
    return { sent: audioStats.packetsSent, underruns: audioStats.underruns,
      lateTicks: audioStats.lateTicks, received: inbound.packetsReceived,
      lost: inbound.packetsLost, jitter: inbound.jitter };
  });
  console.log('Audio RTP test:', result);
  const packetRate = (result.sent - initialSent) / sampleSeconds;
  console.log('Audio packets per second:', packetRate.toFixed(1));
  if (packetRate < 45 || packetRate > 55) {
    throw new Error(`Audio packet pacing is outside 45..55 packets/s: ${packetRate}`);
  }
} finally {
  await browser?.close();
  server.kill();
}
