import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true,
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
try {
  const page = await browser.newPage();
  await page.setContent(await readFile(new URL('../web/index.html', import.meta.url), 'utf8'));
  await page.addScriptTag({ path: new URL('../web/app.js', import.meta.url).pathname.replace(/^\//, '') });
  await page.evaluate(() => {
    $('session').hidden = false;
    canControl = controlReady = true;
    $('control').checked = true;
    screen.requestPointerLock = undefined; // iPad fallback must work without this API.
    screen.setPointerCapture = () => {};
    window.inputs = [];
    sendInput = value => inputs.push(value);
    sendInputRaw = value => inputs.push(value);
    $('gameMouse').click();
    mouseModeReady = true; // simulate the ordered host mode acknowledgement.
  });
  await page.evaluate(() => {
    screen.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: 300, clientY: 400 }));
    screen.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: 325, clientY: 390 }));
    screen.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: 330, clientY: 395 }));
  });
  await page.waitForTimeout(50);
  assert.deepEqual(await page.evaluate(() => inputs), [{ type: 'move-relative', dx: 30, dy: -5 }]);
  await page.evaluate(() => {
    inputs.length = 0;
    screen.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', button: 2, clientX: 330, clientY: 395 }));
    screen.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'mouse', button: 2 }));
  });
  assert.deepEqual(await page.evaluate(() => inputs), [
    { type: 'button', button: 2, down: true }, { type: 'button', button: 2, down: false }]);
  // Touch dragging turns the camera without holding attack; lifting/restarting has no jump.
  await page.evaluate(() => {
    inputs.length = 0;
    screen.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', clientX: 200, clientY: 200 }));
    screen.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'touch', clientX: 220, clientY: 205 }));
    screen.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' }));
  });
  await page.waitForTimeout(50);
  assert.deepEqual(await page.evaluate(() => inputs), [{ type: 'move-relative', dx: 20, dy: 5 }]);
  // Locked mouse events keep client coordinates constant: movement deltas still turn the camera.
  await page.evaluate(() => {
    inputs.length = 0;
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, value: screen });
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: -40, movementY: 8 }));
    screen.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', movementX: -40, movementY: 8 }));
  });
  await page.waitForTimeout(50);
  assert.deepEqual(await page.evaluate(() => inputs), [{ type: 'move-relative', dx: -40, dy: 8 }]);
  await page.evaluate(() => {
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, value: null });
    inputs.length = 0;
    $('gameMouse').click();
    screen.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: 250, clientY: 100 }));
  });
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => inputs.at(-1).type), 'move');
  await page.evaluate(async () => {
    window.remoteDeskNative = { version: 1 };
    window.nativeMessages = [];
    window.webkit = { messageHandlers: { remoteDeskMouse: {
      postMessage: value => nativeMessages.push(value) } } };
    inputs.length = 0;
    $('gameMouse').click();
    await handleSignal({ type: 'mouse-mode', mode: 'relative' });
    remoteDeskNativeStatus({ epoch: nativeMouseEpoch, locked: true });
    remoteDeskNativeInput([
      { type: 'move', dx: 15, dy: -6 },
      { type: 'button', button: 0, down: true },
      { type: 'button', button: 0, down: false }
    ], nativeMouseEpoch);
    screen.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: 700, clientY: 750 }));
    screen.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', button: 0 }));
    screen.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'mouse', button: 0 }));
  });
  await page.waitForTimeout(50);
  assert.deepEqual(await page.evaluate(() => inputs), [
    { type: 'move-relative', dx: 15, dy: -6 },
    { type: 'button', button: 0, down: true },
    { type: 'button', button: 0, down: false }
  ]);
  assert.equal(await page.evaluate(() => nativeMessages.at(-1).enabled), true);
  await page.evaluate(async () => {
    const oldEpoch = nativeMouseEpoch;
    remoteDeskNativeRelease();
    $('gameMouse').click();
    await handleSignal({ type: 'mouse-mode', mode: 'relative' });
    remoteDeskNativeStatus({ epoch: nativeMouseEpoch, locked: true });
    inputs.length = 0;
    remoteDeskNativeInput([{ type: 'move', dx: 900, dy: 900 }], oldEpoch);
    remoteDeskNativeStatus({ epoch: oldEpoch, locked: false });
  });
  await page.waitForTimeout(50);
  assert.deepEqual(await page.evaluate(() => inputs), []);
  assert.equal(await page.evaluate(() => nativeMouseLocked), true);
  await page.evaluate(() => {
    remoteDeskNativeRelease();
    inputs.length = 0;
    screen.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: 250, clientY: 100 }));
  });
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => inputs.at(-1).type), 'move');
  await page.evaluate(() => {
    window.remoteDeskNative = { version: 2, keyboard: true, gamepad: true };
    $('controlsPanel').hidden = true;
    screen.focus();
    syncNativeControls();
    inputs.length = 0;
    remoteDeskNativeControlInput([
      { type: 'key', code: 'ShiftRight', down: true },
      { type: 'key', code: 'KeyW', down: true },
      { type: 'key', code: 'ArrowUp', down: true },
      { type: 'key', code: 'ArrowUp', down: false },
      { type: 'key', code: 'KeyW', down: false },
      { type: 'key', code: 'ShiftRight', down: false },
      { type: 'key', code: 'F5', down: true },
      { type: 'key', code: 'F5', down: false }
    ], nativeControlEpoch);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW' }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'w', code: 'KeyW' }));
  });
  assert.deepEqual(await page.evaluate(() => inputs.map(v => [v.code, v.down])), [
    ['ShiftRight', true], ['KeyW', true], ['ArrowUp', true], ['ArrowUp', false],
    ['KeyW', false], ['ShiftRight', false], ['F5', true], ['F5', false]
  ]);
  assert.equal(await page.evaluate(() => nativeMouseLocked), false);
  await page.evaluate(() => {
    remoteDeskNativeControlInput([{ type: 'key', code: 'KeyA', down: true }], nativeControlEpoch);
    window.oldControlEpoch = nativeControlEpoch;
    $('controlsPanel').hidden = false; $('touchKeyboardBox').open = true; $('typing').focus(); syncNativeControls();
    remoteDeskNativeControlInput([{ type: 'key', code: 'KeyW', down: true }], oldControlEpoch);
  });
  assert.equal(await page.evaluate(() => downKeys.size), 0);
  assert.deepEqual(await page.evaluate(() => inputs.at(-1)), { type: 'key', code: 'KeyA', down: false });
  await page.evaluate(() => {
    inputs.length = 0; gamepadActive = true; syncNativeControls();
    remoteDeskNativeControlInput([{ type: 'gamepad', buttons: [1,...Array(16).fill(0)],
      axes: [0.2,-0.5,0,0] }], nativeControlEpoch);
  });
  assert.equal(await page.evaluate(() => inputs.at(-1).type), 'gamepad');
  assert.equal(await page.evaluate(() => inputs.at(-1).buttons[0]), 1);
  assert.equal(await page.evaluate(() => inputs.at(-1).axes[1]), -0.5);
  await page.evaluate(() => {
    $('control').checked = false; syncNativeControls(); inputs.length = 0;
    remoteDeskNativeControlInput([{ type: 'key', code: 'KeyW', down: true },
      { type: 'gamepad', buttons: Array(17).fill(1), axes: [0,0,0,0] }], nativeControlEpoch);
  });
  assert.equal(await page.evaluate(() => inputs.length), 0);
  console.log('Native keyboard chords, right Shift, arrows, F5, no mouse-lock dependency, DOM deduplication, focus release, stale input and native pad gating passed');
  console.log('Relative mouse aggregation, no absolute clicks, touch look, locked deltas, desktop restoration passed');
  console.log('Native capture handshake, motion-before-click, DOM deduplication, stale epoch rejection, release passed');
} finally { await browser.close(); }
