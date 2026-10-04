const $ = id => document.getElementById(id);
const clientVersion = '2026-10-04.5';
let hostVersion = '';
function updateVersionStatus() {
  $('versionStatus').textContent = `接收端 ${clientVersion}；主機 ${hostVersion || '等待回報'}` +
    (hostVersion && hostVersion !== clientVersion ? '。版本不同，請更新主機並重新載入頁面。' : '');
}
$('reloadClient').onclick = () => {
  if (peer && !confirm('重新載入會中斷本次遠端，之後需重新配對。要繼續嗎？')) return;
  stop('重新載入新版');
  location.reload();
};
// Keep the user's resolution choice across PWA reloads/reconnections.
// Storage may be unavailable in private browsing; the existing default stays valid.
const videoModePreferenceKey = 'remotedesk.videoMode';
try {
  const saved = localStorage.getItem(videoModePreferenceKey);
  if ([...$('videoMode').options].some(option => option.value === saved)) $('videoMode').value = saved;
} catch {}
$('videoMode').addEventListener('change', () => {
  try { localStorage.setItem(videoModePreferenceKey, $('videoMode').value); } catch {}
});
const status = text => { $('status').textContent = text; };
const sendSignal = message => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));
let socket, peer, controlChannel, gamepadChannel, pointerChannel;
let pointerFast = false, pointerSequence = 0;
let gameMouse = false, mouseModeReady = false, relativePosition = null;
let nativeMouseLocked = false;
let nativeMouseEpoch = 0;
let nativeMouseDiagnostics = null;
const nativeMouseBridge = () => [1, 2].includes(window.remoteDeskNative?.version) ?
  window.webkit?.messageHandlers?.remoteDeskMouse ?? null : null;
function notifyNativeMouse(enabled) {
  nativeMouseBridge()?.postMessage({ action: 'capture', enabled, epoch: nativeMouseEpoch });
}
let nativeControlEpoch = 0, nativeInputState = '';
const nativeKeyboard = () => window.remoteDeskNative?.version === 2 && window.remoteDeskNative.keyboard;
const nativePad = () => window.remoteDeskNative?.version === 2 && window.remoteDeskNative.gamepad;
function nativeKeyboardActive() {
  return Boolean(nativeKeyboard() && controlReady && $('control').checked &&
    document.visibilityState === 'visible' && (document.activeElement === screen ||
      document.activeElement === $('keyCapture')));
}
function syncNativeControls() {
  if (!nativeKeyboard() && !nativePad()) return;
  const state = { keyboard: nativeKeyboardActive(), gamepad: Boolean(nativePad() &&
    controlReady && $('control').checked && gamepadActive && document.visibilityState === 'visible') };
  const serialized = JSON.stringify(state);
  if (serialized === nativeInputState) return;
  releaseInputs(); releaseGamepad();
  nativeInputState = serialized;
  nativeMouseBridge()?.postMessage({ action: 'input-state', ...state, epoch: ++nativeControlEpoch });
}
window.remoteDeskNativeKeyboardReset = () => releaseInputs();
window.remoteDeskNativeControlInput = (events, epoch) => {
  if (epoch !== nativeControlEpoch || !controlReady || !$('control').checked || !Array.isArray(events)) return;
  for (const value of events.slice(0, 129)) {
    if (value.type === 'key' && nativeKeyboardActive() && typeof value.code === 'string' &&
        typeof value.down === 'boolean') {
      if (value.code === 'Backquote' && screenViewport.classList.contains('zoomed') &&
          !['ControlLeft','ControlRight','AltLeft','AltRight','MetaLeft','MetaRight','ShiftLeft','ShiftRight'].some(k => downKeys.has(k))) {
        if (value.down && !viewShortcutHeld) setPanScreen(!panScreen);
        viewShortcutHeld = value.down; continue;
      }
      updateKey(value.code, value.down); keyEventsSeen++; keyEventsSent++;
      $('inputStatus').textContent = `App 原生鍵盤：${value.code} ${value.down ? '按下' : '放開'}`;
    } else if (value.type === 'gamepad' && nativePad() && gamepadActive &&
        value.buttons?.length === 17 && value.axes?.length === 4 &&
        [...value.buttons, ...value.axes].every(Number.isFinite)) {
      const state = { type: 'gamepad', buttons: value.buttons.map(v => Math.max(0, Math.min(1, v))),
        axes: value.axes.map(v => Math.max(-1, Math.min(1, v))) };
      if (sendGamepadState(state)) { lastGamepadState = JSON.stringify(state); lastGamepadAt = performance.now(); }
      reportGamepad('App 原生手把 → Windows 虛擬 Xbox 手把');
    }
  }
};
document.addEventListener('focusin', syncNativeControls);
document.addEventListener('focusout', () => queueMicrotask(syncNativeControls));
document.addEventListener('visibilitychange', syncNativeControls);

let relativeDelta = { x: 0, y: 0 }, touchLook = null;
let canControl = false;
let transferToken = null;
let activeUpload = null;
let selectedClipboardImage = null;
let clipboardPreviewUrl = null;
let canGamepad = false;
let controlReady = false;
let gamepadRequested = false;
let gamepadActive = false;
let lowLatencyApplied = false;
let latencyControlAvailable = false;
let latencyState = null;
let latencyPendingTimer = null;
let latencyRollbackNotice = '';
let receiverSafetyBlocked = false;
let receiverLatencyErrors = [];
let receiverRollbackCount = 0;
let videoRecoveryAvailable = false;
let activeSyncMode = 'unknown';
let activeVideoMode = '1080p';
let wanRateTargetKbps = null;
let audioOnDemand = false;
let pendingF5 = false;
let keyEventsSeen = 0, keyEventsSent = 0, keyAcks = 0;
let candidates = [];
let painted = 0, lastPainted = 0, lastMetric = performance.now();
let lastFrameTime = 0, worstGap = 0;
let serverStats = null;
let lastQualityCount = 0;
let lastRenderedAt = 0;
let lastRecoveryRequestedAt = 0;
let receiverStatsAt = 0;
const metricRows = [];
let audioStats = null;
let clientAudioPackets = null;
let clientAudioLost = null;
let clientAudioJitterMs = null;
let audioPlaybackState = '尚未播放';
let audioError = '';
let receiverMetrics = {};
let requestedReceiverLatency = { video: null, audio: null, supported: false };
let previousInbound = new Map();
let lastPresentedCount = null;
const downKeys = new Set();
const downButtons = new Set();

function supportsReceiverLatency(kind = 'video') {
  return Boolean(peer?.getReceivers?.().some(receiver =>
    receiver.track?.kind === kind && 'jitterBufferTarget' in receiver));
}

function updateLatencyStatus() {
  if (!latencyControlAvailable) {
    $('latencyStatus').textContent = '主機尚未更新；請重新啟動 bridge 後再調整音訊排隊。';
    return;
  }
  const audioLimit = latencyState?.audioQueueLimitMs;
  const hostAudio = audioLimit === null || audioLimit === undefined ?
    '主機音訊未啟動' : `主機音訊排隊 ${audioLimit} ms`;
  if (requestedReceiverLatency.supported && latencyState?.enabled) {
    const target = kind => requestedReceiverLatency[kind] === null ?
      '維持瀏覽器預設' : `${requestedReceiverLatency[kind]} ms`;
    $('latencyStatus').textContent =
      `畫面：${target('video')}；聲音：${supportsReceiverLatency('audio') ? target('audio') : '不支援接收緩衝控制'}；${hostAudio}。` +
      (requestedReceiverLatency.video === null ? '等待有效統計；若目前緩衝已低，不會額外增加延遲。' : '瀏覽器已接受目標值，實際延遲請看下方統計，兩者不一定相同。');
  } else if (requestedReceiverLatency.supported) {
    $('latencyStatus').textContent = `接收端維持瀏覽器預設；${hostAudio}。`;
  } else {
    $('latencyStatus').textContent = `${hostAudio}；此 Safari 未提供影音接收緩衝控制，勾選不會改善畫面延遲。`;
  }
  if (latencyRollbackNotice) $('latencyStatus').textContent += ` ${latencyRollbackNotice}`;
  if (receiverLatencyErrors.length) $('latencyStatus').textContent += ` 設定失敗：${receiverLatencyErrors.join('、')}，不能視為已套用。`;
}

function receiverTargetFor(kind, metrics, oldTarget, base = 80) {
  const finite = value => Number.isFinite(value) && value >= 0 ? value : 0;
  const floor = finite(metrics[`${kind}MinimumMs`]);
  const rtt = finite(metrics.rttMs);
  // A browser's measured network minimum is not a value we can override.
  // Round upward and never cap below that minimum on a congested route.
  const desired = Math.ceil(Math.max(kind === 'video' ? base : 100,
    floor + 20, rtt / 2 + (kind === 'video' ? 40 : 60)) / 20) * 20;
  const reported = metrics[`${kind}TargetMs`];
  const measured = Number.isFinite(reported) ? reported : metrics[`${kind}BufferMs`];
  if (oldTarget !== null) return desired;
  // Only shorten an excessive queue. Enabling must not inflate an already
  // low browser default; actual buffer stats also work when target stats lack.
  return Number.isFinite(measured) && measured >= Math.max(
    kind === 'video' ? 140 : 220, desired + 40) ? desired : null;
}

