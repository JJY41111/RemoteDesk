import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Real Windows capture and H.264 through WebRTC, isolated from the user's ports.
const bridge = resolve(fileURLToPath(new URL('..', import.meta.url)));
const project = resolve(bridge, '..');
const mode = process.env.QUALITY_MODE === 'cpu' ? 'cpu' : 'gpu';
const native = process.env.QUALITY_NATIVE === '1';
const duration = Number(process.env.QUALITY_DURATION ?? 12);
if (!Number.isInteger(duration) || duration < 5 || duration > 300) {
  throw new Error('QUALITY_DURATION must be 5–300 seconds');
}
const label = `${native ? 'native' : '1080'}-${mode}${duration === 12 ? '' : `-${duration}s`}`;
const server = spawn(process.execPath,
  ['server.mjs', '--port=8544', '--tcp-port=55444', '--no-launch'],
  { cwd: bridge, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, capture;
let output = '';
server.stdout.on('data', chunk => { output += String(chunk); });
server.stderr.on('data', chunk => { output += String(chunk); });
try {
  const deadline = Date.now() + 12000;
  while (!output.includes('One-time pairing code') && Date.now() < deadline &&
         server.exitCode === null) await new Promise(done => setTimeout(done, 100));
  const code = output.match(/One-time pairing code for this server run: (\d{8})/)?.[1];
  if (!code) throw new Error('Isolated bridge did not start: ' + output);
  browser = await chromium.launch({ headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
  const page = await browser.newPage({ ignoreHTTPSErrors: true,
    viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
  await page.goto('https://127.0.0.1:8544');
  if (native) await page.locator('#videoMode').selectOption('native');
  await page.locator('#code').fill(code);
  await page.locator('#connect').click();
  await page.waitForFunction(() => peer?.connectionState === 'connected');
  capture = spawn(resolve(project, 'out', 'remote_desk.exe'),
    [native ? '--network-native-60-test' : '--network-1080-60-test',
      '--tcp-port=55444', `--duration=${duration}`,
      ...(mode === 'cpu' ? ['--cpu-conversion'] : [])],
    { cwd: project, stdio: 'ignore', windowsHide: true });
  const timeout = setTimeout(() => capture?.kill(), (duration + 20) * 1000);
  const [exitCode] = await once(capture, 'exit');
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Capture exited ${exitCode}: ` +
    await readFile(resolve(project, 'runtime.log'), 'utf8'));
  const result = await page.evaluate(() => ({
    source: serverStats, videoWidth: screen.videoWidth,
    videoHeight: screen.videoHeight,
    decodedFrames: screen.webkitDecodedFrameCount ||
      screen.getVideoPlaybackQuality?.().totalVideoFrames || 0,
    displayed: document.querySelector('#metrics').textContent,
    receiver: receiverMetrics
  }));
  if (result.videoWidth !== (native ? 2560 : 1920) ||
      result.videoHeight !== (native ? 1440 : 1080) ||
      result.decodedFrames < 100) throw new Error('Video failed: ' + JSON.stringify(result));
  const results = resolve(bridge, 'test-results');
  await mkdir(results, { recursive: true });
  await page.locator('#screen').screenshot({ path: resolve(results, `quality-${label}.png`) });
  await writeFile(resolve(results, `quality-${label}.json`), JSON.stringify({
    mode, native, at: new Date().toISOString(), result,
    captureLog: await readFile(resolve(project, 'runtime.log'), 'utf8')
  }, null, 2));
  console.log(JSON.stringify({ mode, native, result }));
} finally {
  capture?.kill();
  await browser?.close();
  if (server.exitCode === null) {
    server.kill();
    await once(server, 'exit');
  }
}
