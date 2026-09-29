import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const bridge = resolve(fileURLToPath(new URL('..', import.meta.url)));
const browser = await chromium.launch({ headless: true,
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
try {
  // iPad Air landscape CSS viewport and high-density display; browser remains Chrome.
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 },
    deviceScaleFactor: 2, hasTouch: true });
  await page.setContent(await readFile(resolve(bridge, 'web/index.html'), 'utf8'));
  await page.addStyleTag({ path: resolve(bridge, 'web/style.css') });
  await page.addScriptTag({ path: resolve(bridge, 'web/app.js') });
  await page.locator('#session').evaluate(element => { element.hidden = false; });
  const edge = await page.evaluate(() => {
    const rect = document.querySelector('#screen').getBoundingClientRect();
    return pointerPosition({ clientX: rect.left + rect.width / 2,
      clientY: rect.bottom - 1 }).y;
  });
  if (edge !== 1) throw new Error(`Bottom edge mapped to ${edge}, expected 1`);
  const fitWidth = await page.locator('#screen').evaluate(video => video.getBoundingClientRect().width);
  await page.locator('#zoomScreen').click();
  await page.waitForFunction(() => document.querySelector('#screenViewport').scrollWidth >
    document.querySelector('#screenViewport').clientWidth);
  const zoomWidth = await page.locator('#screen').evaluate(video => video.getBoundingClientRect().width);
  if (zoomWidth < fitWidth * 1.48 || zoomWidth > fitWidth * 1.52)
    throw new Error(`Text zoom scaled ${fitWidth} to ${zoomWidth}, expected 150%`);
  const beforePan = await page.locator('#screenViewport').evaluate(view => view.scrollLeft);
  const viewport = await page.locator('#screenViewport').boundingBox();
  await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + 40);
  await page.mouse.down();
  await page.mouse.move(viewport.x + viewport.width / 2 - 80, viewport.y + 40, { steps: 4 });
  await page.mouse.up();
  const afterPan = await page.locator('#screenViewport').evaluate(view => view.scrollLeft);
  if (afterPan <= beforePan + 50) throw new Error('Zoomed viewport cannot pan');
  await page.locator('#panScreen').click();
  const zoomMapping = await page.evaluate(() => {
    const rect = document.querySelector('#screen').getBoundingClientRect();
    return pointerPosition({ clientX: rect.left + rect.width * .5,
      clientY: rect.top + rect.height * .5 });
  });
  if (Math.abs(zoomMapping.x - .5) > .01 || Math.abs(zoomMapping.y - .5) > .01)
    throw new Error(`Zoomed pointer mapping is wrong: ${JSON.stringify(zoomMapping)}`);
  await page.locator('#zoomScreen').click();
  if (await page.locator('#panScreen').isVisible())
    throw new Error('Pan control should close with zoom');
  if (!(await page.locator('#playAudio').isDisabled())) {
    throw new Error('Audio play button should wait for a remote audio track');
  }
  await page.evaluate(() => {
    window.latencyRequests = [];
    latencyControlAvailable = true;
    document.querySelector('#lowLatency').disabled = false;
    // Safari-like receiver: no jitterBufferTarget or playoutDelayHint.
    peer = { getReceivers: () => [{ track: { kind: 'video' } }] };
    socket = { readyState: WebSocket.OPEN,
      send: data => window.latencyRequests.push(JSON.parse(data)) };
  });
  await page.locator('#lowLatency').check();
  const pending = await page.evaluate(() => ({ applied: lowLatencyApplied,
    request: window.latencyRequests.at(-1) }));
  if (pending.applied || pending.request.type !== 'set-latency' || !pending.request.enabled)
    throw new Error('Mode must request host settings and wait for acknowledgment');
  await page.evaluate(() => handleSignal({ type: 'latency-state', version: 3,
    enabled: true, applied: true, videoHintNegotiated: true,
    videoMinMs: 0, videoMaxMs: 50, audioQueueLimitMs: 60 }));
  if (!(await page.evaluate(() => lowLatencyApplied)) ||
      !(await page.locator('#latencyStatus').textContent()).includes('60 ms'))
    throw new Error('Negotiated host mode was not shown without Safari receiver APIs');
  await page.locator('#lowLatency').uncheck();
  if ((await page.evaluate(() => window.latencyRequests.at(-1))).enabled !== false)
    throw new Error('Turning mode off did not reach host');
  await page.evaluate(() => handleSignal({ type: 'latency-state', version: 3,
    enabled: false, applied: false, videoHintNegotiated: true,
    videoMinMs: 0, videoMaxMs: 10000, audioQueueLimitMs: 120 }));
  await page.locator('#lowLatency').check();
  await page.evaluate(() => handleSignal({ type: 'latency-state', version: 3,
    enabled: true, applied: true, videoHintNegotiated: false,
    videoMinMs: null, videoMaxMs: null, audioQueueLimitMs: 60 }));
  const partialStatus = await page.locator('#latencyStatus').textContent();
  if (!partialStatus.includes('不控制視訊') || !partialStatus.includes('60 ms'))
    throw new Error('Host-only audio control must not claim accepted video control');
  await page.evaluate(() => { peer = null; });
  await page.evaluate(() => {
    window.sentControls = [];
    window.sentSignals = [];
    canControl = true;
    canGamepad = true;
    controlReady = false;
    socket = { readyState: WebSocket.OPEN,
      send: data => window.sentSignals.push(JSON.parse(data)) };
    controlChannel = { readyState: 'open', send: data => window.sentControls.push(JSON.parse(data)) };
  });
  await page.locator('#focusKeys').click();
  const activation = await page.evaluate(() => ({
    checked: document.querySelector('#control').checked,
    focused: document.activeElement?.id,
    signals: window.sentSignals
  }));
  if (!activation.checked || activation.focused !== 'keyCapture' ||
      !activation.signals.some(item => item.type === 'set-control' && item.enabled)) {
    throw new Error('Keyboard control did not enable the session and focus the input area');
  }
  await page.evaluate(() => handleSignal({ type: 'control-state', enabled: true }));
  await page.locator('#toggleGamepad').click();
  const gamepadActivation = await page.evaluate(() => window.sentSignals.find(item =>
    item.type === 'set-gamepad' && item.enabled));
  if (!gamepadActivation) throw new Error('Gamepad button did not request host activation');
  await page.evaluate(() => handleSignal({ type: 'gamepad-state', enabled: true,
    text: 'VIIPER 已連線；Windows 虛擬 Xbox 手把已啟用' }));
  await page.locator('#remoteRefresh').click();
  await page.waitForTimeout(100);
  await page.locator('#focusKeys').click();
  const focused = await page.evaluate(() => document.activeElement?.id);
  if (focused !== 'keyCapture') throw new Error('Physical keyboard target did not receive focus');
  await page.keyboard.press('F5');
  await page.keyboard.press('a');
  await page.locator('#remoteWin').click();
  await page.waitForTimeout(100);
  await page.locator('#focusKeys').click();
  await page.locator('#keyCapture').dispatchEvent('keydown', { key: 'b', code: 'Unidentified' });
  await page.locator('#keyCapture').dispatchEvent('keyup', { key: 'b', code: 'Unidentified' });
  const sentControls = await page.evaluate(() => window.sentControls);
  const f5Down = sentControls.filter(item => item.type === 'key' && item.code === 'F5' && item.down);
  const f5Up = sentControls.filter(item => item.type === 'key' && item.code === 'F5' && !item.down);
  if (f5Down.length !== 2 || f5Up.length !== 2 ||
      !sentControls.some(item => item.code === 'KeyA' && item.down) ||
      !sentControls.some(item => item.code === 'KeyB' && item.down) ||
      !sentControls.some(item => item.code === 'MetaLeft' && item.down) ||
      !sentControls.some(item => item.code === 'MetaLeft' && !item.down)) {
    throw new Error('Remote keyboard did not forward F5 button, physical F5 and game key: ' +
      JSON.stringify(sentControls));
  }
  await page.waitForFunction(() =>
    document.querySelector('#inputMetrics').textContent.includes('Safari 收到'));
  const inputMetrics = await page.locator('#inputMetrics').textContent();
  if (!inputMetrics.includes('操作已啟用') || !inputMetrics.includes('Safari 收到')) {
    throw new Error('Keyboard diagnostics did not show control and browser input state');
  }
  await page.evaluate(() => {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
    buttons[0].pressed = true;
    buttons[0].value = 1;
    window.fakePad = { mapping: 'standard', buttons, axes: [0, 0, 0, 0] };
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true, value: () => [window.fakePad]
    });
  });
  await page.waitForFunction(() => window.sentControls.some(item =>
    item.type === 'gamepad' && item.buttons[0] === 1));
  const padStatus = await page.locator('#gamepadStatus').textContent();
  if (!padStatus.includes('按鈕 A')) throw new Error('Gamepad detection status is missing');
  await page.evaluate(() => {
    window.fakePad.buttons[0].pressed = false;
    window.fakePad.buttons[0].value = 0;
  });
  await page.waitForFunction(() => window.sentControls.some(item =>
    item.type === 'gamepad' && item.buttons[0] === 0));
  await page.locator('#toggleGamepad').click();
  const gamepadDeactivation = await page.evaluate(() => window.sentSignals.find(item =>
    item.type === 'set-gamepad' && !item.enabled));
  if (!gamepadDeactivation) throw new Error('Gamepad button did not request host deactivation');
  await page.evaluate(() => {
    peer = {};
    lastRenderedAt = performance.now() - 60000;
    lastFrameTime = 0;
  });
  await page.waitForFunction(() => document.querySelector('#videoStatus').textContent.includes('畫面已停住'));
  const metrics = await page.locator('#metrics').textContent();
  if (metrics.includes('60000.0 ms')) throw new Error('Stall was mislabeled as frame gap');
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.locator('#exportMetrics').click()
  ]);
  const csv = await readFile(await download.path(), 'utf8');
  const [header, row] = csv.trim().split(/\r?\n/);
  if (!row || header.split(',').length !== row.split(',').length ||
      !header.includes('low_latency_applied') || !header.includes('gamepad_active'))
    throw new Error('Metrics CSV columns are misaligned or missing latency state');
  console.log('iPad-size text zoom, panning, pointer mapping, audio readiness, and stall display passed');
} finally {
  await browser.close();
}