function applyReceiverLatency() {
  const receivers = peer?.getReceivers?.() || [];
  const enabled = latencyState?.enabled === true && !receiverSafetyBlocked;
  receiverLatencyErrors = [];
  const next = { video: null, audio: null, supported: false };
  for (const receiver of receivers) {
    const kind = receiver.track?.kind;
    if (!['video', 'audio'].includes(kind) || !('jitterBufferTarget' in receiver)) continue;
    if (kind === 'video') next.supported = true;
    const oldTarget = requestedReceiverLatency[kind];
    const target = enabled ? receiverTargetFor(kind, receiverMetrics, oldTarget,
      Number($('receiverTarget').value)) : null;
    try {
      if (receiver.jitterBufferTarget !== target) receiver.jitterBufferTarget = target;
      next[kind] = receiver.jitterBufferTarget;
      if (next[kind] !== target) receiverLatencyErrors.push(`${kind}目標未接受`);
    } catch {
      receiverLatencyErrors.push(`${kind}無法寫入`);
      // Preserve the known setting when restoration fails; do not report a
      // successful rollback just because the property setter threw.
      try { next[kind] = receiver.jitterBufferTarget; } catch { next[kind] = oldTarget; }
    }
  }
  requestedReceiverLatency = next;
  lowLatencyApplied = enabled && Number.isFinite(next.video);
  $('lowLatencyLabel').textContent = next.supported ?
    '縮短排隊延遲（畫面＋音訊）' : '縮短排隊延遲（僅主機音訊）';
  $('receiverTarget').disabled = !next.supported || !enabled;
  if (latencyState) updateLatencyStatus();
  return next;
}

function sendInput(value) {
  if (controlReady && $('control').checked) sendInputRaw(value);
}
function sendInputRaw(value) {
  if (canControl) {
    if (value.type === 'move' && pointerFast) {
      const { reliable, ...position } = value;
      value = { ...position, seq: pointerSequence++ };
      if (!reliable && pointerChannel?.readyState === 'open') {
        if (pointerChannel.bufferedAmount < 8192)
          pointerChannel.send(JSON.stringify(value));
        return;
      }
    }
    // On the tailnet, the reliable SCTP control channel can remain 'open'
    // while its retransmit queue stalls. Signaling is a separate reliable
    // connection and already carries working enable/disable commands.
    if (pointerFast) sendSignal({ type: 'control', input: value });
    else if (controlChannel?.readyState === 'open') controlChannel.send(JSON.stringify(value));
    else sendSignal({ type: 'control', input: value });
  }
}
function releaseInputs() {
  for (const code of downKeys) sendInputRaw({ type: 'key', code, down: false });
  for (const button of downButtons) sendInputRaw({ type: 'button', button, down: false });
  downKeys.clear(); downButtons.clear();
}
function updateKey(code, down) {
  if (down && (!controlReady || !$('control').checked)) return;
  if (down === downKeys.has(code)) return;
  sendInput({ type: 'key', code, down });
  if (down) downKeys.add(code); else downKeys.delete(code);
}
function stop(reason = '已斷線') {
  activeUpload?.abort(); activeUpload = null;
  transferToken = null;
  releaseInputs();
  setGameMouse(false);
  releaseGamepad();
  $('control').disabled = true;
  screenViewport.classList.remove('zoomed');
  $('zoomScreen').setAttribute('aria-pressed', 'false');
  $('zoomScreen').textContent = '放大文字 150%';
  $('panScreen').hidden = true;
  setPanScreen(false);
  setMenuOpen(false);
  viewShortcutHeld = false;
  $('control').checked = false;
  canControl = false;
  controlReady = false;
  gamepadRequested = false;
  gamepadActive = false;
  updateGamepadButton();
  pendingF5 = false;
  pendingWin = false;
  controlChannel?.close(); controlChannel = null;
  gamepadChannel?.close(); gamepadChannel = null;
  pointerChannel?.close(); pointerChannel = null;
  pointerFast = false;
  videoRecoveryAvailable = false;
  pointerSequence = 0;
  requestedReceiverLatency = { video: null, audio: null, supported: false };
  peer?.close(); peer = null;
  socket?.close(); socket = null;
  $('connect').disabled = false;
  $('screen').srcObject = null;
  $('sound').srcObject = null;
  $('playAudio').disabled = true;
  $('lowLatency').checked = false;
  $('lowLatency').disabled = true;
  clearTimeout(latencyPendingTimer);
  latencyPendingTimer = null;
  latencyControlAvailable = false;
  latencyState = null;
  latencyRollbackNotice = '';
  receiverSafetyBlocked = false; receiverRollbackCount = 0; receiverLatencyErrors = [];
  $('receiverTarget').disabled = true;
  lowLatencyApplied = false;
  $('latencyStatus').textContent = '主機音訊排隊：一般（120 ms）。';
  lastFrameTime = 0;
  lastRenderedAt = 0;
  $('session').hidden = true;
  $('pairing').hidden = false;
  status(reason);
}
async function handleSignal(message) {
  if (message.type === 'paired') {
    transferToken = typeof message.transferToken === 'string' ? message.transferToken : null;
    $('clipboardStatus').textContent = transferToken ? '可傳送文字或圖片。' : '主機未提供剪貼簿功能。';
    $('uploadStatus').textContent = transferToken ?
      '儲存至 C:\\Users\\johnl\\Desktop\\ipad傳輸' : '主機未提供檔案傳輸功能。';
    // Each server session starts with remote input disabled. Never carry an
    // old session's opt-in or acknowledgement into a fresh pairing.
    controlReady = false;
    $('control').checked = false;
    pendingF5 = false;
    pendingWin = false;
    downKeys.clear();
    downButtons.clear();
    pointerFast = message.pointerFast === true;
    pointerSequence = 0;
    activeSyncMode = message.syncMode || 'unknown';
    activeVideoMode = message.videoMode || '1080p';
    lastRecoveryRequestedAt = 0;
    receiverStatsAt = 0;
    wanRateTargetKbps = null;
    audioOnDemand = message.audioOnDemand === true;
    $('playAudio').textContent = '播放聲音';
    $('syncStatus').textContent = !message.syncMode ?
      '主機尚未更新；請重新啟動 bridge，才能使用即時操作模式。' :
      message.syncMode === 'interactive' ?
      '畫面低延遲播放已啟用：影像不等待音訊追齊；網路波動時聲畫可能暫時不同步。' :
      '影音同步：畫面可能等待音訊；要優先操作反應，斷線後選「即時操作」。';
    if (activeVideoMode === 'cpu1080') $('syncStatus').textContent +=
      ' 目前以另一種主機轉色方式測試；請和預設 1080p 比較同一場景。';
    if (activeVideoMode === 'stable1080') $('syncStatus').textContent +=
      ' 重負載測試：維持 1080p、串流目標 30 FPS；請和預設模式比較同一場景。';
    if (activeVideoMode === 'mobile1080') $('syncStatus').textContent +=
      ' 較低流量測試：維持 1080p60、編碼目標 5 Mbps；動態清晰度可能下降。';
    if (activeVideoMode === 'game1080') $('syncStatus').textContent +=
      ' 遊戲穩定傳輸：1080p60；減少固定恢復影格，停畫時主動要求恢復。';
    canControl = message.inputEnabled;
    canGamepad = message.gamepadEnabled;
    gamepadRequested = false;
    gamepadActive = false;
    updateGamepadButton();
    gamepadHostStatus = '';
    lastGamepadState = '';
    gamepadSequence = 0;
    gamepadSent = 0;
    gamepadSkipped = 0;
    $('control').disabled = !canControl;
    $('pairing').hidden = true;
    $('session').hidden = false;
    lastFrameTime = 0;
    worstGap = 0;
    lastPainted = painted;
    lastMetric = performance.now();
    lastRenderedAt = 0;
    lastQualityCount = $('screen').getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    serverStats = null;
    audioStats = null;
    clientAudioPackets = null;
    clientAudioLost = null;
    clientAudioJitterMs = null;
    audioPlaybackState = '尚未播放';
    audioError = '';
    receiverMetrics = {};
    previousInbound.clear();
    lastPresentedCount = null;
    keyEventsSeen = 0; keyEventsSent = 0; keyAcks = 0;
    metricRows.length = 0;
    $('videoStatus').textContent = '';
    $('lowLatency').checked = false;
    latencyControlAvailable = message.latencyControl === true &&
      message.latencyControlVersion >= 4;
    videoRecoveryAvailable = message.videoRecovery === true;
    hostVersion = message.hostVersion || '';
    updateVersionStatus();
    gamepadRedundant = 0; gamepadAckRttMs = null; gamepadLastAckAt = 0;
    $('lowLatency').disabled = !latencyControlAvailable;
    clearTimeout(latencyPendingTimer);
    latencyPendingTimer = null;
    latencyState = null;
    latencyRollbackNotice = '';
    receiverSafetyBlocked = false; receiverRollbackCount = 0; receiverLatencyErrors = [];
    $('receiverTarget').disabled = true;
    lowLatencyApplied = false;
    requestedReceiverLatency = { video: null, audio: null, supported: false };
    $('latencyStatus').textContent = latencyControlAvailable ? '主機音訊排隊：一般（120 ms）。' :
      '主機尚未提供新版傳輸控制；請重新啟動 bridge。';
    $('gamepadHostStatus').textContent = canGamepad ?
      'Windows 手把：按「啟用虛擬手把」後建立控制器。' :
      'Windows 手把：主機未開啟遠端操作，請加 --enable-input。';
    $('audioStatus').textContent = message.audioEnabled ?
      '等待主機音軌；收到後請按「播放聲音」' : '主機未啟用音訊；啟動時加 --audio';
    status(canControl ? '已配對，等待畫面；可啟用操作' : '已配對，等待畫面；僅觀看');
  } else if (message.type === 'latency-state') {
    latencyState = message;
    clearTimeout(latencyPendingTimer);
    latencyPendingTimer = null;
    applyReceiverLatency();
    $('lowLatency').checked = message.enabled;
    $('lowLatency').disabled = !latencyControlAvailable;
  } else if (message.type === 'wan-rate') {
    wanRateTargetKbps = message.targetKbps;
  } else if (message.type === 'control-state') {
    controlReady = message.enabled;
    if (message.text) $('inputStatus').textContent = message.text;
    const waitingForInput = !message.enabled && $('control').checked &&
      message.text === '正在啟動 Windows 輸入程式';
    if (!message.enabled && !waitingForInput) {
      setGameMouse(false);
      gamepadRequested = false;
      gamepadActive = false;
      updateGamepadButton();
      $('gamepadHostStatus').textContent = 'Windows 手把：遠端操作未啟用，虛擬手把已移除。';
    }
    if (message.enabled) {
      status('遠端操作已啟用');
      if (pendingF5) { pendingF5 = false; sendRemoteF5(); }
      if (pendingWin) { pendingWin = false; sendRemoteWin(); }
      if (gamepadRequested) {
        $('gamepadHostStatus').textContent = 'Windows 手把：正在建立虛擬控制器…';
        sendSignal({ type: 'set-gamepad', enabled: true });
      }
    }
    else status(waitingForInput ? '正在啟動 Windows 輸入程式' :
      '遠端操作已停止，按鍵與滑鼠已釋放');
    syncNativeControls();
  } else if (message.type === 'input-ack') {
    keyAcks++;
    $('inputStatus').textContent = message.accepted ?
      `主機橋接已收到：${message.code} ${message.down ? '按下' : '放開'}` :
      `Safari 送出 ${message.code}，但主機不支援這個鍵碼`;
  } else if (message.type === 'gamepad-status') {
    gamepadHostStatus = message.text;
    $('gamepadHostStatus').textContent = `Windows 手把：${message.text}`;
  } else if (message.type === 'mouse-mode') {
    mouseModeReady = message.mode === 'relative' && gameMouse;
    if (mouseModeReady) notifyNativeMouse(true);
  } else if (message.type === 'gamepad-state') {
    gamepadActive = message.enabled;
    gamepadRequested = message.enabled;
    gamepadHostStatus = message.text;
    updateGamepadButton();
    $('gamepadHostStatus').textContent = `Windows 手把：${message.text}`;
    syncNativeControls();
  } else if (message.type === 'description') {
    if (!peer) {
      peer = new RTCPeerConnection({ iceServers: [] });
      peer.ontrack = event => {
        if (event.track.kind === 'audio') {
          $('sound').srcObject = new MediaStream([event.track]);
          $('sound').muted = false;
          $('sound').volume = 1;
          $('playAudio').disabled = false;
          $('audioStatus').textContent = '音軌已收到；請按「播放聲音」';
          event.track.onmute = () => { $('audioStatus').textContent = '主機音軌已暫停'; };
          applyReceiverLatency();
          return;
        }
        $('screen').srcObject = new MediaStream([event.track]);
        $('screen').play().catch(() => status('請按「播放畫面」'));
        event.track.onmute = () => status('視訊已暫停');
        event.track.onunmute = () => status('畫面已接收');
        applyReceiverLatency();
      };
      peer.ondatachannel = event => {
        if (event.channel.label === 'control') controlChannel = event.channel;
        if (event.channel.label === 'gamepad') {
          gamepadChannel = event.channel;
          const channel = event.channel;
          gamepadChannel.onmessage = event => {
            if (channel !== gamepadChannel) return;
            let ack; try { ack = JSON.parse(event.data); } catch { return; }
            if (ack.type !== 'gamepad-ack' || !Number.isFinite(ack.clientAt)) return;
            const elapsed = performance.now() - ack.clientAt;
            if (elapsed >= 0 && elapsed < 10000) {
              gamepadAckRttMs = Math.round(elapsed);
              gamepadLastAckAt = performance.now();
            }
          };
        }
        if (event.channel.label === 'pointer') pointerChannel = event.channel;
      };
      peer.onicecandidate = event => {
        if (event.candidate) sendSignal({ type: 'candidate', candidate: event.candidate.candidate,
          mid: event.candidate.sdpMid });
      };
      peer.onconnectionstatechange = () => status(`WebRTC: ${peer.connectionState}`);
    }
    const negotiatingPeer = peer;
    await negotiatingPeer.setRemoteDescription({ type: message.descriptionType, sdp: message.sdp });
    if (peer !== negotiatingPeer) return;
    for (const candidate of candidates.splice(0)) await negotiatingPeer.addIceCandidate(candidate);
    const answer = await negotiatingPeer.createAnswer();
    if (peer !== negotiatingPeer) return;
    await negotiatingPeer.setLocalDescription(answer);
    if (peer !== negotiatingPeer) return;
    sendSignal({ type: 'description', descriptionType: negotiatingPeer.localDescription.type,
      sdp: negotiatingPeer.localDescription.sdp });
  } else if (message.type === 'candidate') {
    const value = { candidate: message.candidate, sdpMid: message.mid };
    if (peer?.remoteDescription) await peer.addIceCandidate(value);
    else candidates.push(value);
  } else if (message.type === 'stats') {
    serverStats = message;
    updateDisplayStatus();
  }
  else if (message.type === 'audio-stats') audioStats = message;
  else if (message.type === 'audio-ready') {
    audioError = '';
    $('audioStatus').textContent = '主機音訊擷取已恢復';
  }
  else if (message.type === 'audio-error') {
    audioError = message.text;
    $('audioStatus').textContent = message.text;
  }
  else if (message.type === 'status') status(message.text);
  else if (message.type === 'error') status(message.text);
}

