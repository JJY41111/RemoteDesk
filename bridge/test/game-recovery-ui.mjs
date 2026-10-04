import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true,
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
try {
  const page = await browser.newPage();
  await page.setContent(await readFile(new URL('../web/index.html', import.meta.url), 'utf8'));
  await page.addScriptTag({ path: fileURLToPath(new URL('../web/app.js', import.meta.url)) });
  await page.evaluate(() => {
    window.recoveryMessages = [];
    socket = { readyState: WebSocket.OPEN, send: value => recoveryMessages.push(JSON.parse(value)) };
    peer = { connectionState: 'connected' };
    activeVideoMode = 'game1080';
    Object.defineProperty(screen, 'paused', { configurable: true, get: () => false });
    lastFrameTime = performance.now() - 400;
    worstUiTimerLag = 0;
    lastRecoveryRequestedAt = 0;
  });
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => recoveryMessages.filter(x => x.type === 'request-video-recovery').length), 1);
  await page.evaluate(() => { lastFrameTime = performance.now(); });
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => recoveryMessages.filter(x => x.type === 'request-video-recovery').length), 1);
  await page.evaluate(() => {
    activeVideoMode = '1080p'; lastFrameTime = performance.now() - 400;
    lastRecoveryRequestedAt = 0; recoveryMessages.length = 0;
  });
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => recoveryMessages.filter(x => x.type === 'request-video-recovery').length), 0);
  await page.evaluate(() => {
    activeVideoMode = 'game1080';
    Object.defineProperty(screen, 'paused', { configurable: true, get: () => true });
  });
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => recoveryMessages.filter(x => x.type === 'request-video-recovery').length), 0);
  console.log('Game video gap recovery, coalescing, baseline and paused playback passed');
} finally { await browser.close(); }
