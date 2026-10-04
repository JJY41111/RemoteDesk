import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream, appendFileSync, existsSync, mkdirSync,
  readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createServer as createTcpServer, connect as connectTcp } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import rtc from 'node-datachannel';
import OpusScript from 'opusscript';
import { AudioBuffer } from './audio-buffer.mjs';
import { keyToVk } from './input-map.mjs';
import { ViiperGamepad, validGamepad, acceptsGamepadSequence } from './gamepad.mjs';
import { acceptedSignalOrigin } from './signal-origin.mjs';
import { LatencyControl } from './latency-control.mjs';
import { ensureCertificate, certificateFingerprint } from './setup.mjs';
import { FrameReader, containsH264Keyframe, h264SpsProfile } from './protocol.mjs';
import { isLocalTailnetHost } from './tailnet-address.mjs';
import { ConnectionGrace } from './connection-grace.mjs';
import { WanRateController } from './wan-rate.mjs';
import { handleTransfer } from './transfer.mjs';
import { PairingAdmin } from './pairing-admin.mjs';

const base = dirname(fileURLToPath(import.meta.url));
const project = resolve(base, '..');
const web = join(base, 'web');
const transferFolder = join(dirname(project), 'ipad傳輸');
const transferTemporary = join(base, 'private', 'transfer-temp');
const diagnosticLog = join(base, 'session.log');
function logEvent(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  try { appendFileSync(diagnosticLog, line + '\n'); }
  catch (error) { console.error('Diagnostic log:', error.message); }
}
const args = new Set(process.argv.slice(2));
const hostArg = [...args].find(a => a.startsWith('--host='));
const portArg = [...args].find(a => a.startsWith('--port='));
const tcpPortArg = [...args].find(a => a.startsWith('--tcp-port='));
const host = hostArg ? hostArg.slice(7) : '127.0.0.1';
const tailnet = args.has('--tailnet');
const port = portArg ? Number(portArg.slice(7)) : 8443;
const tcpPort = tcpPortArg ? Number(tcpPortArg.slice(11)) : 5000;
const enableInput = args.has('--enable-input');
const prestartGamepad = args.has('--gamepad=viiper');
if ([...args].some(a => a.startsWith('--gamepad=') && a !== '--gamepad=viiper') ||
    (prestartGamepad && !enableInput)) {
  throw new Error('Use --gamepad=viiper together with --enable-input');
}
const noLaunch = args.has('--no-launch');
const use720 = args.has('--720p');
const cpuConversion = args.has('--cpu-conversion');
const enableAudio = args.has('--audio');
const displayArg = [...args].find(a => a.startsWith('--display=')) || '--display=0:0';
if (!/^--display=[0-9]:[0-9]$/.test(displayArg)) {
  throw new Error('Use --display=adapter:output, e.g. --display=0:0');
}
if (!(tailnet ? isLocalTailnetHost(host) :
      /^(127\.0\.0\.1|10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/.test(host)) ||
    !Number.isInteger(port) || port < 1024 || port > 65535 ||
    !Number.isInteger(tcpPort) || tcpPort < 1024 || tcpPort > 65535 || tcpPort === port) {
  throw new Error(tailnet ?
    'Use --tailnet --host=<this PC active Tailscale IPv4> and optional --port=1024..65535' :
    'Use --host=<this PC private IPv4> and optional --port=1024..65535');
}

const certificate = await ensureCertificate(host);
const tls = {
  cert: await readFile(certificate.certPath),
  key: await readFile(certificate.keyPath)
};
const pairing = await new PairingAdmin({ directory: join(base, 'private'),
  mode: tailnet ? 'wan' : 'lan', port, host }).init();
const prefix = 'https://' + host + ':' + port;
const caPort = port - 1;
const safeEqual = (a, b) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const json = (ws, message) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
};
const pages = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/icons/remotedesk-180.png', ['icons/remotedesk-180.png', 'image/png']],
  ['/icons/remotedesk-192.png', ['icons/remotedesk-192.png', 'image/png']],
  ['/icons/remotedesk-512.png', ['icons/remotedesk-512.png', 'image/png']]
]);
const https = createHttpsServer(tls, (req, res) => {
  if (req.url.startsWith('/api/launcher/pairing')) {
    void pairing.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
    return;
  }
  if (req.url === '/ca.crt' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert',
      'content-disposition': 'attachment; filename="RemoteDesk-Local-CA.crt"',
      'cache-control': 'no-store' });
    createReadStream(fileURLToPath(certificate.caPath)).pipe(res);
    return;
  }
  if (new URL(req.url, prefix).pathname.startsWith('/api/')) {
    void handleTransfer(req, res, { current: session, origin: prefix,
      folder: transferFolder, privateFolder: transferTemporary,
      clipboardScript: join(base, 'clipboard.ps1') }).then(handled => {
      if (!handled) { res.writeHead(404); res.end(); }
    }).catch(error => {
      logEvent(`Transfer request failed: ${error.message}`);
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    });
    return;
  }
  const page = pages.get(new URL(req.url, prefix).pathname);
  if (!page || req.method !== 'GET') {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, {
    'content-type': page[1], 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'content-security-policy':
      "default-src 'self'; connect-src 'self' wss:; script-src 'self'; style-src 'self'; media-src 'self' blob:; img-src 'self'; frame-ancestors 'none'"
  });
  createReadStream(join(web, page[0])).pipe(res);
});
const caDownload = createHttpServer((req, res) => {
  if (req.url !== '/ca.crt' || req.method !== 'GET') {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert',
    'content-disposition': 'attachment; filename="RemoteDesk-Local-CA.crt"',
    'cache-control': 'no-store' });
  createReadStream(fileURLToPath(certificate.caPath)).pipe(res);
});
const websocket = new WebSocketServer({ noServer: true, maxPayload: 65536 });
let session = null;
let attempts = 0;
let blockUntil = 0;
let videoSocket = null;
let sender = null;
let inputHelper = null;
let audioHelper = null;
let managedViiper = null;