$('connect').onclick = () => {
  const code = $('code').value.trim();
  if (!/^\d{8}$/.test(code)) { status('請輸入 8 位數配對碼'); return; }
  $('connect').disabled = true;
  socket = new WebSocket(`wss://${location.host}/signal`);
  const connectingSocket = socket;
  let signalQueue = Promise.resolve();
  socket.onopen = () => {
    sendSignal({ type: 'pair', code, clientVersion,
      syncMode: $('syncMode').value, audioOnDemand: true,
      videoMode: $('videoMode').value });
  };
  socket.onmessage = event => {
    // WebSocket delivers in order, but async event handlers otherwise overlap.
    signalQueue = signalQueue.then(async () => {
      if (socket !== connectingSocket) return;
      await handleSignal(JSON.parse(event.data));
    }).catch(error => {
      if (socket === connectingSocket) status(`連線錯誤：${error.message}`);
    });
  };
  socket.onerror = () => status('無法連線到電腦');
  socket.onclose = event => {
    if (socket !== connectingSocket) return;
    $('connect').disabled = false;
    if (peer || !$('session').hidden) stop(`已斷線：${event.reason || '連線中斷'}；請重新連線`);
  };
};
$('disconnect').onclick = () => stop();
$('play').onclick = () => $('screen').play().catch(error => status(error.message));
const screenViewport = $('screenViewport');
$('sessionBar').insertBefore($('zoomScreen'), $('viewHint'));
$('sessionBar').insertBefore($('panScreen'), $('viewHint'));
new MutationObserver(() => {
  $('connectionStatus').textContent = $('status').textContent;
}).observe($('status'), { childList: true, characterData: true, subtree: true });
function setMenuOpen(open) {
  $('controlsPanel').hidden = !open;
  $('menuToggle').setAttribute('aria-expanded', String(open));
}
$('menuToggle').onclick = () => setMenuOpen($('controlsPanel').hidden);
$('closeMenu').onclick = () => { setMenuOpen(false); $('screen').focus({ preventScroll: true }); };
let panScreen = false;
let panStart = null;
let viewShortcutHeld = false;
function updateDisplayStatus() {
  const video = $('screen');
  const width = video.videoWidth || serverStats?.width;
  const height = video.videoHeight || serverStats?.height;
  const source = width && height ? `${width}×${height}` : '等待畫面解析度';
  $('displayStatus').textContent = `${source}；${screenViewport.classList.contains('zoomed') ?
    '文字放大 150%，可按「移動畫面」拖曳視野' : '完整畫面'}。放大只改變檢視大小，不改變傳送解析度。`;
}
function setPanScreen(enabled) {
  if (enabled && gameMouse) setGameMouse(false);
  releaseInputs();
  pendingPointer = null;
  panScreen = enabled;
  panStart = null;
  $('panScreen').setAttribute('aria-pressed', String(enabled));
  $('panScreen').textContent = enabled ? '返回遠端操作' : '移動畫面';
  $('viewHint').textContent = enabled ? '移動視角 · ` 切換控制' :
    screenViewport.classList.contains('zoomed') ? '遠端控制 · ` 移動視角' : '遠端桌面';
  updateDisplayStatus();
}
$('zoomScreen').onclick = () => {
  const zoomed = screenViewport.classList.toggle('zoomed');
  $('zoomScreen').setAttribute('aria-pressed', String(zoomed));
  $('zoomScreen').textContent = zoomed ? '顯示完整畫面' : '放大文字 150%';
  $('panScreen').hidden = !zoomed;
  setPanScreen(zoomed);
  if (zoomed) requestAnimationFrame(() => {
    screenViewport.scrollLeft = (screenViewport.scrollWidth - screenViewport.clientWidth) / 2;
    screenViewport.scrollTop = (screenViewport.scrollHeight - screenViewport.clientHeight) / 2;
  });
};
$('panScreen').onclick = () => setPanScreen(!panScreen);
$('screen').addEventListener('loadedmetadata', updateDisplayStatus);
$('playAudio').onclick = async () => {
  if (!$('sound').paused) { $('sound').pause(); return; }
  try {
    sendSignal({ type: 'set-audio-playback', enabled: true });
    $('sound').muted = false;
    $('sound').volume = 1;
    await $('sound').play();
    audioPlaybackState = '播放中';
    $('playAudio').textContent = '暫停聲音';
  } catch (error) {
    sendSignal({ type: 'set-audio-playback', enabled: false });
    audioPlaybackState = `播放失敗：${error.message}`;
    $('audioStatus').textContent = audioPlaybackState;
  }
};
$('control').onchange = () => {
  if (!$('control').checked) {
    setGameMouse(false);
    releaseInputs();
    releaseGamepad();
    controlReady = false;
    gamepadRequested = false;
    gamepadActive = false;
    updateGamepadButton();
    pendingF5 = false;
    pendingWin = false;
  }
  sendSignal({ type: 'set-control', enabled: $('control').checked });
};
function enableControlForAction() {
  if (!canControl) {
    $('inputStatus').textContent = '主機未開啟遠端操作；請確認啟動指令包含 --enable-input';
    return false;
  }
  if (!$('control').checked) {
    $('control').checked = true;
    $('control').dispatchEvent(new Event('change'));
  }
  return true;
}
$('keyboard').onclick = () => {
  if (enableControlForAction()) {
    $('touchKeyboardBox').open = true;
    $('typing').focus();
  }
};

