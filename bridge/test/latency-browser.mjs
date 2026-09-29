import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Synthetic H.264 avoids using TCP 5000 or interrupting the user's live capture.
const bridge = fileURLToPath(new URL('..', import.meta.url));
const impaired = process.env.TEST_AUDIO_IMPAIRMENT === '1';
const syncMode = process.env.TEST_SYNC_MODE || 'interactive';
const durationSeconds = Number(process.env.TEST_DURATION_SECONDS || 45);
const playAudio = process.env.TEST_AUDIO_PLAYBACK !== '0';
const testWidth = process.env.TEST_RESOLUTION === '1080' ? 1920 : 1280;
const testHeight = testWidth === 1920 ? 1080 : 720;
const server = spawn(process.execPath, [...(impaired ? ['--import', './test/impair-audio.mjs'] : []), 'server.mjs', '--port=8544',
  '--tcp-port=55444', '--no-launch', '--audio'], { cwd: bridge, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', browser, source;
server.stdout.on('data', data => { output += data; });
server.stderr.on('data', data => { output += data; });
try {
  const deadline = Date.now() + 12000;
  while (!output.includes('One-time pairing code') && Date.now() < deadline && server.exitCode === null)
    await new Promise(done => setTimeout(done, 100));
  const code = output.match(/One-time pairing code for this server run: (\d{8})/)?.[1];
  assert.ok(code, `Server failed to start: ${output}`);
  browser = await chromium.launch({ headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await page.goto('https://127.0.0.1:8544');
  await page.locator('#syncMode').selectOption(syncMode);
  await page.locator('#code').fill(code);
  await page.locator('#connect').click();
  await page.waitForFunction(() => peer?.connectionState === 'connected');
  await page.waitForFunction(() => latencyState?.videoHintSuppressed === true);
  await page.waitForFunction(() => latencyState?.audioQueueLimitMs === 120);
  assert.ok(!(await page.evaluate(() => peer.remoteDescription.sdp)).includes('playout-delay'),
    'Unsafe video playout extension was offered');
  await page.locator('#sound').evaluate(element => { element.volume = 0; });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(async () => [...(await peer.getStats()).values()]
    .find(s => s.type === 'inbound-rtp' && s.kind === 'audio')?.packetsReceived ?? 0), 0,
    'Audio must not be transmitted before playback is requested');
  if (playAudio) {
    await page.locator('#playAudio').click();
    await page.waitForFunction(() => audioPlaybackState === '播放中');
  } else {
    // Reproduce the old behavior: audio transmitted but not played.
    await page.evaluate(() => sendSignal({ type: 'set-audio-playback', enabled: true }));
  }
  await page.locator('#sound').evaluate(element => { element.volume = 0; });
  source = connect({ host: '127.0.0.1', port: 55444 });
  await once(source, 'connect');
  source.setNoDelay(true);
  source.on('error', error => { output += `\nSource: ${error.message}`; });
  let sequence = 0;
  await page.exposeFunction('sendEncodedTestFrame', ({ bytes, timestamp }) => {
    if (!source?.writable) return;
    const data = Buffer.from(bytes);
    const header = Buffer.alloc(68);
    [0x5244534b, 4, sequence++, testWidth, testHeight, data.length].forEach((v, i) => header.writeUInt32BE(v, i * 4));
    header.writeBigUInt64BE(BigInt(timestamp) * 10n, 24);
    header.writeUInt32BE(60, 64);
    source.write(Buffer.concat([header, data]));
  });
  await page.evaluate(async ({ width, height }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    const config = { codec: 'avc1.42c02a', width, height,
      bitrate: width === 1920 ? 16000000 : 2000000, framerate: 60, latencyMode: 'realtime', avc: { format: 'annexb' } };
    if (!(await VideoEncoder.isConfigSupported(config)).supported)
      throw new Error('Chrome cannot encode the H.264 test fixture');
    window.testEncoderError = '';
    const encoder = new VideoEncoder({
      output: chunk => {
        const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
        void window.sendEncodedTestFrame({ bytes: Array.from(data), timestamp: chunk.timestamp });
      }, error: error => { window.testEncoderError = error.message; }
    });
    encoder.configure(config);
    let frame = 0;
    const started = performance.now();
    window.testEncoder = encoder;
    let nextFrameAt = started;
    window.testFrameTimer = setInterval(() => {
      const now = performance.now();
      if (encoder.state !== 'configured' || encoder.encodeQueueSize > 1 || now < nextFrameAt) return;
      nextFrameAt += 1000 / 60;
      if (now - nextFrameAt > 50) nextFrameAt = now;
      ctx.fillStyle = '#123'; ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#fff'; ctx.fillRect((frame * 9) % (width - 80), 100, 80, height - 120);
      const input = new VideoFrame(canvas, { timestamp: Math.round((performance.now() - started) * 1000) });
      encoder.encode(input, { keyFrame: frame % 60 === 0 });
      input.close(); frame++;
    }, 4);
  }, { width: testWidth, height: testHeight });
  const decoded = () => page.evaluate(async () => {
    const reports = await peer.getStats();
    return [...reports.values()].find(s => s.type === 'inbound-rtp' && s.kind === 'video')?.framesDecoded ?? 0;
  });
  await page.waitForFunction(async () => {
    const reports = await peer.getStats();
    return [...reports.values()].some(s => s.type === 'inbound-rtp' && s.kind === 'video' && s.framesDecoded > 15);
  }, null, { timeout: 15000 });
  const stages = [];
  if (impaired) {
    for (let second = 0; second < durationSeconds; second++) {
      const before = await page.evaluate(() => painted);
      await page.waitForTimeout(1000);
      stages.push(await page.evaluate(({ before, second }) => ({ second,
        presentedFrames: painted - before, ...receiverMetrics }), { before, second }));
      if ((second + 1) % 30 === 0) console.log(JSON.stringify({
        elapsedSeconds: second + 1, ...stages.at(-1) }));
    }
    assert.ok(stages.slice(3).every(row => row.presentedFrames > 10), 'Presentation stalled');
    if (syncMode === 'interactive') assert.ok(
      Math.max(...stages.slice(3).map(row => row.videoBufferMs || 0)) < 150,
      'Interactive video was held back by audio impairment');
    const dir = resolve(bridge, 'test-results');
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, `sync-${syncMode}-${playAudio ? "playing" : "unplayed"}-${durationSeconds}s.json`), JSON.stringify({ syncMode, playAudio, durationSeconds, width: testWidth, height: testHeight, stages }, null, 2));
    console.log(JSON.stringify({ syncMode, playAudio, durationSeconds,
      peakVideoBufferMs: Math.max(...stages.map(row => row.videoBufferMs || 0)),
      peakAudioBufferMs: Math.max(...stages.map(row => row.audioBufferMs || 0)) }));
    await page.evaluate(() => { clearInterval(window.testFrameTimer); window.testEncoder.close(); });
    await page.locator('#disconnect').click();
    await browser.close(); browser = null;
    source.destroy(); source = null;
    server.kill();
    process.exitCode = 0;
  } else {
  for (const enabled of [false, true, false, true]) {
    if (enabled) await page.locator('#lowLatency').check();
    else await page.locator('#lowLatency').uncheck();
    await page.waitForFunction(value => latencyState?.enabled === value &&
      latencyState.videoMaxMs === null, enabled);
    const before = await decoded();
    const presentedBefore = await page.evaluate(() => painted);
    await page.waitForTimeout(3500);
    const after = await decoded();
    const presentedAfter = await page.evaluate(() => painted);
    assert.ok(after - before > 30, `Video stopped after mode=${enabled}: ${after - before}`);
    assert.ok(presentedAfter - presentedBefore > 30,
      `Video decoded but stopped presenting after mode=${enabled}: ${presentedAfter - presentedBefore}`);
    const state = await page.evaluate(() => ({ ...latencyState, metrics: { ...receiverMetrics } }));
    assert.equal(state.applied, enabled);
    assert.equal(state.audioQueueLimitMs, enabled ? 60 : 120);
    const audioPackets = await page.evaluate(async () => [...(await peer.getStats()).values()]
      .find(s => s.type === 'inbound-rtp' && s.kind === 'audio')?.packetsReceived ?? 0);
    assert.ok(audioPackets > 50, 'Audio RTP stopped while switching mode');
    assert.equal(server.exitCode, null, `Server exited: ${output}`);
    stages.push({ enabled, decodedFrames: after - before,
      presentedFrames: presentedAfter - presentedBefore, state });
  }
  // Stop/resume actual audio playout without restarting video or rewinding RTP time.
  await page.locator('#playAudio').click();
  const framesBeforePause = await page.evaluate(() => painted);
  await page.waitForTimeout(500);
  const audioBeforePause = await page.evaluate(async () => [...(await peer.getStats()).values()]
    .find(s => s.type === 'inbound-rtp' && s.kind === 'audio')?.packetsReceived ?? 0);
  await page.waitForTimeout(2200);
  const audioAfterPause = await page.evaluate(async () => [...(await peer.getStats()).values()]
    .find(s => s.type === 'inbound-rtp' && s.kind === 'audio')?.packetsReceived ?? 0);
  assert.equal(audioBeforePause, audioAfterPause, 'Paused audio kept transmitting');
  assert.ok(await page.evaluate(before => painted - before > 30, framesBeforePause));
  await page.locator('#playAudio').click();
  await page.waitForTimeout(1500);
  assert.ok(await page.evaluate(async before => [...(await peer.getStats()).values()]
    .find(s => s.type === 'inbound-rtp' && s.kind === 'audio').packetsReceived > before + 20,
    audioAfterPause), 'Audio failed to resume');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#exportMetrics').click();
  const download = await downloadPromise;
  const { readFile } = await import('node:fs/promises');
  const csv = await readFile(await download.path(), 'utf8');
  const lines = csv.trim().split(/\r?\n/).map(line => line.split(','));
  assert.ok(lines[0].includes('video_playout_negotiated'));
  assert.ok(lines.slice(1).every(line => line.length === lines[0].length));
  await page.evaluate(() => { clearInterval(window.testFrameTimer); window.testEncoder.close(); });
  await page.locator('#disconnect').click();
  source.destroy(); source = null;
  // A second pairing must work after the first peer is disposed.
  await page.waitForTimeout(300);
  await page.locator('#connect').click();
  await page.waitForFunction(() => peer?.connectionState === 'connected');
  await page.waitForFunction(() => latencyState?.videoHintSuppressed === true);
  assert.equal(await page.locator('#lowLatency').isChecked(), false);
  await page.locator('#disconnect').click();
  await page.waitForTimeout(300);
  const ipad = await browser.newPage({ ignoreHTTPSErrors: true });
  await ipad.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15 Safari/605.1.15' });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5 });
  });
  await ipad.goto('https://127.0.0.1:8544');
  await ipad.locator('#code').fill(code);
  await ipad.locator('#connect').click();
  await ipad.waitForFunction(() => peer?.connectionState === 'connected');
  await ipad.waitForFunction(() => latencyState?.videoHintSuppressed === true);
  await ipad.waitForFunction(() => latencyState?.audioQueueLimitMs === 120);
  await ipad.locator('#lowLatency').check();
  await ipad.waitForFunction(() => latencyState?.enabled === true);
  assert.deepEqual(await ipad.evaluate(() => ({ video: latencyState.videoHintNegotiated,
    audio: latencyState.audioQueueLimitMs, applied: latencyState.applied })),
    { video: false, audio: 60, applied: true });
  await ipad.evaluate(() => handleSignal({ type: 'paired', inputEnabled: false,
    audioEnabled: true, gamepadEnabled: false, latencyControl: true,
    latencyControlVersion: 2 }));
  assert.equal(await ipad.locator('#lowLatency').isDisabled(), true,
    'iPad must reject a still-running unsafe bridge after refreshing the page');
  await ipad.locator('#disconnect').click();
  await ipad.close();
  const dir = resolve(bridge, 'test-results');
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'latency-browser.json'), JSON.stringify({
    at: new Date().toISOString(), scope: 'Local Chrome synthetic H.264; not iPad latency validation', stages
  }, null, 2));
  console.log('Live pairing, H.264 decoding, audio RTP, repeated mode changes, CSV and reconnect passed.');
  console.log(JSON.stringify(stages));
  }
} catch (error) {
  console.error(output);
  throw error;
} finally {
  source?.destroy();
  await browser?.close();
  if (server.exitCode === null) server.kill();
}