function viiperListening() {
  return new Promise(resolveResult => {
    const socket = connectTcp({ host: '127.0.0.1', port: 3242 });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolveResult(true); });
    socket.once('error', () => resolveResult(false));
    socket.once('timeout', () => { socket.destroy(); resolveResult(false); });
  });
}

let viiperReadyPromise = null;
async function ensureViiper() {
  if (!viiperReadyPromise) viiperReadyPromise = startViiperIfNeeded();
  try { return await viiperReadyPromise; }
  finally { viiperReadyPromise = null; }
}

async function startViiperIfNeeded() {
  if (await viiperListening()) return;
  const executable = join(base, 'private', 'viiper', 'viiper.exe');
  if (!existsSync(executable)) {
    throw new Error('找不到 VIIPER，請先在主機安裝手把連接器');
  }
  managedViiper = spawn(executable, ['server', '--usb.addr=127.0.0.1:3241',
    '--api.addr=127.0.0.1:3242', '--api.auto-attach-windows-native'],
  { cwd: dirname(executable), stdio: 'ignore', windowsHide: true });
  managedViiper.on('error', error => logEvent(`VIIPER start failed: ${error.message}`));
  managedViiper.on('exit', code => {
    logEvent(`VIIPER stopped (${code})`);
    managedViiper = null;
  });
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await viiperListening()) { logEvent('VIIPER backend ready on localhost'); return; }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error('VIIPER 未能在主機啟動');
}

function disposeSession(reason = 'disconnected', old = session) {
  if (!old || old.closed || session !== old) return;
  old.closed = true;
  old.transferToken = null;
  session = null;
  try { old.dc?.close(); } catch {}
  try { old.gamepadDc?.close(); } catch {}
  try { old.peer?.close(); } catch {}
  clearInterval(old.poll);
  clearInterval(old.videoWatchdog);
  clearInterval(old.videoStatsTimer);
  void old.gamepad?.close().then(() => logEvent('Virtual Xbox removed on session disconnect'))
    .catch(error => logEvent(`Virtual Xbox removal failed: ${error.message}`));
  old.gamepad = null;
  try { old.ws.close(1000, reason); } catch {}
  videoSocket?.destroy();
  videoSocket = null;
  // A sender may still be waiting for its first frame or TCP connection.
  sender?.kill();
  sender = null;
  if (inputHelper) {
    inputHelper.stdin.end();
    inputHelper = null;
  }
  clearTimeout(old.inputReadyTimer);
  clearTimeout(old.inputRestartTimer);
  clearInterval(old.audioTimer);
  clearTimeout(old.audioRestartTimer);
  old.opus?.delete();
  if (audioHelper) { audioHelper.kill(); audioHelper = null; }
  logEvent(`Receiver disconnected: ${reason}; sent=${old.sent}; dropped=${old.dropped}; ` +
    `last_source_frame_age_ms=${old.lastVideoFrameAt ? Date.now() - old.lastVideoFrameAt : 'none'}; ` +
    `audio_level_percent=${old.audioLevelPercent ?? 'unknown'}; audio_underruns=${old.audioUnderruns ?? 'unknown'}`);
}

const tcp = createTcpServer({ allowHalfOpen: false }, socket => {
  if (!session || videoSocket) { socket.destroy(); return; }
  const sessionForSocket = session;
  videoSocket = socket;
  socket.setNoDelay(true);
  const reader = new FrameReader((frame, data) => {
    const current = sessionForSocket;
    if (session !== current || !current.track?.isOpen()) return;
    current.lastVideoFrameAt = Date.now();
    const keyframe = containsH264Keyframe(data);
    current.videoMaxFrameBytes = Math.max(current.videoMaxFrameBytes || 0, data.length);
    if (keyframe) current.videoKeyframes = (current.videoKeyframes || 0) + 1;
    if (frame.sourceEventQpc !== 0n &&
        frame.sourceEventQpc !== current.lastSourceEventQpc) {
      current.lastSourceEventQpc = frame.sourceEventQpc;
      current.lastSourceUpdateAt = Date.now();
      current.sourceUpdates = (current.sourceUpdates || 0) + 1;
    }
    if (!current.sentKeyframe) {
      if (!keyframe) return;
      console.log('H.264 SPS profile:', h264SpsProfile(data) || 'missing');
    }
    // Media Foundation timestamps are in 100ns units; RTP video uses 90kHz.
    current.rtp.timestamp = Number((frame.sampleTime * 90000n / 10000000n) & 0xffffffffn);
    const sendStarted = performance.now();
    const sent = current.track.sendMessageBinary(data);
    current.videoSendMaxMs = Math.max(current.videoSendMaxMs || 0,
      performance.now() - sendStarted);
    if (!sent) {
      current.dropped++;
      if (tailnet) current.sentKeyframe = false;
    } else {
      current.sent++;
      current.videoInputBytes = (current.videoInputBytes || 0) + data.length;
      current.sentKeyframe = true;
    }
    current.lastFrameInfo = { width: frame.width, height: frame.height, fps: frame.fps };
  });
  socket.on('data', chunk => {
    try { reader.push(chunk); } catch (error) { disposeSession(error.message, sessionForSocket); }
  });
  socket.on('close', () => {
    if (videoSocket === socket) videoSocket = null;
    if (session === sessionForSocket && !noLaunch) {
      logEvent('Local H.264 TCP source closed');
      disposeSession('video source disconnected', sessionForSocket);
    }
  });
  socket.on('error', error => { console.error('Video socket:', error.message); });
});