async function showClipboardImage(file) {
  if (!file || !file.type.startsWith('image/')) {
    $('clipboardStatus').textContent = '請選擇圖片。';
    return;
  }
  if (!/^image\/(png|jpeg)$/i.test(file.type)) {
    // Photos may hand Safari a HEIC/WebP image. Convert in the browser so the
    // Windows clipboard helper only has to decode PNG and JPEG.
    const sourceUrl = URL.createObjectURL(file);
    try {
      const source = new Image();
      source.src = sourceUrl;
      await source.decode();
      const canvas = document.createElement('canvas');
      canvas.width = source.naturalWidth;
      canvas.height = source.naturalHeight;
      canvas.getContext('2d').drawImage(source, 0, 0);
      file = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!file) throw new Error('無法轉換圖片');
    } catch {
      $('clipboardStatus').textContent = '此圖片格式無法貼入剪貼簿；仍可用檔案傳輸送到電腦。';
      return;
    } finally { URL.revokeObjectURL(sourceUrl); }
  }
  if (file.size > 16 * 1024 * 1024) {
    $('clipboardStatus').textContent = '圖片超過 16 MiB，請改用檔案傳輸。'; return;
  }
  if (clipboardPreviewUrl) URL.revokeObjectURL(clipboardPreviewUrl);
  selectedClipboardImage = file;
  clipboardPreviewUrl = URL.createObjectURL(file);
  $('clipboardPreview').hidden = false;
  $('clipboardPreview').replaceChildren();
  const image = document.createElement('img');
  image.src = clipboardPreviewUrl;
  image.alt = '準備傳送的圖片';
  $('clipboardPreview').append(image);
  $('clipboardText').value = '';
  $('clipboardStatus').textContent = `已選擇圖片：${file.name || '剪貼簿圖片'}；按送出即可在 Windows 貼上。`;
}
function clearClipboardImage() {
  selectedClipboardImage = null;
  if (clipboardPreviewUrl) URL.revokeObjectURL(clipboardPreviewUrl);
  clipboardPreviewUrl = null;
  $('clipboardPreview').hidden = true;
  $('clipboardPreview').replaceChildren();
}
$('clipboardText').addEventListener('paste', event => {
  const image = [...(event.clipboardData?.items || [])]
    .find(item => item.type.startsWith('image/'));
  if (image) {
    event.preventDefault();
    void showClipboardImage(image.getAsFile());
  }
});
$('clipboardText').addEventListener('input', () => {
  if (selectedClipboardImage && $('clipboardText').value) clearClipboardImage();
});
$('clipboardImage').onchange = () => {
  void showClipboardImage($('clipboardImage').files?.[0]);
};
$('readClipboard').onclick = async () => {
  try {
    if (navigator.clipboard?.read) {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find(type => type.startsWith('image/'));
        if (type) { await showClipboardImage(await item.getType(type)); return; }
      }
    }
    if (navigator.clipboard?.readText) {
      const value = await navigator.clipboard.readText();
      clearClipboardImage();
      $('clipboardText').value = value;
      $('clipboardStatus').textContent = value ? '已讀取文字；按送出即可在 Windows 貼上。' : '剪貼簿沒有文字。';
      return;
    }
    throw new Error('瀏覽器未提供讀取功能');
  } catch {
    $('clipboardText').focus();
    $('clipboardStatus').textContent = '請長按文字框選「貼上」；圖片也可按「選擇圖片」。';
  }
};
$('sendClipboard').onclick = async () => {
  if (!transferToken || socket?.readyState !== WebSocket.OPEN) {
    $('clipboardStatus').textContent = '請先配對主機。'; return;
  }
  const body = selectedClipboardImage || $('clipboardText').value;
  if (!body) { $('clipboardStatus').textContent = '請先貼上文字或圖片。'; return; }
  $('sendClipboard').disabled = true;
  $('clipboardStatus').textContent = '正在傳送至 Windows 剪貼簿…';
  try {
    const response = await fetch('/api/clipboard', { method: 'POST',
      headers: { 'x-remotedesk-token': transferToken,
        'content-type': selectedClipboardImage?.type || 'text/plain; charset=utf-8' },
      body });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    $('clipboardStatus').textContent = `${result.kind === 'image' ? '圖片' : '文字'}已送到 Windows 剪貼簿；現在可在電腦按 Ctrl+V。`;
  } catch (error) { $('clipboardStatus').textContent = `傳送失敗：${error.message}`; }
  finally { $('sendClipboard').disabled = false; }
};
function uploadOne(file, index, total) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    activeUpload = xhr;
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('x-remotedesk-token', transferToken);
    xhr.setRequestHeader('x-remotedesk-name', encodeURIComponent(file.name));
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = event => {
      const progress = event.lengthComputable ? ` ${Math.round(event.loaded / event.total * 100)}%` : '';
      $('uploadStatus').textContent = `第 ${index}/${total} 個：${file.name}${progress}`;
    };
    xhr.onload = () => {
      activeUpload = null;
      let result = {};
      try { result = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 200) resolve(result);
      else reject(new Error(result.error || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => { activeUpload = null; reject(new Error('網路中斷')); };
    xhr.onabort = () => { activeUpload = null; reject(new Error('傳輸已中斷')); };
    xhr.send(file);
  });
}
$('sendFiles').onclick = async () => {
  const files = [...($('uploadFiles').files || [])];
  if (!transferToken || socket?.readyState !== WebSocket.OPEN) {
    $('uploadStatus').textContent = '請先配對主機。'; return;
  }
  if (!files.length) { $('uploadStatus').textContent = '請先選擇檔案。'; return; }
  if (files.some(file => file.size > 4 * 1024 ** 3)) {
    $('uploadStatus').textContent = '單一檔案上限 4 GiB。'; return;
  }
  $('sendFiles').disabled = true;
  try {
    for (const [index, file] of files.entries()) {
      const result = await uploadOne(file, index + 1, files.length);
      $('uploadStatus').textContent = `已接收 ${index + 1}/${files.length}：${result.name}（${result.bytes} 位元組）；存於 C:\\Users\\johnl\\Desktop\\ipad傳輸`;
    }
    $('uploadFiles').value = '';
  } catch (error) { $('uploadStatus').textContent = `傳輸失敗：${error.message}`; }
  finally { $('sendFiles').disabled = false; }
};
$('focusKeys').onclick = () => {
  if (!enableControlForAction()) return;
  if (panScreen) setPanScreen(false);
  setMenuOpen(false);
  // The visible video receives hardware key events without opening an editor.
  $('screen').focus({ preventScroll: true });
  $('inputStatus').textContent = '實體鍵盤已對準遠端畫面；請按一個鍵。';
};
$('keyCapture').onfocus = () => {
  $('inputStatus').textContent = '實體鍵盤輸入區已取得焦點；請按一個鍵。';
};
$('keyCapture').onblur = () => {
  releaseInputs();
  $('inputStatus').textContent = '實體鍵盤輸入區已失去焦點；點此區或按「鍵盤控制」。';
};
function sendRemoteF5() {
  sendInput({ type: 'key', code: 'F5', down: true });
  setTimeout(() => sendInput({ type: 'key', code: 'F5', down: false }), 60);
  $('inputStatus').textContent = '已送出遠端 F5';
}
$('remoteRefresh').onclick = () => {
  if (!enableControlForAction()) return;
  if (controlReady) sendRemoteF5();
  else {
    pendingF5 = true;
    $('inputStatus').textContent = '等待主機啟用遠端操作，接著送出 F5';
  }
};
$('sound').addEventListener('pause', () => {
  sendSignal({ type: 'set-audio-playback', enabled: false });
  audioPlaybackState = '已暫停';
  $('playAudio').textContent = '播放聲音';
  if ($('lowLatency').checked && !supportsReceiverLatency()) {
    $('lowLatency').checked = false;
    sendSignal({ type: 'set-latency', enabled: false });
  }
});
function applyLatencyTarget() {
  const requested = $('lowLatency').checked;
  if (requested) { latencyRollbackNotice = ''; receiverSafetyBlocked = false; }
  if (requested && audioPlaybackState !== '播放中' && !supportsReceiverLatency()) {
    $('lowLatency').checked = false;
    $('latencyStatus').textContent = '尚未播放聲音；音訊排隊設定不影響畫面或遠端輸入。';
    return;
  }
  if (!latencyControlAvailable || socket?.readyState !== WebSocket.OPEN) {
    $('lowLatency').checked = latencyState?.enabled ?? false;
    $('latencyStatus').textContent = '主機尚未連線或不支援；請重新啟動新版 bridge 後配對。';
    return;
  }
  $('lowLatency').disabled = true;
  $('latencyStatus').textContent = '正在確認縮短排隊設定…';
  clearTimeout(latencyPendingTimer);
  latencyPendingTimer = setTimeout(() => {
    latencyPendingTimer = null;
    $('lowLatency').checked = latencyState?.enabled ?? false;
    $('lowLatency').disabled = !latencyControlAvailable;
    $('latencyStatus').textContent = '主機未回覆；設定尚未確認，請檢查連線。';
  }, 5000);
  sendSignal({ type: 'set-latency', enabled: requested });
}
$('lowLatency').onchange = applyLatencyTarget;
$('receiverTarget').onchange = applyReceiverLatency;
let pendingWin = false;
function sendRemoteWin() {
  if (downKeys.has('MetaLeft')) return;
  updateKey('MetaLeft', true);
  setTimeout(() => updateKey('MetaLeft', false), 80);
  $('inputStatus').textContent = '已送出遠端 Win 鍵';
}
function updateGamepadButton() {
  $('toggleGamepad').disabled = !canGamepad;
  $('toggleGamepad').textContent = gamepadRequested ? '停用虛擬手把' : '啟用虛擬手把';
  $('toggleGamepad').setAttribute('aria-pressed', String(gamepadRequested));
}
$('toggleGamepad').onclick = () => {
  if (!canGamepad || (!gamepadRequested && !enableControlForAction())) return;
  const enabled = !gamepadRequested;
  if (!enabled) releaseGamepad();
  gamepadRequested = enabled;
  if (!enabled) gamepadActive = false;
  updateGamepadButton();
  $('gamepadHostStatus').textContent = enabled ?
    'Windows 手把：等待主機啟用虛擬控制器…' : 'Windows 手把：正在停用…';
  if (controlReady || !enabled) sendSignal({ type: 'set-gamepad', enabled });
};
$('remoteWin').onclick = () => {
  if (!enableControlForAction()) return;
  if (controlReady) sendRemoteWin();
  else {
    pendingWin = true;
    $('inputStatus').textContent = '等待主機啟用遠端操作，接著送出 Win 鍵';
  }
};
$('typing').oninput = event => {
  const value = event.target.value;
  if (value) sendInput({ type: 'text', text: value.slice(-32) });
  event.target.value = '';
};

