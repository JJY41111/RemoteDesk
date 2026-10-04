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
  if (await page.locator('#videoMode').inputValue() !== '1080p')
    throw new Error('The known-good 1080p mode must stay the default');
  await page.locator('#videoMode').selectOption('stable1080');
  if (await page.locator('#videoMode').inputValue() !== 'stable1080')
    throw new Error('The opt-in 1080p stable mode is missing');
  await page.locator('#videoMode').selectOption('mobile1080');
  if (await page.locator('#videoMode').inputValue() !== 'mobile1080')
    throw new Error('The opt-in 1080p60 lower-flow mode is missing');
  await page.locator('#videoMode').selectOption('game1080');
  if (await page.locator('#videoMode').inputValue() !== 'game1080')
    throw new Error('The opt-in game recovery mode is missing');
  await page.locator('#videoMode').selectOption('1080p');
  await page.locator('#session').evaluate(element => { element.hidden = false; });
  const video = await page.locator('#screenViewport').boundingBox();
  if (!video || video.height < 760 || await page.locator('#controlsPanel').isVisible())
    throw new Error('Session must fill the viewport with controls initially hidden');
  await page.locator('#menuToggle').click();
  if (!(await page.locator('#lowLatency').isVisible()))
    throw new Error('The menu must expose the latency control');
  if (await page.locator('.transfer-card').count() !== 2 ||
      !(await page.locator('#clipboardText').isVisible()) ||
      !(await page.locator('#uploadFiles').isVisible()) ||
      await page.locator('#uploadFiles').getAttribute('accept') !== null)
    throw new Error('Clipboard and unrestricted file transfer cards are missing');
  await page.locator('#controlsPanel').screenshot({
    path: resolve(bridge, 'test-results', 'ipad-transfer-ui.png') });
  const edge = await page.evaluate(() => {
    const rect = document.querySelector('#screen').getBoundingClientRect();
    return pointerPosition({ clientX: rect.left + rect.width / 2,
      clientY: rect.bottom - 1 }).y;
  });
  if (edge !== 1) throw new Error(`Bottom edge mapped to ${edge}, expected 1`);
  const pointerRouting = await page.evaluate(() => {
    const messages = [];
    const old = { canControl, pointerFast, pointerChannel, controlChannel,
      pointerSequence, socket };
    canControl = true;
    pointerFast = true;
    pointerSequence = 0;
    pointerChannel = { readyState: 'open', bufferedAmount: 0,
      send: text => messages.push(['fast', JSON.parse(text)]) };
    controlChannel = { readyState: 'open',
      send: text => messages.push(['reliable', JSON.parse(text)]) };
    socket = { readyState: WebSocket.OPEN,
      send: text => messages.push(['signal', JSON.parse(text).input]) };
    sendInputRaw({ type: 'move', x: .2, y: .3 });
    sendInputRaw({ type: 'move', x: .4, y: .5, reliable: true });
    sendInputRaw({ type: 'button', button: 0, down: true });
    sendInputRaw({ type: 'key', code: 'KeyA', down: true });
    pointerFast = false;
    sendInputRaw({ type: 'button', button: 0, down: false });
    canControl = old.canControl;
    pointerFast = old.pointerFast;
    pointerChannel = old.pointerChannel;
    controlChannel = old.controlChannel;
    pointerSequence = old.pointerSequence;
    socket = old.socket;
    return messages;
  });
  if (pointerRouting[0][0] !== 'fast' ||
      pointerRouting[1][0] !== 'signal' ||
      pointerRouting[2][0] !== 'signal' ||
      pointerRouting[3][0] !== 'signal' ||
      pointerRouting[4][0] !== 'reliable' ||
      pointerRouting[0][1].seq !== 0 || pointerRouting[1][1].seq !== 1)
    throw new Error('Tailnet input routing or LAN DataChannel regression');
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
  await page.locator('#screen').focus();
  await page.keyboard.press('Backquote');
  if ((await page.locator('#panScreen').getAttribute('aria-pressed')) !== 'true')
    throw new Error('Backquote did not switch to view panning');
  await page.keyboard.press('Backquote');
  if ((await page.locator('#panScreen').getAttribute('aria-pressed')) !== 'false')
    throw new Error('Backquote did not return to remote control');
  await page.locator('#touchKeyboardBox').evaluate(element => { element.open = true; });
  await page.locator('#typing').focus();
  await page.keyboard.press('Backquote');
  if ((await page.locator('#panScreen').getAttribute('aria-pressed')) !== 'false')
    throw new Error('Typing a backquote must not switch the view');
  await page.locator('#screen').focus();
  await page.keyboard.down('Backquote');
  await page.keyboard.down('Backquote');
  if ((await page.locator('#panScreen').getAttribute('aria-pressed')) !== 'true')
    throw new Error('Holding Backquote must only toggle once');
  await page.keyboard.up('Backquote');
  await page.keyboard.press('Backquote');
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
    audioPlaybackState = '播放中';
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
  if ((await page.evaluate(() => lowLatencyApplied)) ||
      !(await page.locator('#latencyStatus').textContent()).includes('未提供影音接收緩衝控制'))
    throw new Error('Old Safari must not claim video latency control');
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
  if (!partialStatus.includes('未提供影音接收緩衝控制') || !partialStatus.includes('60 ms'))
    throw new Error('Host-only audio control must not claim accepted video control');
  await page.evaluate(() => {
    const video = { track: { kind: 'video' }, jitterBufferTarget: null };
    peer = { getReceivers: () => [video] };
    receiverMetrics = { videoBufferMs: 28 };
    applyReceiverLatency();
  });
  if (await page.evaluate(() => lowLatencyApplied))
    throw new Error('Enabling receiver control must not increase an already low buffer');
  await page.evaluate(() => {
    const video = { track: { kind: 'video' }, jitterBufferTarget: null };
    const audio = { track: { kind: 'audio' }, jitterBufferTarget: null };
    peer = { getReceivers: () => [video, audio] };
    receiverMetrics = { rttMs: 35, videoMinimumMs: 90, audioMinimumMs: 100,
      videoTargetMs: 200, audioTargetMs: 400 };
    applyReceiverLatency();
  });
  const nativeTargets = await page.evaluate(() => requestedReceiverLatency);
  if (nativeTargets.video < 80 || nativeTargets.audio < 100 || !nativeTargets.supported ||
      !(await page.evaluate(() => lowLatencyApplied)))
    throw new Error('Supported receiver did not get conservative audio/video targets');
  if (!(await page.locator('#latencyStatus').textContent()).includes(`${nativeTargets.video} ms`))
    throw new Error('Status did not update after receiver metrics triggered latency control');
  await page.locator('#receiverTarget').selectOption('160');
  if ((await page.evaluate(() => requestedReceiverLatency.video)) !== 160)
    throw new Error('Manual receiver target selection did not reach the receiver');
  await page.evaluate(() => {
    Object.defineProperty(document.querySelector('#screen'), 'paused',
      { configurable: true, get: () => false });
    receiverMetrics.videoFps = '60';
    receiverStatsAt = performance.now();
    lastRenderedAt = performance.now() - 3000;
  });
  await page.waitForFunction(() => !lowLatencyApplied);
  if ((await page.evaluate(() => requestedReceiverLatency.video)) !== null ||
      !(await page.locator('#latencyStatus').textContent()).includes('已自動還原畫面緩衝設定'))
    throw new Error('Frozen video did not restore browser playout defaults');
  await page.evaluate(() => handleSignal({ type: 'latency-state', enabled: false,
    applied: false, audioQueueLimitMs: 120 }));
  if ((await page.evaluate(() => requestedReceiverLatency.video)) !== null)
    throw new Error('Stopping low latency must restore browser defaults');
  await page.evaluate(() => {
    const video = { track: { kind: 'video' } };
    Object.defineProperty(video, 'jitterBufferTarget', {
      get: () => null, set: () => { throw new Error('Unsupported setter'); }
    });
    peer = { getReceivers: () => [video] };
    receiverSafetyBlocked = false;
    latencyState = { enabled: true, audioQueueLimitMs: 60 };
    receiverMetrics = { videoBufferMs: 240 };
    applyReceiverLatency();
  });
  if ((await page.evaluate(() => lowLatencyApplied)) ||
      !(await page.locator('#latencyStatus').textContent()).includes('設定失敗'))
    throw new Error('Rejected receiver target was incorrectly reported as applied');
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
  if (!activation.checked || activation.focused !== 'screen' ||
      !activation.signals.some(item => item.type === 'set-control' && item.enabled)) {
    throw new Error('Keyboard control did not enable the session and focus the video');
  }
  if (await page.locator('#controlsPanel').isVisible())
    throw new Error('Keyboard control must close the menu to expose the remote screen');
  await page.locator('#menuToggle').click();
  await page.locator('#remoteWin').click();
  await page.evaluate(() => handleSignal({ type: 'control-state', enabled: false,
    text: '正在啟動 Windows 輸入程式' }));
  const waitingInput = await page.evaluate(() => ({ pendingWin, checked:
    document.querySelector('#control').checked, ready: controlReady }));
  if (!waitingInput.pendingWin || !waitingInput.checked || waitingInput.ready)
    throw new Error('Input helper startup discarded a queued Win action');
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
  if (focused !== 'screen') throw new Error('Physical keyboard target did not receive focus');
  await page.keyboard.press('F5');
  await page.keyboard.press('a');
  await page.locator('#menuToggle').click();
  await page.locator('#remoteWin').click();
  await page.waitForTimeout(100);
  await page.locator('#focusKeys').click();
  await page.locator('#screen').dispatchEvent('keydown', { key: 'b', code: 'Unidentified' });
  await page.locator('#screen').dispatchEvent('keyup', { key: 'b', code: 'Unidentified' });
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
  const navigationStart = await page.evaluate(() => window.sentControls.length);
  await page.locator('#screen').dispatchEvent('keydown',
    { key: 'Shift', code: 'Unidentified', location: 1 });
  await page.locator('#screen').dispatchEvent('keyup',
    { key: 'Shift', code: 'Unidentified', location: 1 });
  await page.locator('#screen').dispatchEvent('keydown',
    { key: 'Shift', code: 'ShiftRight', location: 2 });
  await page.locator('#screen').dispatchEvent('keyup',
    { key: 'Shift', code: 'ShiftRight', location: 2 });
  await page.locator('#screen').dispatchEvent('keydown',
    { key: 'ArrowLeft', code: 'Numpad4' });
  await page.locator('#screen').dispatchEvent('keyup',
    { key: 'ArrowLeft', code: 'Numpad4' });
  await page.locator('#menuToggle').click();
  await page.locator('#typing').focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Shift');
  const navigation = await page.evaluate(start => ({
    messages: window.sentControls.slice(start),
    text: document.querySelector('#typing').value,
    diagnosticReadOnly: document.querySelector('#keyCapture').readOnly
  }), navigationStart);
  const hasKey = (code, down) => navigation.messages.some(item =>
    item.type === 'key' && item.code === code && item.down === down);
  if (!hasKey('ShiftLeft', true) || !hasKey('ShiftLeft', false) ||
      !hasKey('ShiftRight', true) || !hasKey('ShiftRight', false) ||
      !hasKey('ArrowLeft', true) || !hasKey('ArrowLeft', false) ||
      !hasKey('ArrowUp', true) || !hasKey('ArrowUp', false) ||
      navigation.messages.some(item => item.type === 'text') || navigation.text ||
      !navigation.diagnosticReadOnly) {
    throw new Error('Shift and navigation keys must reach Windows without local text: ' +
      JSON.stringify(navigation));
  }
  await page.locator('#closeMenu').click();
  await page.waitForFunction(() => keyEventsSeen > 0 &&
    document.querySelector('#inputMetrics').textContent.includes('操作已啟用'));
  const inputMetrics = await page.locator('#inputMetrics').textContent();
  if (!inputMetrics.includes('操作已啟用') || !inputMetrics.includes('Safari 收到')) {
    throw new Error('Keyboard diagnostics did not show control and browser input state: ' +
      inputMetrics);
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
  await page.waitForFunction(() => document.querySelector('#gamepadStatus').textContent.includes('按鈕 A'));
  const padStatus = await page.locator('#gamepadStatus').textContent();
  if (!padStatus.includes('按鈕 A')) throw new Error('Gamepad detection status is missing');
  const fastPath = await page.evaluate(() => {
    window.fastGamepad = [];
    gamepadChannel = { readyState: 'open', bufferedAmount: 0,
      send: data => window.fastGamepad.push(JSON.parse(data)) };
    window.sentControls.length = 0;
    window.fakePad.buttons[1].pressed = true;
    window.fakePad.buttons[1].value = 1;
    pollGamepad();
    gamepadChannel.bufferedAmount = 2048;
    window.fakePad.buttons[1].value = 0;
    pollGamepad();
    const skipped = gamepadSkipped;
    gamepadChannel.bufferedAmount = 0;
    pollGamepad();
    return { fast: window.fastGamepad, reliable: window.sentControls,
      skipped, sent: gamepadSent };
  });
  if (!fastPath.fast.some(item => item.buttons[1] === 1) ||
      !fastPath.fast.some(item => item.buttons[1] === 0) ||
      fastPath.reliable.some(item => item.type === 'gamepad') ||
      fastPath.skipped < 1 || fastPath.sent < 1) {
    throw new Error('Fast gamepad channel did not skip backlog and send the newest state: ' +
      JSON.stringify(fastPath));
  }
  await page.evaluate(() => {
    window.fakePad.buttons[0].pressed = false;
    window.fakePad.buttons[0].value = 0;
  });
  await page.waitForFunction(() => window.fastGamepad.some(item =>
    item.type === 'gamepad' && item.buttons[0] === 0));
  await page.locator('#menuToggle').click();
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
      !header.includes('low_latency_applied') || !header.includes('gamepad_active') ||
      !header.includes('client_version') || !header.includes('gamepad_ack_rtt_ms'))
    throw new Error('Metrics CSV columns are misaligned or missing latency state');
  const reconnectedControl = await page.evaluate(async () => {
    peer = null;
    socket = null;
    controlChannel = null;
    gamepadChannel = null;
    pointerChannel = null;
    stop('test disconnect');
    // Simulate a stale UI state left by a browser lifecycle edge case.
    document.querySelector('#control').checked = true;
    controlReady = true;
    await handleSignal({ type: 'paired', inputEnabled: true, gamepadEnabled: true,
      audioEnabled: false, latencyControl: true, latencyControlVersion: 4,
      pointerFast: true, syncMode: 'interactive', videoMode: '1080p' });
    return { checked: document.querySelector('#control').checked, ready: controlReady };
  });
  if (reconnectedControl.checked || reconnectedControl.ready)
    throw new Error('A new pairing inherited stale remote-control consent');
  console.log('iPad-size text zoom, panning, pointer mapping, audio readiness, and stall display passed');
} finally {
  await browser.close();
}