function handleControl(current, payload, channel = 'control') {
  if (!enableInput || current !== session || !current.authorized ||
      !current.controlEnabled) return;
  let value;
  try { value = JSON.parse(String(payload)); } catch { return; }
  if (channel === 'gamepad' && value.type !== 'gamepad') return;
  if (channel === 'pointer' && value.type !== 'move') return;
  if (value.type === 'gamepad') {
    if (!current.gamepadEnabled || !validGamepad(value)) return;
    // The fast channel is unordered, and the reliable release may arrive later.
    // Never let an older sample replace a newer button or stick position.
    if (!acceptsGamepadSequence(value, current.lastGamepadSeq)) return;
    if (value.seq !== undefined) current.lastGamepadSeq = value.seq;
    const forwarded = current.gamepad?.send(value);
    // Diagnostic echo on the same fast path; a queued host write is not proof
    // that the game has processed the input. Limit echoes to ten per second.
    const now = performance.now();
    if (forwarded && channel === 'gamepad' && Number.isFinite(value.clientAt) &&
        (!current.lastGamepadAckAt || now - current.lastGamepadAckAt >= 100) &&
        current.gamepadDc?.isOpen()) {
      current.lastGamepadAckAt = now;
      try { current.gamepadDc.sendMessage(JSON.stringify({ type: 'gamepad-ack',
        seq: value.seq, clientAt: value.clientAt })); } catch { /* Diagnostics must not interrupt input. */ }
    }
    return;
  }
  if (!current.inputReady || !inputHelper?.stdin.writable) return;
  if (value.type === 'move-relative' && current.mouseMode === 'relative' &&
      Number.isSafeInteger(value.dx) && Number.isSafeInteger(value.dy) &&
      Math.abs(value.dx) <= 2048 && Math.abs(value.dy) <= 2048) {
    // Relative deltas use the ordered control transport, not the lossy position channel.
    if (inputHelper.stdin.writableLength > 8192) return;
    inputHelper.stdin.write(`D ${value.dx} ${value.dy}\n`);
  } else if (value.type === 'move' && current.mouseMode !== 'relative' &&
      Number.isFinite(value.x) && Number.isFinite(value.y)) {
    if (tailnet && current.pointerDc &&
        (!Number.isSafeInteger(value.seq) || value.seq <= current.lastPointerSeq)) return;
    if (tailnet && current.pointerDc) current.lastPointerSeq = value.seq;
    if (inputHelper.stdin.writableLength > 64 * 1024) return;
    const x = Math.round(Math.max(0, Math.min(1, value.x)) * 65535);
    const y = Math.round(Math.max(0, Math.min(1, value.y)) * 65535);
    inputHelper.stdin.write(`M ${x} ${y}\n`);
  } else if (value.type === 'button' && [0, 1, 2].includes(value.button) &&
             typeof value.down === 'boolean') {
    inputHelper.stdin.write(`B ${value.button} ${value.down ? 1 : 0}\n`);
  } else if (value.type === 'wheel' && (value.delta === -120 || value.delta === 120)) {
    inputHelper.stdin.write(`W ${value.delta}\n`);
  } else if (value.type === 'key' && typeof value.code === 'string' &&
             typeof value.down === 'boolean') {
    const vk = keyToVk(value.code);
    if (vk) inputHelper.stdin.write(`K ${vk} ${value.down ? 1 : 0}\n`);
    json(current.ws, { type: 'input-ack', code: value.code,
      down: value.down, accepted: Boolean(vk) });
  } else if (value.type === 'text' && typeof value.text === 'string' &&
             value.text.length <= 32 && !/[\r\n\0]/.test(value.text)) {
    for (const char of value.text) inputHelper.stdin.write(`T ${char.codePointAt(0)}\n`);
  }
}

