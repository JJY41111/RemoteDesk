import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const bridge = resolve(fileURLToPath(new URL('..', import.meta.url)));
const project = resolve(bridge, '..');
const audio = process.env.BRIDGE_AUDIO === '1';
const auto = process.env.BRIDGE_AUTO === '1' || audio;
const input = process.env.BRIDGE_INPUT === '1';
const soakSeconds = Number(process.env.BRIDGE_SOAK_SECONDS || 0);
const server = spawn(process.execPath, ['server.mjs', '--port=8444',
  ...(auto ? (process.env.BRIDGE_1080 === '1' ? [] : ['--720p']) : ['--no-launch']),
  ...(audio ? ['--audio'] : []),
  ...(input ? ['--enable-input'] : [])],
  { cwd: bridge, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  let output = '';
  server.stdout.on('data', data => { output += String(data); });
  server.stderr.on('data', data => { output += String(data); });
  const deadline = Date.now() + 12000;
  while (!output.includes('One-time pairing code') && Date.now() < deadline && server.exitCode === null) {
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  const code = output.match(/One-time pairing code for this server run: (\d{8})/)?.[1];
  if (!code) throw new Error('Server did not start: ' + output);
  browser = await chromium.launch({ headless: true,
    ignoreDefaultArgs: soakSeconds && audio ? ['--mute-audio'] : [],
    args: ['--autoplay-policy=no-user-gesture-required'],
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  if (soakSeconds && audio) {
    const source = await context.newPage();
    await source.setContent('<p>Continuous audio capture test</p>');
    await source.evaluate(async () => {
      const context = new AudioContext({ sampleRate: 48000 });
      const tone = context.createOscillator();
      const gain = context.createGain();
      tone.frequency.value = 440;
      gain.gain.value = 0.025;
      tone.connect(gain).connect(context.destination);
      tone.start();
      await context.resume();
      window.testAudioContext = context;
    });
  }
  page.on('console', message => { if (message.type() === 'error') output += '\nBrowser: ' + message.text(); });
  await page.goto('https://127.0.0.1:8444');
  await page.bringToFront();
  await page.locator('#code').fill(code);
  await page.locator('#connect').click();
  await page.locator('#session').waitFor({ state: 'visible', timeout: 15000 });
  if (input) {
    await page.locator('#control').check();
    await page.waitForFunction(() => controlReady === true);
    await page.locator('#control').uncheck();
    await page.waitForFunction(() => controlReady === false &&
      document.querySelector('#status').textContent.includes('按鍵與滑鼠已釋放'));
    console.log('Remote control opt-in and release acknowledged');
  } else if (!(await page.locator('#control').isDisabled())) {
    throw new Error('Remote control is available without --enable-input');
  }
  await page.locator('#play').click();
  try {
    await page.waitForFunction(() => peer?.connectionState === 'connected',
      null, { timeout: 15000 });
  } catch (error) {
    const browserState = await page.evaluate(() => ({ peer: peer?.connectionState,
      ws: socket?.readyState, candidates: candidates.length }));
    throw new Error(`WebRTC connection timeout; UI=${await page.locator('#status').textContent()}; browser=${JSON.stringify(browserState)}; logs=${output}`, { cause: error });
  }
  console.log('Paired browser and WebRTC connected');
  const sender = auto ? null : spawn(resolve(project, 'out', 'remote_desk.exe'),
    [process.env.BRIDGE_1080 === '1' ? '--network-1080-60-test' : '--network-60-test'],
    { cwd: project, stdio: 'ignore' });
  try {
    await page.waitForFunction(() => {
      const metrics = document.querySelector('#metrics').textContent;
      return /送出 [1-9]\d* 幀/.test(metrics);
    }, null, { timeout: 12000 });
  } catch (error) {
    throw new Error(`No video packets in browser. Server: ${output}; UI: ${await page.locator('#status').textContent()}`, { cause: error });
  } finally { sender?.kill(); }
  const metrics = await page.locator('#metrics').textContent();
  const rendered = await page.evaluate(() => document.querySelector('video').webkitDecodedFrameCount || 0);
  console.log('Receiver metrics:', metrics, 'decoded frames:', rendered);
  console.log(output.match(/H\.264 SPS profile: [^\r\n]+/)?.[0] || 'SPS not logged');
  if (!rendered) throw new Error('WebRTC connected but Chrome did not decode video. ' + output);
  const bottom = await page.evaluate(() => {
    const rect = document.querySelector('#screen').getBoundingClientRect();
    return pointerPosition({ clientX: rect.left + rect.width / 2,
      clientY: rect.bottom - 1 }).y;
  });
  if (bottom !== 1) throw new Error('The bottom edge cannot reach the Windows taskbar');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#exportMetrics').click();
  const download = await downloadPromise;
  const file = await import('node:fs/promises');
  const csv = await file.readFile(await download.path(), 'utf8');
  if (!csv.includes('rendered_fps') || csv.trim().split(/\r?\n/).length < 2) {
    throw new Error('Metrics CSV is missing samples');
  }
  console.log('Metrics CSV exported with samples');
  if (audio) {
    await page.locator('#playAudio').click();
    // Avoid feeding received sound back into the same host's WASAPI capture.
    await page.locator('#sound').evaluate(element => { element.volume = 0; });
    await page.waitForFunction(() => document.querySelector('audio').srcObject?.getAudioTracks().length === 1);
    await page.waitForFunction(async () => {
      const stats = await peer.getStats();
      return [...stats.values()].some(item => item.type === 'inbound-rtp' &&
        item.kind === 'audio' && item.packetsReceived > 0);
    }, null, { timeout: 10000 });
    const audioPackets = await page.evaluate(async () => {
      const stats = await peer.getStats();
      return [...stats.values()].filter(item => item.type === 'inbound-rtp' && item.kind === 'audio')
        .reduce((total, item) => total + item.packetsReceived, 0);
    });
    console.log('Audio RTP packets received:', audioPackets);
    if (!audioPackets) throw new Error('Audio track connected but no RTP audio received. ' + output);
    await page.waitForFunction(() => document.querySelector('#audioStatus').textContent.includes('主機音量'));
  }
  if (soakSeconds) {
    await page.waitForTimeout(3000);
    const initial = await page.evaluate(() => ({
      underruns: audioStats?.underruns, level: audioStats?.levelPercent,
      receiver: { ...receiverMetrics }, lost: clientAudioLost
    }));
    await page.waitForTimeout(soakSeconds * 1000);
    const result = await page.evaluate(() => ({ initial: null, audio: audioStats,
      receiver: receiverMetrics, metrics: document.querySelector('#metrics').textContent,
      samples: metricRows }));
    result.initial = initial;
    const file = await import('node:fs/promises');
    await file.writeFile(resolve(project, 'docs', 'local-av-timing-2026-09-25.json'),
      JSON.stringify(result, null, 2));
    console.log('Sustained local AV:', JSON.stringify({ ...result, samples: result.samples.length }));
    if (audio && !result.audio?.levelPercent) throw new Error('Non-silent host audio capture was not verified');
    if (audio && result.audio.underruns - initial.underruns > 1) {
      throw new Error('Continuous tone suffered repeated source underruns');
    }
    if (!result.receiver.videoFps || Number(result.receiver.videoFps) < 20) {
      throw new Error('Sustained video decoding fell below 20 FPS');
    }
  }
  await context.close();
} finally {
  await browser?.close();
  server.kill();
}
