import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const bridge = resolve(fileURLToPath(new URL('..', import.meta.url)));
const browser = await chromium.launch({ headless: true,
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://pc.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const file = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'],
      '/style.css': ['style.css', 'text/css'] }[path];
    if (!file) return route.fulfill({ status: 404, body: '' });
    await route.fulfill({ contentType: file[1], body: await readFile(resolve(bridge, 'web', file[0])) });
  });
  await page.goto('https://pc.test/');
  assert.equal(await page.locator('#clientMode').count(), 0);
  assert.equal(await page.locator('#pcGuide').isVisible(), false);
  assert.ok(!(await page.locator('body').innerText()).includes('Windows Edge'));
  assert.ok(!(await page.locator('body').innerText()).includes('接收裝置'));
  await mkdir(resolve(bridge, 'test-results'), { recursive: true });
  await page.screenshot({ path: resolve(bridge, 'test-results/ipad-pairing-ui.png') });
  await page.evaluate(()=>localStorage.setItem('remotedesk.videoMode','stable1080'));
  await page.reload();
  assert.equal(await page.locator('#videoMode').inputValue(), '1080p');
  assert.equal(await page.evaluate(()=>localStorage.getItem('remotedesk.videoMode')), '1080p');
  // Client identity comes from the service entry, never a device switch in the UI.
  await page.goto('https://pc.test/?client=pc');
  await page.waitForFunction(() => document.body.classList.contains('pc-client'));
  assert.equal(await page.locator('#pcGuide').isVisible(), true);
  assert.equal(await page.locator('#clientMode').count(), 0);
  assert.ok(!(await page.locator('body').innerText()).includes('iPad'));
  assert.ok(!(await page.locator('body').innerText()).includes('Safari'));
  assert.equal(await page.locator('#videoMode').inputValue(), '1080p');
  await page.locator('#videoMode').selectOption('native');
  assert.deepEqual(await page.evaluate(()=>[localStorage.getItem('remotedesk.videoMode'),localStorage.getItem('remotedesk.pc.videoMode')]),['1080p','native']);
  await page.locator('#videoMode').selectOption('1080p');
  assert.equal(await page.locator('.ipad-guide').isVisible(), false);
  await page.evaluate(() => { $('pairing').hidden = true; $('session').hidden = false; });
  const geometry = await page.evaluate(() => {
    Object.defineProperty(screen, 'videoWidth', { configurable: true, value: 2560 });
    Object.defineProperty(screen, 'videoHeight', { configurable: true, value: 1440 });
    const rect = screen.getBoundingClientRect();
    const height = rect.width * 1440 / 2560;
    const top = rect.top + (rect.height - height) / 2;
    return [pointerPosition({ clientX: rect.left + rect.width / 2, clientY: top + height / 2 }),
      pointerPosition({ clientX: rect.left, clientY: top }),
      pointerPosition({ clientX: rect.right, clientY: top + height })];
  });
  assert.deepEqual(geometry, [{ x: .5, y: .5 }, { x: 0, y: 0 }, { x: 1, y: 1 }]);
  await page.locator('#pcFullscreen').click();
  await page.waitForFunction(() => Boolean(document.fullscreenElement));
  await page.waitForFunction(() => document.querySelector('#pcFullscreen').getAttribute('aria-pressed') === 'true');
  assert.equal(await page.locator('#pcFullscreen').getAttribute('aria-pressed'), 'true');
  await page.locator('#pcFullscreen').click();
  await page.waitForFunction(() => !document.fullscreenElement);
  await page.waitForFunction(() => document.querySelector('#pcFullscreen').getAttribute('aria-pressed') === 'false');
  const input = await page.evaluate(async () => {
    const events = [], attempts = [];
    sendInput = event => events.push(event);
    sendInputRaw = event => events.push(event);
    controlReady = true; $('control').checked = true;
    screen.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' }));
    window.dispatchEvent(new Event('blur'));
    screen.requestPointerLock = async options => {
      attempts.push(options?.unadjustedMovement ?? false);
      if (options) throw new DOMException('Raw movement unavailable', 'NotSupportedError');
    };
    await lockGameMouse();
    return { events: events.filter(event => event.type === 'key'), attempts };
  });
  assert.deepEqual(input.events, [{ type: 'key', code: 'KeyW', down: true },
    { type: 'key', code: 'KeyW', down: false }]);
  assert.deepEqual(input.attempts, [true, false]);
  const composition = await page.evaluate(() => {
    const messages = [];
    sendInput = event => messages.push(event);
    $('typing').value = 'ㄓ';
    $('typing').dispatchEvent(new InputEvent('input', { isComposing: true }));
    if ($('typing').value !== 'ㄓ') throw new Error('Composition was cleared before confirmation');
    $('typing').value = '中';
    $('typing').dispatchEvent(new CompositionEvent('compositionend'));
    $('typing').dispatchEvent(new InputEvent('input'));
    return messages;
  });
  assert.deepEqual(composition, [{ type: 'text', text: '中' }]);
  await page.locator('#menuToggle').click();
  assert.equal(await page.locator('#pcInputGuide').isVisible(), true);
  await mkdir(resolve(bridge, 'test-results'), { recursive: true });
  await page.screenshot({ path: resolve(bridge, 'test-results/pc-ui.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: PC entry, iPad default, 16:10 coordinates, fullscreen, blur key release, raw mouse fallback (mock input; no stream or laptop acceptance).');
} finally { await browser.close(); }