function startInputHelper(current) {
  if (!enableInput || session !== current || current.closed || inputHelper) return;
  const helper = spawn(join(project, 'out', 'remote_desk_input.exe'), [displayArg],
    { cwd: project, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  inputHelper = helper;
  current.inputReady = false;
  let readyText = '';
  helper.stdout.on('data', chunk => {
    if (session !== current || inputHelper !== helper) return;
    readyText += String(chunk);
    if (!/READY\r?\n/.test(readyText)) return;
    current.inputReady = true;
    current.inputRestarts = 0;
    clearTimeout(current.inputReadyTimer);
    logEvent('Remote input helper ready');
    if (current.controlRequested) {
      current.controlEnabled = true;
      json(current.ws, { type: 'control-state', enabled: true });
      logEvent('Remote control enabled');
    }
  });
  helper.stderr.on('data', chunk => console.error('Input helper:', String(chunk).trim()));
  helper.on('error', error => {
    if (session === current && inputHelper === helper)
      json(current.ws, { type: 'error', text: `Input: ${error.message}` });
  });
  helper.on('exit', code => {
    if (session !== current || inputHelper !== helper) return;
    inputHelper = null;
    current.inputReady = false;
    current.controlEnabled = false;
    clearTimeout(current.inputReadyTimer);
    json(current.ws, { type: 'control-state', enabled: false,
      text: `Windows 輸入程式已停止 (${code})` });
    logEvent(`Remote input helper stopped (${code})`);
    if (current.controlRequested && (current.inputRestarts || 0) < 3) {
      current.inputRestarts = (current.inputRestarts || 0) + 1;
      current.inputRestartTimer = setTimeout(() => startInputHelper(current), 500);
    }
  });
  current.inputReadyTimer = setTimeout(() => {
    if (session === current && inputHelper === helper && !current.inputReady) {
      logEvent('Remote input helper readiness timeout');
      helper.kill();
    }
  }, 3000);
}

async function setGamepad(current, enabled) {
  const generation = ++current.gamepadGeneration;
  current.gamepadRequested = enabled;
  if (!enabled) {
    current.gamepadEnabled = false;
    const old = current.gamepad;
    current.gamepad = null;
    try { await old?.close(); }
    catch (error) {
      logEvent(`Virtual Xbox removal failed: ${error.message}`);
      json(current.ws, { type: 'gamepad-status', text: `虛擬手把移除失敗：${error.message}` });
      return;
    }
    if (generation === current.gamepadGeneration && current === session && !current.closed) {
      json(current.ws, { type: 'gamepad-state', enabled: false,
        text: '虛擬手把已停用' });
    }
    return;
  }
  if (current.gamepadEnabled || current.gamepad) return;
  json(current.ws, { type: 'gamepad-status', text: '正在啟動 VIIPER 並建立虛擬手把…' });
  try {
    await ensureViiper();
    if (generation !== current.gamepadGeneration || current !== session ||
        current.closed || !current.controlEnabled ||
        !current.gamepadRequested) return;
    const gamepad = new ViiperGamepad({ onOffline: () => {
      if (current === session && current.gamepad === gamepad)
        void setGamepad(current, false);
    }, onStatus: text => {
      if (current === session && current.gamepad === gamepad)
        json(current.ws, { type: 'gamepad-status', text });
    } });
    current.gamepad = gamepad;
    await gamepad.open();
    if (generation !== current.gamepadGeneration || current !== session ||
        current.closed || !current.controlEnabled ||
        !current.gamepadRequested) {
      await gamepad.close();
      return;
    }
    current.gamepadEnabled = true;
    json(current.ws, { type: 'gamepad-state', enabled: true,
      text: 'VIIPER 資料流已連線；請在 Windows 確認虛擬手把' });
    logEvent('Virtual Xbox gamepad enabled');
  } catch (error) {
    if (generation !== current.gamepadGeneration) return;
    const old = current.gamepad;
    current.gamepad = null;
    current.gamepadEnabled = false;
    current.gamepadRequested = false;
    await old?.close().catch(cleanupError => logEvent(`Virtual Xbox removal failed: ${cleanupError.message}`));
    if (current === session && !current.closed) {
      json(current.ws, { type: 'gamepad-state', enabled: false,
        text: `無法啟用 Windows 虛擬手把：${error.message}` });
    }
    logEvent(`Virtual Xbox gamepad failed: ${error.message}`);
  }
}

function launchSender(current) {
  if (session !== current || current.senderStarted) return;
  current.senderStarted = true;
  if (noLaunch) {
    json(current.ws, { type: 'status', text: 'Connected; waiting for test video source' });
  } else {
    const exe = join(project, 'out', 'remote_desk.exe');
    sender = spawn(exe, [current.nativeVideo ? '--network-native-60-live' :
      current.stableVideo ? '--network-1080-30-live' :
      use720 ? '--network-60-live' : '--network-1080-60-live',
      displayArg, `--tcp-port=${tcpPort}`,
      ...(tailnet ? ['--recovery-keyframes'] : []),
      ...(current.recoveryEnabled ? ['--adaptive-recovery'] : []),
      ...(current.mobileVideo ? ['--wan-video-mobile'] :
        tailnet && !current.nativeVideo ? ['--wan-video'] : []),
      ...(cpuConversion || current.cpuVideo ? ['--cpu-conversion'] : [])],
      { cwd: project, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: false });
    sender.stdin.on('error', error =>
      logEvent(`Capture bitrate control pipe: ${error.message}`));
    sender.on('error', error => { json(current.ws, { type: 'error', text: `Sender: ${error.message}` }); });
    sender.on('exit', code => {
      try {
        const archive = join(base, 'test-results');
        mkdirSync(archive, { recursive: true });
        const mode = current.adaptiveRecovery ? 'game1080' : current.nativeVideo ? 'native' : current.stableVideo ? 'stable1080' :
          current.mobileVideo ? 'mobile1080' :
          current.cpuVideo ? 'cpu1080' : 'gpu1080';
        const name = `session-${current.startedAt}-${mode}.log`;
        writeFileSync(join(archive, name), readFileSync(join(project, 'runtime.log')));
        logEvent(`Capture performance saved: ${join(archive, name)}`);
      } catch (error) {
        logEvent(`Capture performance archive failed: ${error.message}`);
      }
      logEvent(`Capture process exited: ${code}`);
      if (session === current) disposeSession(`capture stopped (${code})`, current);
    });
    json(current.ws, { type: 'status', text: 'Connected; starting Windows capture' });
  }
  if (enableInput) {
    startInputHelper(current);
  }
  if (enableAudio && current.audioTrack) {
    const pcm = new AudioBuffer();
    json(current.ws, current.latency.attachAudioBuffer(pcm));
    let audioPacketsSent = 0;
    let audioLevelPeak = 0;
    let audioStatTicks = 0;
    let lastAudioTick = 0;
    let nextAudioAt = 0;
    let pauseStartedAt = null;
    let lateAudioTicks = 0;
    let maxAudioIntervalMs = 0;
    current.opus = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
    let retryDelayMs = 1000;
    let recovered = false;
    const startAudioCapture = () => {
      if (session !== current || current.closed) return;
      pcm.resetSource();
      const helper = spawn(join(project, 'out', 'remote_desk_audio.exe'), [],
        { cwd: project, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      audioHelper = helper;
      helper.stdout.on('data', chunk => {
        if (session !== current) return;
        pcm.push(chunk);
        if (!recovered) {
          recovered = true;
          retryDelayMs = 1000;
          json(current.ws, { type: 'audio-ready' });
          logEvent('Audio capture receiving PCM from default output');
        }
      });
      helper.stderr.on('data', chunk => {
        const detail = String(chunk).trim();
        logEvent(`Audio helper: ${detail}`);
        json(current.ws, { type: 'audio-error', text: detail });
      });
      helper.on('error', error => logEvent(`Audio helper launch: ${error.message}`));
      helper.on('close', code => {
        if (audioHelper === helper) audioHelper = null;
        if (session !== current || current.closed) return;
        pcm.resetSource();
        recovered = false;
        const delay = retryDelayMs;
        retryDelayMs = Math.min(retryDelayMs * 2, 30000);
        logEvent(`Audio helper stopped: ${code}; retry in ${delay} ms`);
        json(current.ws, { type: 'audio-error',
          text: `主機播放裝置已切換；${delay / 1000} 秒後重新擷取` });
        current.audioRestartTimer = setTimeout(startAudioCapture, delay);
      });
    };
    startAudioCapture();
    const sendAudioFrame = () => {
      const audioNow = performance.now();
      if (lastAudioTick) {
        const intervalMs = audioNow - lastAudioTick;
        if (intervalMs > 30) lateAudioTicks++;
        maxAudioIntervalMs = Math.max(maxAudioIntervalMs, intervalMs);
      }
      lastAudioTick = audioNow;
      const sample = pcm.take();
      let squareSum = 0;
      for (let i = 0; i < sample.length; i += 2) {
        const value = sample.readInt16LE(i);
        squareSum += value * value;
      }
      audioLevelPeak = Math.max(audioLevelPeak,
        Math.sqrt(squareSum / (sample.length / 2)) / 32768);
      try {
        const opus = current.opus.encode(sample, 960);
        const packet = Buffer.allocUnsafe(12 + opus.length);
        packet[0] = 0x80;
        packet[1] = 111;
        packet.writeUInt16BE(current.audioSequence++ & 0xffff, 2);
        packet.writeUInt32BE(current.audioTimestamp >>> 0, 4);
        packet.writeUInt32BE(current.audioSsrc, 8);
        Buffer.from(opus).copy(packet, 12);
        current.audioRtp.timestamp = current.audioTimestamp;
        current.audioTimestamp = (current.audioTimestamp + 960) >>> 0;
        if (current.audioTrack.sendMessageBinary(packet)) audioPacketsSent++;
      } catch (error) { console.error('Audio send:', error.message); }
      if (++audioStatTicks >= 50) {
        json(current.ws, { type: 'audio-stats', levelPercent: Math.round(audioLevelPeak * 100),
          packetsSent: audioPacketsSent, underruns: pcm.underruns,
          bufferedMs: Math.round(pcm.bufferedMs), droppedSamples: pcm.droppedSamples,
          lateTicks: lateAudioTicks, maxIntervalMs: Math.round(maxAudioIntervalMs) });
        current.audioLevelPercent = Math.round(audioLevelPeak * 100);
        current.audioUnderruns = pcm.underruns;
        audioStatTicks = 0;
        audioLevelPeak = 0;
      }
    };
    current.audioTimer = setInterval(() => {
      if (!current.audioTrack?.isOpen()) return;
      const now = performance.now();
      if (!current.audioSending) {
        if (pauseStartedAt === null) pauseStartedAt = now;
        pcm.resetSource();
        nextAudioAt = 0;
        return;
      }
      if (pauseStartedAt !== null) {
        // Keep the RTP media clock advancing while transmission is paused.
        current.audioTimestamp = (current.audioTimestamp +
          Math.floor((now - pauseStartedAt) / 20) * 960) >>> 0;
        pauseStartedAt = null;
      }
      if (!nextAudioAt) nextAudioAt = now;
      if (now - nextAudioAt > 100) {
        const skipped = Math.floor((now - nextAudioAt) / 20);
        current.audioTimestamp = (current.audioTimestamp + skipped * 960) >>> 0;
        nextAudioAt = now;
        pcm.trim();
      }
      for (let sentThisTick = 0; sentThisTick < 3 && now >= nextAudioAt; sentThisTick++) {
        sendAudioFrame();
        nextAudioAt += 20;
      }
    }, 5);
  }
}

function startPeer(current) {
  console.log('WebRTC: preparing peer');
  const peer = new rtc.PeerConnection('RemoteDesk', {
    iceServers: [], ...(tailnet ? { bindAddress: host } : {})
  });
  current.peer = peer;
  const media = new rtc.Video('video', 'sendonly');
  media.addH264Codec(96, current.nativeVideo ? '42c033' : '42c02a');
  const ssrc = randomBytes(4).readUInt32BE();
  const videoIdentity = current.syncMode === 'interactive' ? 'RemoteDesk-video' : 'RemoteDesk';
  const videoStream = current.syncMode === 'interactive' ? 'desktop-video' : 'desktop';
  media.addSSRC(ssrc, videoIdentity, videoStream, 'video');
  const track = peer.addTrack(media);
  console.log('WebRTC: video track added');
  current.track = track;
  const rtp = new rtc.RtpPacketizationConfig(ssrc, videoIdentity, 96, 90000);
  // Tailscale exposes a 1280-byte interface MTU. Leave space for the media
  // headers and tunnel encapsulation so a video fragment stays in one packet.
  const packetizer = tailnet ? new rtc.H264RtpPacketizer('StartSequence', rtp, 1100) :
    new rtc.H264RtpPacketizer('StartSequence', rtp);
  const sr = new rtc.RtcpSrReporter(rtp);
  // At 60 fps the default 512-packet NACK history can expire during a burst.
  const nack = tailnet ? new rtc.RtcpNackResponder(2048) :
    new rtc.RtcpNackResponder();
  packetizer.addToChain(sr);
  sr.addToChain(nack);
  track.setMediaHandler(packetizer);
  console.log('WebRTC: media handler configured');
  current.rtp = rtp;
  current.latency = new LatencyControl(rtp);
  json(current.ws, current.latency.state());
  if (enableAudio) {
    const sound = new rtc.Audio('audio', 'sendonly');
    sound.addOpusCodec(111);
    current.audioSsrc = randomBytes(4).readUInt32BE();
    current.audioSequence = randomBytes(2).readUInt16BE();
    current.audioTimestamp = randomBytes(4).readUInt32BE();
    const audioIdentity = current.syncMode === 'interactive' ? 'RemoteDesk-audio' : 'RemoteDesk';
    const audioStream = current.syncMode === 'interactive' ? 'desktop-audio' : 'desktop';
    sound.addSSRC(current.audioSsrc, audioIdentity, audioStream, 'audio');
    current.audioTrack = peer.addTrack(sound);
    current.audioRtp = new rtc.RtpPacketizationConfig(current.audioSsrc, audioIdentity, 111, 48000);
    current.audioTrack.setMediaHandler(new rtc.RtcpSrReporter(current.audioRtp));
  }
  current.dc = peer.createDataChannel('control');
  current.gamepadDc = peer.createDataChannel('gamepad',
    { unordered: true, maxRetransmits: 0 });
  if (tailnet) current.pointerDc = peer.createDataChannel('pointer',
    { unordered: true, maxRetransmits: 0 });
  console.log('WebRTC: data channel created');
  current.dc.onMessage(message => handleControl(current, message));
  current.gamepadDc.onMessage(message => handleControl(current, message, 'gamepad'));
  current.gamepadDc.onClosed(() => {
    if (session === current && !current.closed && (current.gamepad || current.gamepadRequested))
      void setGamepad(current, false);
  });
  current.pointerDc?.onMessage(message => handleControl(current, message, 'pointer'));
  const sendOffer = (sdp, type) => {
    if (current.offerSent || !sdp) return;
    current.offerSent = true;
    json(current.ws, { type: 'description', sdp, descriptionType: type });
  };
  peer.onLocalDescription(sendOffer);
  peer.onLocalCandidate((candidate, mid) => json(current.ws, { type: 'candidate', candidate, mid }));
  peer.onSignalingStateChange(state => console.log('WebRTC signaling:', state));
  peer.onIceStateChange(state => console.log('WebRTC ICE:', state));
  peer.onGatheringStateChange(state => console.log('WebRTC gathering:', state));
  const connectionGrace = new ConnectionGrace();
  const checkPeerState = state => {
    if (current.closed || session !== current) return;
    if (state === 'connected') launchSender(current);
    // Keep video reconnection grace, but never leave a controller attached offline.
    if (['disconnected', 'failed', 'closed'].includes(state) &&
        (current.gamepad || current.gamepadRequested)) {
      void setGamepad(current, false);
      logEvent(`Virtual Xbox disabled on WebRTC ${state}`);
    }
    if (connectionGrace.update(state, performance.now()))
      disposeSession(`WebRTC ${state} (recovery expired or terminal state)`, current);
  };
  peer.onStateChange(state => {
    json(current.ws, { type: 'status', text: `WebRTC: ${state}` });
    checkPeerState(state);
  });
  peer.setLocalDescription('offer');
  console.log('WebRTC: requested local offer');
  current.poll = setInterval(() => {
    if (current.closed) return;
    const description = peer.localDescription();
    if (description?.sdp?.includes('a=end-of-candidates')) sendOffer(description.sdp, description.type);
    const state = peer.state();
    checkPeerState(state);
  }, 200);
  current.videoWatchdog = setInterval(() => {
    if (session === current && current.lastVideoFrameAt &&
        Date.now() - current.lastVideoFrameAt > 5000) {
      logEvent('No local H.264 source frame for 5 seconds');
      disposeSession('video stalled for 5 seconds', current);
    }
  }, 1000);
  let lastStatsAt = performance.now();
  let lastSent = 0;
  let lastSourceUpdates = 0;
  let lastVideoInputBytes = 0;
  current.videoStatsTimer = setInterval(() => {
    if (session !== current || !current.lastFrameInfo) return;
    const now = performance.now();
    const elapsed = now - lastStatsAt;
    json(current.ws, { type: 'stats', sent: current.sent, dropped: current.dropped,
      ...current.lastFrameInfo,
      videoSendMaxMs: Math.round((current.videoSendMaxMs || 0) * 10) / 10,
      videoMaxFrameBytes: current.videoMaxFrameBytes || 0,
      videoKeyframes: current.videoKeyframes || 0,
      videoRecoveryRequests: current.videoRecoveryRequests || 0,
      videoInputKbps: elapsed > 0 ? Math.round(((current.videoInputBytes || 0) -
        lastVideoInputBytes) * 8 / elapsed) : 0,
      wanTargetKbps: current.rateControl?.targetKbps ?? null,
      wanLossPercent: current.rateControl?.lastLossPercent ?? null,
      sentFps: elapsed > 0 ? Math.round((current.sent - lastSent) * 10000 / elapsed) / 10 : 0,
      sourceAgeMs: current.lastVideoFrameAt ? Date.now() - current.lastVideoFrameAt : null,
      captureFps: elapsed > 0 ? Math.round(((current.sourceUpdates || 0) - lastSourceUpdates) * 10000 / elapsed) / 10 : 0,
      captureAgeMs: current.lastSourceUpdateAt ? Date.now() - current.lastSourceUpdateAt : null });
    lastStatsAt = now;
    lastSent = current.sent;
    lastSourceUpdates = current.sourceUpdates || 0;
    lastVideoInputBytes = current.videoInputBytes || 0;
    current.videoSendMaxMs = 0;
    current.videoMaxFrameBytes = 0;
  }, 1000);
}

https.on('upgrade', (req, socket, head) => {
  if (req.url !== '/signal' ||
      !acceptedSignalOrigin(req.headers.origin, req.headers['x-remotedesk-client'], prefix) ||
      session) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
  }
  websocket.handleUpgrade(req, socket, head, ws => websocket.emit('connection', ws, req));
});
websocket.on('connection', (ws, req) => {
  const current = { ws, authorized: false, controlEnabled: false, sent: 0, dropped: 0,
    sentKeyframe: false, senderStarted: false, closed: false,
    controlRequested: false, inputReady: false,
    gamepadRequested: false, gamepadEnabled: false, gamepadGeneration: 0,
    lastGamepadSeq: -1, lastPointerSeq: -1 };
  session = current;
  const loginTimeout = setTimeout(() => disposeSession('pairing timeout', current), 30000);
  ws.on('message', payload => {
    if (session !== current || current.closed) return;
    let message;
    try { message = JSON.parse(String(payload)); } catch { disposeSession('invalid message', current); return; }
    if (!current.authorized) {
      if (message.type !== 'pair' || typeof message.code !== 'string') { disposeSession('pairing required', current); return; }
      if (Date.now() < blockUntil) { disposeSession('pairing temporarily blocked', current); return; }
      if (!safeEqual(message.code, pairing.code)) {
        attempts++;
        if (attempts >= 5) { blockUntil = Date.now() + 60_000; attempts = 0; }
        disposeSession('wrong pairing code', current); return;
      }
      clearTimeout(loginTimeout);
      attempts = 0;
      current.authorized = true;
      current.transferToken = randomBytes(32).toString('hex');
      current.startedAt = new Date().toISOString().replace(/[:.]/g, '-');
      current.syncMode = message.syncMode === 'av-sync' ? 'av-sync' : 'interactive';
      current.nativeVideo = message.videoMode === 'native';
      current.cpuVideo = message.videoMode === 'cpu1080';
      current.stableVideo = message.videoMode === 'stable1080';
      current.mobileVideo = message.videoMode === 'mobile1080';
      current.adaptiveRecovery = tailnet && message.videoMode === 'game1080';
      logEvent(`Receiver version: ${typeof message.clientVersion === 'string' &&
        /^\d{4}-\d{2}-\d{2}\.\d{1,3}$/.test(message.clientVersion) ? message.clientVersion : 'legacy/unreported'}; host: 2026-10-04.5`);
      current.recoveryEnabled = tailnet;
      current.rateControl = tailnet && !current.nativeVideo &&
        !current.stableVideo && !current.cpuVideo ?
        new WanRateController(current.mobileVideo ? 5000 : 8000) : null;
      current.audioSending = message.audioOnDemand !== true;
      logEvent(`Playback mode: ${current.syncMode}; audio_on_demand=${message.audioOnDemand === true}`);
      logEvent(req?.headers?.['x-remotedesk-client'] === 'ipad-native-v1' ?
        'iPad native app paired' : 'iPad browser paired');
      json(ws, { type: 'paired', hostVersion: '2026-10-04.5',
        inputEnabled: enableInput, audioEnabled: enableAudio,
        gamepadEnabled: enableInput, videoRecovery: current.recoveryEnabled,
        latencyControl: true, latencyControlVersion: 4,
        transferToken: current.transferToken,
        syncMode: current.syncMode, audioOnDemand: message.audioOnDemand === true,
        pointerFast: tailnet,
        videoMode: current.adaptiveRecovery ? 'game1080' : current.nativeVideo ? 'native' : current.stableVideo ? 'stable1080' :
          current.mobileVideo ? 'mobile1080' :
          current.cpuVideo ? 'cpu1080' : '1080p' });
      try { startPeer(current); }
      catch (error) { console.error('WebRTC setup:', error); disposeSession('WebRTC setup failed', current); }
      return;
    }
    try {
      if (message.type === 'request-video-recovery' && current.recoveryEnabled &&
          current.senderStarted && sender?.stdin.writable) {
        const now = performance.now();
        // Coalesce requests so a stalled receiver cannot create a keyframe storm.
        if (!current.lastRecoveryRequestAt || now - current.lastRecoveryRequestAt >= 1000) {
          current.lastRecoveryRequestAt = now;
          current.videoRecoveryRequests = (current.videoRecoveryRequests || 0) + 1;
          sender.stdin.write('KEYFRAME\n');
          logEvent('Game video recovery keyframe requested');
        }
      }
      if (message.type === 'set-audio-playback' && typeof message.enabled === 'boolean') {
        current.audioSending = message.enabled;
      }
      if (message.type === 'network-feedback' && current.rateControl &&
          current.senderStarted && sender?.stdin.writable) {
        const now = performance.now();
        if (!current.lastWanFeedbackAt || now - current.lastWanFeedbackAt >= 1500) {
          current.lastWanFeedbackAt = now;
          const change = current.rateControl.update(message);
          if (change) {
            if (sender?.stdin.writable) sender.stdin.write(`BITRATE ${change.kbps}\n`);
            json(ws, { type: 'wan-rate', targetKbps: change.kbps });
            logEvent(`WAN bitrate ${change.kbps} kbps; loss=${
              (change.lossRate * 100).toFixed(2)}%; nack=${change.retransmits}`);
          }
        }
      }
      if (message.type === 'set-latency' && typeof message.enabled === 'boolean') {
        json(ws, current.latency.setEnabled(message.enabled));
        logEvent(`Low latency ${message.enabled ? 'enabled' : 'disabled'}; ` +
          `sync_mode=${current.syncMode}; ` +
          `audio_queue_limit_ms=${current.latency.audioBuffer?.maxBufferedMs ?? 'none'}`);
      }
      if (message.type === 'set-control' && enableInput &&
          typeof message.enabled === 'boolean') {
        current.controlRequested = message.enabled;
        current.controlEnabled = message.enabled && current.inputReady &&
          Boolean(inputHelper?.stdin.writable);
        if (message.enabled && !current.controlEnabled) startInputHelper(current);
        logEvent(`Remote control ${current.controlEnabled ? 'enabled' :
          message.enabled ? 'waiting for input helper' : 'disabled'}`);
        if (!message.enabled && inputHelper?.stdin.writable) inputHelper.stdin.write('R\n');
        if (!message.enabled) current.mouseMode = 'desktop';
        if (!message.enabled) void setGamepad(current, false);
        json(ws, { type: 'control-state', enabled: current.controlEnabled,
          text: message.enabled && !current.controlEnabled ?
            '正在啟動 Windows 輸入程式' : undefined });
      }
      if (message.type === 'set-mouse-mode' && current.controlEnabled &&
          ['desktop', 'relative'].includes(message.mode)) {
        current.mouseMode = message.mode;
        json(ws, { type: 'mouse-mode', mode: current.mouseMode });
      }
      if (message.type === 'set-gamepad' && enableInput &&
          typeof message.enabled === 'boolean' &&
          (current.controlEnabled || !message.enabled)) {
        void setGamepad(current, message.enabled);
      }
      if (message.type === 'description' && message.descriptionType === 'answer' &&
          typeof message.sdp === 'string') {
        current.peer.setRemoteDescription(message.sdp, 'answer');
        json(ws, current.latency.state());
      }
      if (message.type === 'candidate' && typeof message.candidate === 'string' &&
          typeof message.mid === 'string') current.peer.addRemoteCandidate(message.candidate, message.mid);
      if (message.type === 'control') handleControl(current, JSON.stringify(message.input));
    } catch (error) { disposeSession(error.message, current); }
  });
  ws.on('close', () => { clearTimeout(loginTimeout); disposeSession('browser closed', current); });
  ws.on('error', error => console.error('Signaling:', error.message));
});

if (prestartGamepad) await ensureViiper().catch(error =>
  logEvent(`VIIPER preload failed: ${error.message}`));
await new Promise((resolveListen, rejectListen) => {
  tcp.once('error', rejectListen);
  tcp.listen(tcpPort, '127.0.0.1', resolveListen);
});
await new Promise((resolveListen, rejectListen) => {
  https.once('error', rejectListen);
  https.listen(port, host, resolveListen);
});
if (host !== '127.0.0.1') {
  await new Promise((resolveListen, rejectListen) => {
    caDownload.once('error', rejectListen);
    caDownload.listen(caPort, host, resolveListen);
  });
  console.log(`iPad CA certificate download: http://${host}:${caPort}/ca.crt`);
  console.log(`Verify CA SHA-256 fingerprint before trusting: ${await certificateFingerprint()}`);
}
console.log(`RemoteDesk iPad bridge: ${prefix}`);
await pairing.publish();
console.log(`One-time pairing code for this server run: ${pairing.code}`);
console.log(`Remote input: ${enableInput ? 'enabled' : 'disabled'}; gamepad: ${enableInput ? 'on-demand VIIPER' : 'disabled'}; audio: ${enableAudio ? 'enabled' : 'disabled'}; source: ${noLaunch ? 'external test' : 'C++ capture'}; local TCP: ${tcpPort}`);
console.log(`Capture display: ${displayArg.slice('--display='.length)}`);

function shutdown() {
  const gamepadClose = session?.gamepad?.close();
  disposeSession('server stopped');
  tcp.close();
  https.close();
  if (caDownload.listening) caDownload.close();
  void Promise.resolve(gamepadClose).catch(error =>
    logEvent(`Virtual Xbox removal failed: ${error.message}`)).finally(() => managedViiper?.kill());
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