function pointerPosition(event) {
  const video = $('screen');
  const rect = video.getBoundingClientRect();
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const scale = Math.min(rect.width / vw, rect.height / vh);
  const displayedWidth = vw * scale, displayedHeight = vh * scale;
  const left = rect.left + (rect.width - displayedWidth) / 2;
  const top = rect.top + (rect.height - displayedHeight) / 2;
  const edge = 8;
  const coordinate = (point, start, length) => {
    if (point <= start + edge) return 0;
    if (point >= start + length - edge) return 1;
    return Math.max(0, Math.min(1, (point - start) / length));
  };
  return { x: coordinate(event.clientX, left, displayedWidth),
    y: coordinate(event.clientY, top, displayedHeight) };
}
const screen = $('screen');
let pendingPointer = null;
let pointerScheduled = false;
function updateMouseStatus() {
  $('gameMouse').setAttribute('aria-pressed', String(gameMouse));
  $('gameMouse').textContent = gameMouse ? '返回桌面滑鼠' : '遊戲滑鼠';
  if (gameMouse) $('viewHint').textContent = '遊戲滑鼠 · 功能內可切回桌面';
  else $('viewHint').textContent = panScreen ? '移動視角 · ` 切換控制' :
    screenViewport.classList.contains('zoomed') ? '遠端控制 · ` 移動視角' : '遠端桌面';
  $('mouseStatus').textContent = !gameMouse ? '桌面滑鼠：點擊位置與 Windows 游標對齊。' :
    nativeMouseLocked ? '原生遊戲滑鼠：游標已隱藏並鎖定，可連續轉向；Esc 或 App「釋放」退出。' :
    nativeMouseBridge() ? '原生遊戲滑鼠：等待 iPad 確認游標鎖定；請接上滑鼠並使用完整螢幕。' :
    document.pointerLockElement === screen ? '遊戲滑鼠：已鎖定游標，可連續轉向；Esc 釋放游標。' :
    '遊戲滑鼠：移動滑鼠或拖曳畫面轉向；碰到 iPad 畫面邊緣需移回再繼續。輕點為左鍵。';
}
function setGameMouse(enabled) {
  releaseInputs();
  nativeMouseEpoch++;
  gameMouse = enabled;
  mouseModeReady = false;
  relativePosition = null;
  relativeDelta = { x: 0, y: 0 };
  pendingPointer = null;
  touchLook = null;
  if (!enabled) { notifyNativeMouse(false); nativeMouseLocked = false; }
  if (!enabled && document.pointerLockElement === screen) document.exitPointerLock();
  sendSignal({ type: 'set-mouse-mode', mode: enabled ? 'relative' : 'desktop' });
  updateMouseStatus();
}
async function lockGameMouse() {
  if (nativeMouseBridge()) return;
  if (typeof screen.requestPointerLock !== 'function') return;
  try { await screen.requestPointerLock(); }
  catch { updateMouseStatus(); }
}
$('gameMouse').onclick = () => {
  if (!gameMouse && (!controlReady || !$('control').checked)) {
    $('mouseStatus').textContent = '請先勾選遠端操作，等候鍵盤控制就緒，再啟用遊戲滑鼠。';
    return;
  }
  setGameMouse(!gameMouse);
  if (gameMouse) {
    setPanScreen(false);
    updateMouseStatus();
    setMenuOpen(false);
    screen.focus({ preventScroll: true });
    void lockGameMouse();
  }
};
document.addEventListener('pointerlockchange', () => {
  relativePosition = null;
  releaseInputs();
  updateMouseStatus();
});
document.addEventListener('pointerlockerror', updateMouseStatus);
function queueRelative(x, y) {
  if (!gameMouse || !mouseModeReady || !controlReady || !$('control').checked) return;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  relativeDelta.x += x;
  relativeDelta.y += y;
  if (pointerScheduled) return;
  pointerScheduled = true;
  requestAnimationFrame(() => {
    pointerScheduled = false;
    flushRelative();
  });
}
function flushRelative() {
  if (!gameMouse || !mouseModeReady) return;
  const dx = Math.max(-2048, Math.min(2048, Math.trunc(relativeDelta.x)));
  const dy = Math.max(-2048, Math.min(2048, Math.trunc(relativeDelta.y)));
  relativeDelta.x -= dx;
  relativeDelta.y -= dy;
  if (dx || dy) sendInput({ type: 'move-relative', dx, dy });
}
document.addEventListener('mousemove', event => {
  if (document.pointerLockElement === screen) queueRelative(event.movementX, event.movementY);
});
// Only the bundled native host can expose this bridge; ordinary Safari keeps its existing path.
window.remoteDeskNativeStatus = value => {
  if (!nativeMouseBridge() || value?.epoch !== nativeMouseEpoch) return;
  nativeMouseDiagnostics = value;
  const wasLocked = nativeMouseLocked;
  nativeMouseLocked = value?.locked === true;
  if (wasLocked && !nativeMouseLocked) { relativeDelta = { x: 0, y: 0 }; releaseInputs(); }
  updateMouseStatus();
  if (value?.error) $('mouseStatus').textContent = String(value.error);
};
window.remoteDeskNativeRelease = () => {
  if (!nativeMouseBridge()) return;
  setGameMouse(false);
  releaseGamepad();
  nativeInputState = ''; syncNativeControls();
};
window.remoteDeskNativeInput = (events, epoch) => {
  if (!nativeMouseBridge() || !nativeMouseLocked || !gameMouse || !mouseModeReady ||
      epoch !== nativeMouseEpoch || !controlReady || !$('control').checked || !Array.isArray(events)) return;
  for (const value of events.slice(0, 128)) {
    if (value.type === 'move') queueRelative(value.dx, value.dy);
    else if (value.type === 'button' && [0, 1, 2].includes(value.button) &&
        typeof value.down === 'boolean') {
      flushRelative();
      if (value.down) downButtons.add(value.button); else downButtons.delete(value.button);
      sendInput({ type: 'button', button: value.button, down: value.down });
    } else if (value.type === 'wheel' && [120, -120].includes(value.delta)) sendInput(value);
  }
};
screen.addEventListener('pointerleave', () => { relativePosition = null; });
screen.onpointermove = event => {
  if (gameMouse) {
    if (nativeMouseLocked && event.pointerType !== 'touch') return;
    if (document.pointerLockElement === screen) return;
    if (event.pointerType === 'touch' && !touchLook) return;
    if (relativePosition) queueRelative(event.clientX - relativePosition.x,
      event.clientY - relativePosition.y);
    relativePosition = { x: event.clientX, y: event.clientY };
    if (touchLook && Math.hypot(event.clientX - touchLook.x, event.clientY - touchLook.y) > 6)
      touchLook.moved = true;
    return;
  }
  if (panScreen && panStart) {
    screenViewport.scrollLeft = panStart.scrollLeft - (event.clientX - panStart.x);
    screenViewport.scrollTop = panStart.scrollTop - (event.clientY - panStart.y);
    return;
  }
  if (panScreen) return;
  if (!controlReady || !$('control').checked) return;
  pendingPointer = pointerPosition(event);
  if (pointerScheduled) return;
  pointerScheduled = true;
  requestAnimationFrame(() => {
    pointerScheduled = false;
    if (pendingPointer && !gameMouse) sendInput({ type: 'move', ...pendingPointer });
    pendingPointer = null;
  });
};
screen.onpointerdown = event => {
  if (gameMouse) {
    if (nativeMouseLocked && event.pointerType !== 'touch') return;
    if (!controlReady || !$('control').checked || !mouseModeReady) return;
    screen.focus({ preventScroll: true });
    if (document.pointerLockElement !== screen) screen.setPointerCapture(event.pointerId);
    relativePosition = { x: event.clientX, y: event.clientY };
    if (event.pointerType === 'touch') {
      touchLook = { x: event.clientX, y: event.clientY, moved: false };
      return;
    }
    if (event.button <= 2) {
      downButtons.add(event.button);
      sendInput({ type: 'button', button: event.button, down: true });
    }
    return;
  }
  if (panScreen) {
    screen.focus({ preventScroll: true });
    screen.setPointerCapture(event.pointerId);
    panStart = { x: event.clientX, y: event.clientY,
      scrollLeft: screenViewport.scrollLeft, scrollTop: screenViewport.scrollTop };
    return;
  }
  if (!controlReady || !$('control').checked) return;
  screen.setPointerCapture(event.pointerId);
  screen.focus();
  // The click's position and button must arrive in order on the reliable channel.
  sendInput({ type: 'move', ...pointerPosition(event), reliable: true });
  const button = event.pointerType === 'touch' ? 0 : event.button;
  if (button <= 2) { downButtons.add(button); sendInput({ type: 'button', button, down: true }); }
};
screen.onpointerup = event => {
  if (gameMouse && nativeMouseLocked && event.pointerType !== 'touch') return;
  if (gameMouse && event.pointerType === 'touch') {
    if (touchLook && !touchLook.moved) {
      sendInput({ type: 'button', button: 0, down: true });
      sendInput({ type: 'button', button: 0, down: false });
    }
    touchLook = null;
    relativePosition = null;
    return;
  }
  if (panScreen) { panStart = null; return; }
  const button = event.pointerType === 'touch' ? 0 : event.button;
  if (downButtons.has(button)) {
    sendInput({ type: 'button', button, down: false });
    downButtons.delete(button);
  }
};
screen.onpointercancel = () => { panStart = null; touchLook = null; relativePosition = null; releaseInputs(); };
screen.addEventListener('wheel', event => {
  if (gameMouse && nativeMouseLocked) { event.preventDefault(); return; }
  if (panScreen) return;
  if (!controlReady || !$('control').checked) return;
  event.preventDefault();
  if (event.deltaY) sendInput({ type: 'wheel', delta: event.deltaY > 0 ? -120 : 120 });
}, { passive: false });
screen.oncontextmenu = event => event.preventDefault();
window.onblur = () => {
  relativePosition = null;
  relativeDelta = { x: 0, y: 0 };
  touchLook = null;
  releaseInputs(); releaseGamepad(); viewShortcutHeld = false;
};
function keyCodeFromEvent(event) {
  const arrow = { ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
    ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', Left: 'ArrowLeft',
    Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown' }[event.key];
  if (arrow) return arrow;
  if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') return event.code;
  if (event.key === 'Shift') return event.location === 2 ? 'ShiftRight' : 'ShiftLeft';
  if (event.code && event.code !== 'Unidentified' && event.code !== 'Process') return event.code;
  const key = event.key;
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (key === ' ') return 'Space';
  if (['Meta', 'OS', 'Win', 'Command', 'Super'].includes(key)) return 'MetaLeft';
  return { Esc: 'Escape' }[key] || key;
}
document.onkeydown = event => {
  const code = keyCodeFromEvent(event);
  if (nativeKeyboardActive()) { event.preventDefault(); return; }
  const typing = document.activeElement === $('typing') ||
    document.activeElement?.matches('input, select, [contenteditable="true"]');
  if (!$('session').hidden && !typing && screenViewport.classList.contains('zoomed') &&
      (code === 'Backquote' || event.key === '`') &&
      !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
    event.preventDefault();
    if (!event.repeat && !viewShortcutHeld) setPanScreen(!panScreen);
    viewShortcutHeld = true;
    return;
  }
  if (event.key === 'Escape' && !$('controlsPanel').hidden) {
    event.preventDefault(); setMenuOpen(false); screen.focus({ preventScroll: true }); return;
  }
  const navigationKey = /^Arrow(?:Up|Down|Left|Right)$/.test(code);
  const modifierKey = code === 'ShiftLeft' || code === 'ShiftRight';
  const capture = document.activeElement === screen ||
    document.activeElement === $('keyCapture') ||
    (document.activeElement === $('typing') && (navigationKey || modifierKey));
  const functionKey = /^F(?:[1-9]|1[0-2])$/.test(code);
  if (capture) keyEventsSeen++;
  if (capture) {
    $('inputStatus').textContent = `Safari 收到：key=${event.key || '空'}，code=${event.code || '空'}；` +
      `${controlReady && $('control').checked ? '準備轉送' : '遠端操作尚未啟用'}`;
  }
  if (!controlReady || !$('control').checked) return;
  if (!capture && !functionKey) return;
  if (code && code !== 'Unidentified') {
    updateKey(code, true);
    keyEventsSent++;
    event.preventDefault();
  }
};
document.onkeyup = event => {
  if (nativeKeyboardActive()) { event.preventDefault(); return; }
  const code = keyCodeFromEvent(event);
  if (viewShortcutHeld && (code === 'Backquote' || event.key === '`')) {
    viewShortcutHeld = false; event.preventDefault(); return;
  }
  if (downKeys.has(code)) { updateKey(code, false); event.preventDefault(); }
};
$('keyCapture').oninput = event => {
  const value = event.target.value;
  event.target.value = '';
  if (value) $('inputStatus').textContent =
    `Safari 只送來文字「${value.slice(-8)}」，沒有可持續按住的按鍵事件；請用實體鍵盤。`;
};

let gamepadHostStatus = '';
let gamepadMessage = '';
let lastGamepadState = '';
let lastGamepadAt = 0;
let lastGamepadReportAt = 0;
let gamepadSequence = 0;
let gamepadSent = 0;
let gamepadSkipped = 0;
let gamepadRedundant = 0, gamepadAckRttMs = null, gamepadLastAckAt = 0;
let gamepadPollDelay = 100;
let worstUiTimerLag = 0;
let nextGamepadTickAt = performance.now() + 8;
const standardButtonNames = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT',
  'View', 'Menu', '左搖桿', '右搖桿', '上', '下', '左', '右', 'Xbox'];
