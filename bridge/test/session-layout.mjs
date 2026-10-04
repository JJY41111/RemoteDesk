import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true,
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
try {
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  await page.setContent(await readFile('web/index.html', 'utf8'));
  await page.addStyleTag({ path: 'web/style.css' });
  await page.addScriptTag({ path: 'web/app.js' });
  await page.evaluate(() => {
    document.querySelector('#pairing').hidden = true;
    document.querySelector('#session').hidden = false;
  });
  const poster = await readFile('test-results/quality-1080-gpu-180s.png');
  await page.locator('#screen').evaluate((video, data) => {
    video.poster = 'data:image/png;base64,' + data;
  }, poster.toString('base64'));
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/session-layout-landscape.png' });
  const barPositions = async () => Promise.all(['menuToggle', 'zoomScreen']
    .map(id => page.locator(`#${id}`).boundingBox()));
  const [menu, zoom] = await barPositions();
  assert.ok(menu.x > 1180 / 2 && menu.x < zoom.x,
    'Toolbar actions must remain grouped on the right');
  assert.equal(await page.locator('#fullscreen').count(), 0,
    'The redundant browser fullscreen control must be removed');
  await page.evaluate(() => {
    canControl = true;
    window.keyboardMessages = [];
    controlChannel = { readyState: 'open', send: data =>
      window.keyboardMessages.push(JSON.parse(data)) };
  });
  await page.locator('#menuToggle').click();
  await page.locator('#focusKeys').click();
  await page.evaluate(() => { controlReady = true; });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'screen');
  await page.keyboard.press('a');
  assert.ok(await page.evaluate(() => window.keyboardMessages.some(item =>
    item.type === 'key' && item.code === 'KeyA' && item.down)),
    'Physical keyboard input must reach the remote-control channel');
  await page.locator('#zoomScreen').click();
  assert.equal(await page.locator('#panScreen').getAttribute('aria-pressed'), 'true');
  await page.locator('#menuToggle').click();
  await page.locator('#focusKeys').click();
  assert.equal(await page.locator('#panScreen').getAttribute('aria-pressed'), 'false',
    'Keyboard control must leave view-panning mode at 150% zoom');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'screen');
  await page.keyboard.press('b');
  assert.ok(await page.evaluate(() => window.keyboardMessages.some(item =>
    item.type === 'key' && item.code === 'KeyB' && item.down)),
    'Zoomed physical keyboard input must reach the remote-control channel');
  await page.locator('#zoomScreen').click();
  await page.locator('#menuToggle').click();
  await page.screenshot({ path: 'test-results/session-layout-menu.png' });
  await page.locator('#closeMenu').click();
  await page.setViewportSize({ width: 820, height: 1180 });
  const viewport = await page.locator('#screenViewport').boundingBox();
  assert.ok(viewport.height >= 1120);
  assert.ok(viewport.width <= 820);
  await page.screenshot({ path: 'test-results/session-layout-portrait.png' });
  console.log('Landscape/portrait layout, keyboard, and zoom without fullscreen control passed');
} finally { await browser.close(); }
