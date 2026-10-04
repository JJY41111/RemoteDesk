import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { localTailnetIPv4 } from '../tailnet-address.mjs';
import { createServer, createConnection } from 'node:net';
import { HEADER_BYTES, parseHeader, containsH264Keyframe } from '../protocol.mjs';

// Real Windows capture and H.264 through WebRTC, isolated from the user's ports.
const bridge = resolve(fileURLToPath(new URL('..', import.meta.url)));
const project = resolve(bridge, '..');
const mode = ['cpu', 'stable', 'mobile', 'game'].includes(process.env.QUALITY_MODE) ?
  process.env.QUALITY_MODE : 'gpu';
const native = process.env.QUALITY_NATIVE === '1';
const serverLaunch = process.env.QUALITY_SERVER_LAUNCH === '1';
const rateFeedbackTest = process.env.QUALITY_RATE_FEEDBACK === '1';
const recoveryTest = process.env.QUALITY_RECOVERY === '1';
const slowSignal = process.env.QUALITY_SLOW_SIGNAL === '1';
const dynamic = process.env.QUALITY_DYNAMIC === '1';
const receiverControlTest = process.env.QUALITY_RECEIVER_CONTROL === '1';
const requestRecoveryTest = process.env.QUALITY_REQUEST_RECOVERY === '1';
if (recoveryTest && serverLaunch) throw new Error('Recovery fault test uses the manual source');
const tailnet = process.env.QUALITY_TAILNET === '1';
const host = tailnet ? localTailnetIPv4()[0] : '127.0.0.1';
if (!host) throw new Error('No active Tailscale IPv4 for isolated tailnet test');
const duration = Number(process.env.QUALITY_DURATION ?? 12);
if (!Number.isInteger(duration) || duration < 5 || duration > 300) {
  throw new Error('QUALITY_DURATION must be 5–300 seconds');
}
const label = `${native ? 'native' : '1080'}-${mode}${receiverControlTest ? '-receiver-control' : ''}${recoveryTest ? '-recovery' : ''}${slowSignal ? '-slow-signal' : ''}${tailnet ? '-tailnet' : ''}${serverLaunch ? '-server' : ''}${duration === 12 ? '' : `-${duration}s`}`;
const results = resolve(bridge, 'test-results');
await mkdir(results, { recursive: true });
try {
  const previousRuntime = await readFile(resolve(project, 'runtime.log'));
  await writeFile(resolve(results, `runtime-before-quality-${Date.now()}.log`),
    previousRuntime);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const server = spawn(process.execPath,
  ['server.mjs', '--port=8544', '--tcp-port=55444',
    ...(tailnet ? ['--tailnet', `--host=${host}`] : []),
    ...(serverLaunch ? [] : ['--no-launch'])],
  { cwd: bridge, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, capture, motionBrowser;
const samples = [];
let proxy, keyframes = 0, droppedInitialKeyframe = false;
const proxySockets = new Set();
let output = '';
server.stdout.on('data', chunk => { output += String(chunk); });
server.stderr.on('data', chunk => { output += String(chunk); });
try {
  if (dynamic) {
    // Visible, local moving fixture exercises real DXGI capture and encoding.
    // The receiver stays headless so it cannot recursively capture itself.
    motionBrowser = await chromium.launch({ headless: false,
      args: ['--start-maximized'],
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
    const motion = await motionBrowser.newPage({ viewport: null });
    await motion.setContent(`<style>html,body{margin:0;overflow:hidden;background:#102030}
      canvas{width:100vw;height:100vh}</style><canvas></canvas><script>
      const c=document.querySelector('canvas'),x=c.getContext('2d');
      c.width=innerWidth*devicePixelRatio;c.height=innerHeight*devicePixelRatio;
      function draw(t){x.fillStyle='#102030';x.fillRect(0,0,c.width,c.height);
      for(let i=0;i<80;i++){x.fillStyle='hsl('+((i*17+t/30)%360)+',65%,55%)';
      x.fillRect((t*(.12+i*.002)+i*137)%c.width,(i*83)%c.height,130,70)}
      x.fillStyle='white';x.font='32px sans-serif';
      x.fillText('RemoteDesk real capture stress — '+Math.floor(t)+' ms',30,55);
      requestAnimationFrame(draw)}requestAnimationFrame(draw);</script>`);
  }
  if (recoveryTest) {
    proxy = createServer(source => {
      const destination = createConnection({ host: '127.0.0.1', port: 55444 });
      proxySockets.add(source); proxySockets.add(destination);
      let buffer = Buffer.alloc(0), inputSequence = 0, outputSequence = 0;
      source.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= HEADER_BYTES) {
          const meta = parseHeader(buffer.subarray(0, HEADER_BYTES), inputSequence);
          if (buffer.length < HEADER_BYTES + meta.length) break;
          const packet = Buffer.from(buffer.subarray(0, HEADER_BYTES + meta.length));
          buffer = buffer.subarray(packet.length); inputSequence++;
          if (containsH264Keyframe(packet.subarray(HEADER_BYTES))) {
            keyframes++;
            if (!droppedInitialKeyframe) { droppedInitialKeyframe = true; continue; }
          }
          packet.writeUInt32BE(outputSequence++, 8);
          destination.write(packet);
        }
      });
      source.on('end', () => destination.end());
      source.on('error', () => destination.destroy());
      destination.on('error', () => source.destroy());
    });
    await new Promise((resolveListen, reject) => {
      proxy.once('error', reject); proxy.listen(55447, '127.0.0.1', resolveListen);
    });
  }
  const deadline = Date.now() + 12000;
  while (!output.includes('One-time pairing code') && Date.now() < deadline &&
         server.exitCode === null) await new Promise(done => setTimeout(done, 100));
  const code = output.match(/One-time pairing code for this server run: (\d{8})/)?.[1];
  if (!code) throw new Error('Isolated bridge did not start: ' + output);
  browser = await chromium.launch({ headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
  const page = await browser.newPage({ ignoreHTTPSErrors: true,
    viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
  if (slowSignal) await page.addInitScript(() => {
    const original = RTCPeerConnection.prototype.setRemoteDescription;
    RTCPeerConnection.prototype.setRemoteDescription = async function(description) {
      await new Promise(done => setTimeout(done, 700));
      return original.call(this, description);
    };
  });
  await page.goto(`https://${host}:8544`);
  if (native) await page.locator('#videoMode').selectOption('native');
  else if (mode === 'cpu') await page.locator('#videoMode').selectOption('cpu1080');
  else if (mode === 'stable') await page.locator('#videoMode').selectOption('stable1080');
  else if (mode === 'mobile') await page.locator('#videoMode').selectOption('mobile1080');
  else if (mode === 'game') await page.locator('#videoMode').selectOption('game1080');
  await page.locator('#code').fill(code);
  await page.locator('#connect').click();
  await page.waitForFunction(() => peer?.connectionState === 'connected');
  const selectedVideoMode = await page.evaluate(() => activeVideoMode);
  if (selectedVideoMode !== (native ? 'native' : mode === 'cpu' ? 'cpu1080' :
    mode === 'stable' ? 'stable1080' : mode === 'mobile' ? 'mobile1080' :
    mode === 'game' ? 'game1080' : '1080p'))
    throw new Error(`Host did not accept selected video mode: ${selectedVideoMode}`);
  if (serverLaunch) {
    await page.waitForFunction(() => serverStats?.sent > 100);
    if (mode === 'game' || requestRecoveryTest) {
      const before = await page.evaluate(() => serverStats.videoRecoveryRequests);
      await page.evaluate(() => {
        for (let i = 0; i < 20; i++) sendSignal({ type: 'request-video-recovery' });
      });
      await page.waitForFunction(old => serverStats?.videoRecoveryRequests > old, before);
      const after = await page.evaluate(() => serverStats.videoRecoveryRequests);
      if (after !== before + 1) throw new Error('Recovery requests were not coalesced');
    }
    if (rateFeedbackTest) {
      if (!tailnet) throw new Error('Rate feedback test requires isolated tailnet mode');
      await page.waitForFunction(() => receiverMetrics.videoReceived > 1000);
      await page.waitForTimeout(1700);
      await page.evaluate(() => sendSignal({ type: 'network-feedback',
        received: receiverMetrics.videoReceived + 1000,
        lost: Math.max(0, receiverMetrics.videoLost || 0) + 100,
        nacks: (receiverMetrics.videoNacks || 0) + 80 }));
      await page.waitForFunction(() => serverStats?.wanTargetKbps < 8000);
      await page.waitForTimeout(700);
    }
    for (let second = 0; second < duration; second++) {
      if (receiverControlTest && second === 2) {
        await page.locator('#menuToggle').click();
        await page.locator('#lowLatency').check();
        await page.waitForFunction(() => latencyState?.enabled);
        await page.evaluate(() => {
          // Force the policy's high-buffer branch, not actual network delay.
          // Setting and continued playback use a real RTCRtpReceiver.
          receiverMetrics.videoTargetMs = 240;
          receiverMetrics.videoMinimumMs = 0;
          receiverMetrics.rttMs = 0;
          applyReceiverLatency();
          if (peer.getReceivers().find(r => r.track.kind === 'video').jitterBufferTarget !== 80)
            throw new Error('Real receiver did not accept 80 ms');
        });
      }
      if (receiverControlTest && second === 8) {
        await page.locator('#lowLatency').uncheck();
        await page.waitForFunction(() => latencyState?.enabled === false);
        if (!(await page.evaluate(() => peer.getReceivers()
          .filter(r => ['video','audio'].includes(r.track.kind))
          .every(r => r.jitterBufferTarget === null))))
          throw new Error('Real receiver did not restore browser defaults');
      }
      const before = await page.evaluate(() => ({ at: performance.now(), frames: painted }));
      await page.waitForTimeout(1000);
      samples.push(await page.evaluate(({ before, second }) => ({ second,
        renderedFps: (painted - before.frames) * 1000 / (performance.now() - before.at),
        connection: peer.connectionState, source: { ...serverStats },
        receiver: { ...receiverMetrics } }), { before, second }));
      if ((second + 1) % 30 === 0) console.log(JSON.stringify({ elapsed: second + 1,
        renderedFps: samples.at(-1).renderedFps, sentFps: samples.at(-1).source.sentFps }));
    }
    if (samples.slice(5).some(s => s.connection !== 'connected' || s.renderedFps < 10))
      throw new Error('Long stream disconnected or presentation stalled');
  } else {
    capture = spawn(resolve(project, 'out', 'remote_desk.exe'),
      [native ? '--network-native-60-test' :
        mode === 'stable' ? '--network-1080-30-test' : '--network-1080-60-test',
        `--tcp-port=${recoveryTest ? 55447 : 55444}`, `--duration=${duration}`,
        ...(recoveryTest ? ['--recovery-keyframes'] : []),
        ...(mode === 'game' ? ['--adaptive-recovery', '--wan-video'] : []),
        ...(mode === 'cpu' ? ['--cpu-conversion'] : [])],
      { cwd: project, stdio: 'ignore', windowsHide: true });
    const timeout = setTimeout(() => capture?.kill(), (duration + 20) * 1000);
    const [exitCode] = await once(capture, 'exit');
    clearTimeout(timeout);
    if (exitCode !== 0) throw new Error(`Capture exited ${exitCode}: ` +
      await readFile(resolve(project, 'runtime.log'), 'utf8'));
  }
  const result = await page.evaluate(() => ({
    source: serverStats, videoWidth: screen.videoWidth,
    videoHeight: screen.videoHeight,
    decodedFrames: screen.webkitDecodedFrameCount ||
      screen.getVideoPlaybackQuality?.().totalVideoFrames || 0,
    displayed: document.querySelector('#metrics').textContent,
    receiver: receiverMetrics,
    gamepadChannel: { state: gamepadChannel?.readyState,
      ordered: gamepadChannel?.ordered,
      maxRetransmits: gamepadChannel?.maxRetransmits },
    pointerChannel: { state: pointerChannel?.readyState,
      ordered: pointerChannel?.ordered,
      maxRetransmits: pointerChannel?.maxRetransmits }
  }));
  if (result.videoWidth !== (native ? 2560 : 1920) ||
      result.videoHeight !== (native ? 1440 : 1080) ||
      result.decodedFrames < 100 || result.gamepadChannel.state !== 'open' ||
      result.gamepadChannel.ordered !== false ||
      result.gamepadChannel.maxRetransmits !== 0 ||
      (tailnet && (result.pointerChannel.state !== 'open' ||
        result.pointerChannel.ordered !== false ||
        result.pointerChannel.maxRetransmits !== 0)))
    throw new Error('Video or fast gamepad channel failed: ' + JSON.stringify(result));
  const captureLog = await readFile(resolve(project, 'runtime.log'), 'utf8');
  if (requestRecoveryTest && (!captureLog.includes('network recovery: requested keyframe') ||
      !result.source.videoRecoveryRequests))
    throw new Error('Default WAN mode did not forward recovery to the encoder');
  if (rateFeedbackTest && !captureLog.includes('network bitrate: applied 5600 kbps'))
    throw new Error('The capture encoder did not apply feedback: ' + captureLog);
  if (mode === 'game' && ((serverLaunch && !captureLog.includes('network recovery: requested keyframe')) ||
      !result.source.videoMaxFrameBytes || !result.source.videoKeyframes))
    throw new Error('Game recovery did not reach the encoder or telemetry is missing');
  if (recoveryTest && (!droppedInitialKeyframe || keyframes < 5))
    throw new Error(`Recovery keyframes missing: dropped=${droppedInitialKeyframe}, count=${keyframes}`);
  if (serverLaunch && mode === 'cpu' &&
      !captureLog.includes('network live: conversion=CPU'))
    throw new Error('The paired CPU mode did not reach the host capture process');
  if (mode === 'stable' && !captureLog.includes('1920x1080@30'))
    throw new Error('The paired stable mode did not reach the host capture process');
  await page.locator('#screen').screenshot({ path: resolve(results, `quality-${label}.png`) });
  await writeFile(resolve(results, `quality-${label}.json`), JSON.stringify({
    mode, native, tailnet, recoveryTest, receiverControlTest, slowSignal, keyframes, droppedInitialKeyframe,
    at: new Date().toISOString(), dynamic, samples, result,
    captureLog
  }, null, 2));
  console.log(JSON.stringify({ mode, native, recoveryTest, keyframes, result }));
} finally {
  capture?.kill();
  for (const socket of proxySockets) socket.destroy();
  proxy?.close();
  await browser?.close();
  await motionBrowser?.close();
  if (server.exitCode === null) {
    server.kill();
    await once(server, 'exit');
  }
}