const neutralGamepad = () => ({ type: 'gamepad', buttons: Array(17).fill(0), axes: [0, 0, 0, 0] });
function releaseGamepad() {
  if (lastGamepadState && gamepadActive && controlReady) {
    const neutral = { ...neutralGamepad(), seq: ++gamepadSequence };
    if (gamepadChannel?.readyState === 'open' && gamepadChannel.bufferedAmount < 1024)
      gamepadChannel.send(JSON.stringify(neutral));
    // A reliable release also covers loss of the final unordered packet.
    sendInputRaw(neutral);
  }
  lastGamepadState = '';
  lastGamepadAt = 0;
}
function sendGamepadState(state) {
  const value = { ...state, seq: ++gamepadSequence, clientAt: performance.now() };
  if (gamepadChannel?.readyState === 'open') {
    // Drop obsolete samples when SCTP is backed up; the next poll sends the latest state.
    if (gamepadChannel.bufferedAmount >= 1024) { gamepadSkipped++; return false; }
    gamepadChannel.send(JSON.stringify(value));
    const channel = gamepadChannel;
    // An isolated lost button press used to wait for the 100 ms keepalive.
    // Repeat only the latest state briefly; the host ignores duplicate seqs.
    // A new input/release cancels obsolete copies, avoiding stuck old buttons.
    for (const delay of [12, 28]) setTimeout(() => {
      if (channel === gamepadChannel && value.seq === gamepadSequence &&
          gamepadActive && controlReady && $('control').checked &&
          channel.readyState === 'open' && channel.bufferedAmount < 1024) {
        channel.send(JSON.stringify(value)); gamepadRedundant++;
      }
    }, delay);
  } else if (canControl) sendInputRaw(value);
  else return false;
  gamepadSent++;
  return true;
}
function reportGamepad(message) {
  if (gamepadMessage === message) return;
  gamepadMessage = message;
  $('gamepadStatus').textContent = message;
}
window.addEventListener('gamepadconnected', () => {
  reportGamepad('iPad 瀏覽器已偵測手把。');
});
window.addEventListener('gamepaddisconnected', () => {
  releaseGamepad();
  reportGamepad('手把已斷線');
});
function pollGamepad() {
  syncNativeControls();
  if (nativePad()) { gamepadPollDelay = 100; return; }
  let pad = null;
  try { pad = navigator.getGamepads?.().find(Boolean) ?? null; } catch {}
  // Keep the 8 ms response while actively forwarding a pad. Otherwise avoid
  // waking Safari's main thread 125 times per second during normal browsing.
  gamepadPollDelay = pad?.mapping === 'standard' && gamepadActive &&
    controlReady && $('control').checked ? 8 : 100;
  if (pad?.mapping === 'standard' && gamepadActive && controlReady && $('control').checked) {
    const state = { type: 'gamepad',
      buttons: Array.from({ length: 17 }, (_, i) => Math.max(0, Math.min(1,
        pad.buttons[i]?.value || 0))),
      axes: Array.from({ length: 4 }, (_, i) => Math.max(-1, Math.min(1,
        pad.axes[i] || 0))) };
    const serialized = JSON.stringify(state);
    const now = performance.now();
    // Forward a changed button/axis on the next browser frame; keep the host
    // watchdog alive even while the pad is held still.
    if (serialized !== lastGamepadState || now - lastGamepadAt >= 100) {
      if (sendGamepadState(state)) {
        lastGamepadState = serialized;
        lastGamepadAt = now;
      }
    }
  } else if (lastGamepadState) {
    releaseGamepad();
  }
  const reportNow = performance.now();
  if (reportNow - lastGamepadReportAt < 250) return;
  lastGamepadReportAt = reportNow;
  if (pad) {
    const pressed = Array.from(pad.buttons, (button, index) => button.pressed ? index : null)
      .filter(index => index !== null);
    const buttonLabels = pad.mapping === 'standard' ?
      pressed.map(index => standardButtonNames[index] || String(index)) : pressed;
    reportGamepad(`iPad 手把已偵測（${pad.mapping || '非標準'}）；按鈕 ${buttonLabels.join(', ') || '無'}；` +
      `${pad.mapping !== 'standard' ? '瀏覽器未提供標準 Xbox 按鈕順序' :
        gamepadActive ? '傳送至虛擬 Xbox 手把' :
          gamepadRequested ? '等待主機建立虛擬手把' :
            canGamepad ? '請按「啟用虛擬手把」' : '主機未開啟遠端操作'}。`);
  } else if (!navigator.getGamepads) {
    reportGamepad('此瀏覽器沒有提供 Gamepad API，無法讀取手把。');
  } else {
    reportGamepad('等待手把；請保持此頁在前景並按一下手把按鈕。');
  }
}
// Sampling must not wait for a video paint; Safari may present frames unevenly.
function gamepadTick() {
  const now = performance.now();
  if ((videoRecoveryAvailable || activeVideoMode === 'game1080') && peer?.connectionState === 'connected' &&
      document.visibilityState === 'visible' && !screen.paused &&
      (lastFrameTime ? now - lastFrameTime >= 250 : serverStats?.sent >= 60) &&
      (!lastRecoveryRequestedAt || now - lastRecoveryRequestedAt >= 1000) && worstUiTimerLag < 100) {
    lastRecoveryRequestedAt = now;
    sendSignal({ type: 'request-video-recovery' });
  }
  if (document.visibilityState === 'visible')
    worstUiTimerLag = Math.max(worstUiTimerLag, Math.max(0,
      performance.now() - nextGamepadTickAt));
  pollGamepad();
  nextGamepadTickAt = performance.now() + gamepadPollDelay;
  setTimeout(gamepadTick, gamepadPollDelay);
}
setTimeout(gamepadTick, 8);

if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
  const countFrame = (time, metadata) => {
    const count = metadata?.presentedFrames;
    const gap = lastFrameTime ? time - lastFrameTime : 0;
    const countDelta = Number.isFinite(count) && lastPresentedCount !== null &&
      count >= lastPresentedCount ? count - lastPresentedCount : 1;
    // Safari may deliver accumulated metadata after a tab has been suspended.
    painted += gap > 1000 ? 1 : Math.min(countDelta, Math.max(1, Math.ceil(gap / 16)));
    lastPresentedCount = Number.isFinite(count) ? count : null;
    if (lastFrameTime) worstGap = Math.max(worstGap, time - lastFrameTime);
    lastFrameTime = time;
    screen.requestVideoFrameCallback(countFrame);
  };
  screen.requestVideoFrameCallback(countFrame);
}
setInterval(() => {
  const now = performance.now(), seconds = (now - lastMetric) / 1000;
  const quality = screen.getVideoPlaybackQuality?.();
  const frameCount = 'requestVideoFrameCallback' in screen ? painted :
    (quality?.totalVideoFrames ?? screen.webkitDecodedFrameCount ?? 0);
  const previousCount = 'requestVideoFrameCallback' in screen ? lastPainted : lastQualityCount;
  const frames = Math.max(0, frameCount - previousCount);
  const frameRate = (frames / seconds).toFixed(1);
  if (frames > 0) lastRenderedAt = now;
  const stalledMs = peer && lastRenderedAt && document.visibilityState === 'visible' ?
    Math.max(0, now - lastRenderedAt) : 0;
  // If a receiver accepts a shorter video buffer but keeps decoding without
  // presenting, restore its browser default before the user has to reconnect.
  if (stalledMs >= 2500 && lowLatencyApplied && !screen.paused &&
      receiverStatsAt && now - receiverStatsAt < 5000 &&
      Number(receiverMetrics.videoFps) >= 30) {
    $('lowLatency').checked = false;
    latencyRollbackNotice = '偵測到畫面持續解碼卻停止呈現；已自動還原畫面緩衝設定。';
    receiverSafetyBlocked = true;
    receiverRollbackCount++;
    if (latencyState) latencyState = { ...latencyState, enabled: false };
    applyReceiverLatency();
    sendSignal({ type: 'set-latency', enabled: false });
    updateLatencyStatus();
  }
  const gap = 'requestVideoFrameCallback' in screen && lastFrameTime ? worstGap : null;
  const uiTimerLag = Math.round(worstUiTimerLag);
  const remote = serverStats ? `${serverStats.width}×${serverStats.height}，主機擷取更新約 ${serverStats.captureFps ?? '未知'} FPS、送出約 ${serverStats.sentFps ?? '未知'} FPS（累計 ${serverStats.sent} 幀），丟棄 ${serverStats.dropped} 幀` : '等待傳送端';
  const wanTarget = serverStats?.wanTargetKbps ?? wanRateTargetKbps;
  $('metrics').textContent = `接收端呈現約 ${frameRate} FPS；本秒最長畫面回報間隔 ${gap?.toFixed(1) ?? '未知'} ms；瀏覽器丟棄 ${quality?.droppedVideoFrames ?? '未知'} 幀；${remote}；視訊接收緩衝 ${receiverMetrics.videoBufferMs ?? '未知'} ms（目標 ${receiverMetrics.videoTargetMs ?? '未知'}、網路下限 ${receiverMetrics.videoMinimumMs ?? '未知'} ms）${wanTarget ? `；跨區要求流量 ${wanTarget} kbps、近期失包 ${serverStats?.wanLossPercent ?? '未知'}%` : ''}`;
  if (!$('session').hidden) $('inputMetrics').textContent =
    `鍵盤診斷：操作${controlReady && $('control').checked ? '已啟用' : '未啟用'}；` +
    `遠端畫面${document.activeElement === screen ? '已聚焦' : '未聚焦'}；` +
    `Safari 收到 ${keyEventsSeen} 次、轉送 ${keyEventsSent} 次、主機確認 ${keyAcks} 次；` +
    `鍵鼠走${pointerFast ? '控制連線' : '資料通道'}，待送 ${pointerFast ?
      (socket?.bufferedAmount ?? '未知') : (controlChannel?.bufferedAmount ?? '未知')} 位元組` +
      (gamepadActive ? `；手把通道往返 ${gamepadAckRttMs ?? '等待回覆'} ms（不含遊戲反應）` : '');
  $('videoStatus').textContent = stalledMs >= 3000 ?
    `畫面已停住約 ${(stalledMs / 1000).toFixed(1)} 秒；若斷線請重新配對` : '';
  if (peer) metricRows.push([new Date().toISOString(), seconds.toFixed(3), frames,
    frameRate, gap?.toFixed(1) ?? '', stalledMs.toFixed(0),
    quality?.droppedVideoFrames ?? '',
    serverStats?.sent ?? '', serverStats?.dropped ?? '',
    serverStats?.width ?? '', serverStats?.height ?? '',
    receiverMetrics.videoFps ?? '', receiverMetrics.videoBufferMs ?? '',
    receiverMetrics.videoTargetMs ?? '', receiverMetrics.videoMinimumMs ?? '',
    receiverMetrics.audioBufferMs ?? '', receiverMetrics.concealedSamples ?? '',
    clientAudioLost ?? '', clientAudioJitterMs ?? '', audioStats?.underruns ?? '',
    audioStats?.bufferedMs ?? '', audioStats?.droppedSamples ?? '',
    $('control').checked ? 1 : 0, controlReady ? 1 : 0,
    document.activeElement === screen || document.activeElement === $('keyCapture') ? 1 : 0,
    $('lowLatency').checked ? 1 : 0, lowLatencyApplied ? 1 : 0,
    gamepadActive ? 1 : 0, audioPlaybackState === '播放中' ? 1 : 0,
    keyEventsSeen, keyEventsSent, keyAcks,
    latencyState?.version ?? '', latencyState?.enabled ? 1 : 0,
    latencyState?.videoHintNegotiated ? 1 : 0, latencyState?.videoMaxMs ?? '',
    latencyState?.audioQueueLimitMs ?? '', activeSyncMode,
    audioOnDemand ? 1 : 0, receiverMetrics.videoLost ?? '',
    receiverMetrics.videoBitrateKbps ?? '', receiverMetrics.videoDecodeMs ?? '',
    receiverMetrics.rttMs ?? '', screen.paused ? 1 : 0,
    serverStats?.sentFps ?? '', serverStats?.sourceAgeMs ?? '',
    gamepadChannel?.readyState === 'open' ? 1 : 0,
    gamepadSent, gamepadSkipped, gamepadChannel?.bufferedAmount ?? '',
    serverStats?.captureFps ?? '', serverStats?.captureAgeMs ?? '', activeVideoMode,
    receiverMetrics.videoReceived ?? '', receiverMetrics.videoNacks ?? '',
    receiverMetrics.videoPlis ?? '', receiverMetrics.videoKeyframes ?? '',
    receiverMetrics.videoJitterMs ?? '', receiverMetrics.videoRetransmitted ?? '',
    requestedReceiverLatency.video ?? '', requestedReceiverLatency.audio ?? '',
    requestedReceiverLatency.supported ? 1 : 0,
    receiverMetrics.audioMinimumMs ?? '', receiverMetrics.audioTargetMs ?? '',
    pointerFast ? 'websocket' : 'datachannel',
    socket?.readyState === WebSocket.OPEN ? 1 : 0,
    socket?.bufferedAmount ?? '', controlChannel?.bufferedAmount ?? '',
    pointerChannel?.bufferedAmount ?? '', uiTimerLag,
    serverStats?.videoSendMaxMs ?? '', serverStats?.videoInputKbps ?? '',
    serverStats?.wanTargetKbps ?? '', serverStats?.wanLossPercent ?? '',
    serverStats?.videoMaxFrameBytes ?? '', serverStats?.videoKeyframes ?? '',
    serverStats?.videoRecoveryRequests ?? '',
    receiverStatsAt ? Math.round(now - receiverStatsAt) : '',
    gameMouse && mouseModeReady ? 'relative' : 'desktop',
    document.pointerLockElement === screen || nativeMouseLocked ? 1 : 0,
    window.remoteDeskNative?.appVersion || window.remoteDeskNative?.version || 0,
    nativeMouseDiagnostics?.requested === true ? 1 : 0,
    nativeMouseDiagnostics?.available === true ? 1 : 0,
    nativeMouseDiagnostics?.queries ?? '',
    nativeMouseDiagnostics?.sceneWidth ?? '', nativeMouseDiagnostics?.sceneHeight ?? '',
    supportsReceiverLatency('audio') ? 1 : 0, Number($('receiverTarget').value),
    receiverRollbackCount, receiverSafetyBlocked ? 1 : 0,
    receiverLatencyErrors.length, gamepadRedundant, gamepadAckRttMs ?? '',
    gamepadLastAckAt ? Math.round(now - gamepadLastAckAt) : '',
    clientVersion, hostVersion]);
  lastMetric = now; lastPainted = painted; lastQualityCount = frameCount;
  worstGap = 0; worstUiTimerLag = 0;
}, 1000);

setInterval(async () => {
  if (!peer) return;
  try {
    const currentPeer = peer;
    const stats = await currentPeer.getStats();
    if (peer !== currentPeer) return;
    receiverStatsAt = performance.now();
    for (const item of stats.values()) {
      if (item.type === 'candidate-pair' && item.state === 'succeeded' &&
          Number.isFinite(item.currentRoundTripTime)) receiverMetrics.rttMs =
            Math.round(item.currentRoundTripTime * 1000);
      if (item.type !== 'inbound-rtp') continue;
      const kind = item.kind || item.mediaType;
      if (kind === 'video') {
        receiverMetrics.videoReceived = item.packetsReceived ?? null;
        receiverMetrics.videoNacks = item.nackCount ?? null;
        receiverMetrics.videoPlis = item.pliCount ?? null;
        receiverMetrics.videoKeyframes = item.keyFramesDecoded ?? null;
        receiverMetrics.videoRetransmitted = item.retransmittedPacketsReceived ?? null;
        receiverMetrics.videoJitterMs = Number.isFinite(item.jitter) ?
          Math.round(item.jitter * 1000) : null;
        if (Number.isSafeInteger(item.packetsReceived) &&
            Number.isSafeInteger(item.packetsLost) &&
            Number.isSafeInteger(item.nackCount))
          sendSignal({ type: 'network-feedback', received: item.packetsReceived,
            lost: Math.max(0, item.packetsLost), nacks: item.nackCount });
      }
      const old = previousInbound.get(item.id);
      if (old) {
        const emitted = item.jitterBufferEmittedCount - old.jitterBufferEmittedCount;
        const delay = item.jitterBufferDelay - old.jitterBufferDelay;
        receiverMetrics[`${kind}BufferMs`] = emitted > 0 && Number.isFinite(delay) ?
          Math.round(delay * 1000 / emitted) : null;
        const target = item.jitterBufferTargetDelay - old.jitterBufferTargetDelay;
        receiverMetrics[`${kind}TargetMs`] = emitted > 0 && Number.isFinite(target) ?
          Math.round(target * 1000 / emitted) : null;
        const minimum = item.jitterBufferMinimumDelay - old.jitterBufferMinimumDelay;
        receiverMetrics[`${kind}MinimumMs`] = emitted > 0 && Number.isFinite(minimum) ?
          Math.round(minimum * 1000 / emitted) : null;
        if (kind === 'video') {
          const elapsed = item.timestamp - old.timestamp;
          const decoded = item.framesDecoded - old.framesDecoded;
          receiverMetrics.videoLost = item.packetsLost ?? null;
          receiverMetrics.videoBitrateKbps = elapsed > 0 ?
            Math.round((item.bytesReceived - old.bytesReceived) * 8 / elapsed) : null;
          receiverMetrics.videoDecodeMs = decoded > 0 && Number.isFinite(item.totalDecodeTime) ?
            Math.round((item.totalDecodeTime - old.totalDecodeTime) * 1000 / decoded) : null;
          receiverMetrics.videoFps = elapsed > 0 && Number.isFinite(item.framesDecoded) ?
            ((item.framesDecoded - old.framesDecoded) * 1000 / elapsed).toFixed(1) : null;
        }
      }
      if (kind === 'audio') receiverMetrics.concealedSamples = item.concealedSamples ?? null;
      previousInbound.set(item.id, item);
    }
    const audioRtp = [...stats.values()]
      .filter(item => item.type === 'inbound-rtp' &&
        (item.kind === 'audio' || item.mediaType === 'audio'));
    clientAudioPackets = audioRtp.length ?
      audioRtp.reduce((total, item) => total + (item.packetsReceived || 0), 0) : null;
    clientAudioLost = audioRtp.length ?
      audioRtp.reduce((total, item) => total + (item.packetsLost || 0), 0) : null;
    clientAudioJitterMs = audioRtp.length && Number.isFinite(audioRtp[0].jitter) ?
      Math.round(audioRtp[0].jitter * 1000) : null;
    if (latencyState?.enabled) applyReceiverLatency();
  } catch { /* Safari may not expose audio counters. */ }
  if (!$('sound').srcObject) return;
  const level = audioStats ? `${audioStats.levelPercent}%` : '等待主機回報';
  const sent = audioStats?.packetsSent ?? '未知';
  const underruns = audioStats?.underruns ?? '未知';
  const late = audioStats?.lateTicks ?? '未知';
  $('audioStatus').textContent = `${audioPlaybackState}；主機音量 ${level}；音訊重新緩衝 ${underruns} 次；送出 ${sent}、接收 ${clientAudioPackets ?? '未知'}、遺失 ${clientAudioLost ?? '未知'} 個音訊封包；排程延遲 ${late} 次；抖動 ${clientAudioJitterMs ?? '未知'} ms；接收緩衝 ${receiverMetrics.audioBufferMs ?? '未知'} ms；補償樣本 ${receiverMetrics.concealedSamples ?? '未知'}` +
    (audioError ? `；錯誤：${audioError}` : '');
}, 2000);

document.addEventListener('visibilitychange', () => {
  nextGamepadTickAt = performance.now();
  worstUiTimerLag = 0;
  if (document.visibilityState !== 'visible') releaseGamepad();
  if (document.visibilityState === 'visible') {
    lastPresentedCount = null;
    lastPainted = painted;
    lastMetric = performance.now();
    lastFrameTime = 0;
    lastRenderedAt = performance.now();
    worstGap = 0;
  }
});

$('exportMetrics').onclick = () => {
  const rows = [['time_utc', 'sample_seconds', 'rendered_frames', 'rendered_fps',
    'worst_gap_ms', 'stalled_ms', 'browser_dropped_total', 'bridge_sent_total',
    'bridge_dropped_total', 'width', 'height', 'decoded_fps', 'video_jitter_buffer_ms',
    'video_jitter_target_ms', 'video_jitter_minimum_ms',
    'audio_jitter_buffer_ms', 'audio_concealed_samples_total', 'audio_packets_lost_total',
    'audio_jitter_ms', 'audio_rebuffers_total', 'audio_source_buffer_ms',
    'audio_trimmed_samples_total', 'input_opted_in', 'input_enabled',
    'keyboard_focus', 'low_latency_requested', 'low_latency_applied',
    'gamepad_active', 'audio_playing',
    'keyboard_events_seen_total', 'keyboard_events_sent_total',
    'keyboard_acks_total', 'latency_control_version', 'host_low_latency_enabled',
    'video_playout_negotiated', 'video_playout_max_ms', 'audio_queue_limit_ms',
    'sync_mode', 'audio_on_demand', 'video_packets_lost_total',
    'video_bitrate_kbps', 'video_decode_ms', 'rtt_ms', 'video_paused',
    'host_sent_fps', 'host_source_age_ms', 'gamepad_fast_channel',
    'gamepad_sent_total', 'gamepad_skipped_total', 'gamepad_buffered_bytes',
    'host_capture_update_fps', 'host_capture_update_age_ms', 'video_mode',
    'video_packets_received_total', 'video_nack_total', 'video_pli_total',
    'video_keyframes_decoded_total', 'video_jitter_ms',
    'video_retransmitted_packets_total', 'receiver_video_requested_ms',
    'receiver_audio_requested_ms', 'receiver_latency_supported',
    'audio_jitter_minimum_ms', 'audio_jitter_target_ms',
    'input_transport', 'signaling_connected', 'signaling_buffered_bytes',
    'control_dc_buffered_bytes', 'pointer_dc_buffered_bytes',
    'ui_timer_lag_ms', 'host_video_send_max_ms',
    'host_video_input_kbps', 'wan_target_kbps', 'wan_loss_percent',
    'host_video_max_frame_bytes', 'host_video_keyframes_total',
    'host_video_recovery_requests_total', 'receiver_stats_age_ms',
    'mouse_mode', 'mouse_pointer_locked', 'native_app_version', 'native_capture_requested',
    'native_lock_available', 'native_lock_queries', 'native_scene_width', 'native_scene_height',
    'receiver_audio_latency_supported', 'receiver_video_base_ms',
    'receiver_rollback_total', 'receiver_safety_blocked', 'receiver_setting_errors',
    'gamepad_redundant_total', 'gamepad_ack_rtt_ms', 'gamepad_ack_age_ms',
    'client_version', 'host_version'],
    ...metricRows];
  const blob = new Blob([rows.map(row => row.join(',')).join('\r\n') + '\r\n'],
    { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `remotedesk-metrics-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
