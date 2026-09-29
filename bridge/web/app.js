const $ = id => document.getElementById(id);
const status = text => { $('status').textContent = text; };
const sendSignal = message => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));
let socket, peer, controlChannel;
let canControl = false;
let canGamepad = false;
let controlReady = false;
let gamepadRequested = false;
let gamepadActive = false;
let lowLatencyApplied = false;
let latencyControlAvailable = false;
let latencyState = null;
let latencyPendingTimer = null;
let activeSyncMode = 'unknown';
let audioOnDemand = false;
let pendingF5 = false;
let keyEventsSeen = 0, keyEventsSent = 0, keyAcks = 0;
let candidates = [];
let painted = 0, lastPainted = 0, lastMetric = performance.now();
let lastFrameTime = 0, worstGap = 0;
let serverStats = null;
let lastQualityCount = 0;
let lastRenderedAt = 0;
const metricRows = [];
let audioStats = null;
let clientAudioPackets = null;
let clientAudioLost = null;
let clientAudioJitterMs = null;
let audioPlaybackState = '尚未播放';
let audioError = '';
let receiverMetrics = {};
let previousInbound = new Map();
let lastPresentedCount = null;
const downKeys = new Set();
const downButtons = new Set();

function sendInput(value) {
  if (controlReady && $('control').checked) sendInputRaw(value);
}
function sendInputRaw(value) {
  if (canControl) {
    if (controlChannel?.readyState === 'open') controlChannel.send(JSON.stringify(value));
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
  releaseInputs();
  releaseGamepad();
  screenViewport.classList.remove('zoomed');
  $('zoomScreen').setAttribute('aria-pressed', 'false');
  $('zoomScreen').textContent = '放大文字 150%';
  $('panScreen').hidden = true;
  setPanScreen(false);
  $('control').checked = false;
  canControl = false;
  controlReady = false;
  gamepadRequested = false;
  gamepadActive = false;
  updateGamepadButton();
  pendingF5 = false;
  pendingWin = false;
  controlChannel?.close(); controlChannel = null;
  peer?.close(); peer = null;
  socket?.close(); socket = null;
  $('screen').srcObject = null;
  $('sound').srcObject = null;
  $('playAudio').disabled = true;
  $('lowLatency').checked = false;
  $('lowLatency').disabled = true;
  clearTimeout(latencyPendingTimer);
  latencyPendingTimer = null;
  latencyControlAvailable = false;
  latencyState = null;
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
    activeSyncMode = message.syncMode || 'unknown';
    audioOnDemand = message.audioOnDemand === true;
    $('playAudio').textContent = '播放聲音';
    $('syncStatus').textContent = !message.syncMode ?
      '主機尚未更新；請重新啟動 bridge，才能使用即時操作模式。' :
      message.syncMode === 'interactive' ?
      '即時操作：畫面獨立播放，不等待音訊追齊；網路波動時聲畫可能暫時不同步。' :
      '影音同步：畫面可能等待音訊；要優先操作反應，斷線後選「即時操作」。';
    canControl = message.inputEnabled;
    canGamepad = message.gamepadEnabled;
    gamepadRequested = false;
    gamepadActive = false;
    updateGamepadButton();
    gamepadHostStatus = '';
    lastGamepadState = '';
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
    $('lowLatency').disabled = !latencyControlAvailable;
    clearTimeout(latencyPendingTimer);
    latencyPendingTimer = null;
    latencyState = null;
    lowLatencyApplied = false;
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
    lowLatencyApplied = message.enabled && message.applied;
    $('lowLatency').checked = message.enabled;
    $('lowLatency').disabled = !latencyControlAvailable;
    const audioLimit = message.audioQueueLimitMs;
    $('latencyStatus').textContent = !latencyControlAvailable ?
      '主機尚未更新；請重新啟動 bridge 後再調整音訊排隊。' :
      audioLimit === null ? '主機音訊未啟動。' :
      `主機音訊排隊上限：${audioLimit} ms；此項僅處理主機音訊積壓，不控制視訊或接收端緩衝。`;
  } else if (message.type === 'control-state') {
    controlReady = message.enabled;
    if (!message.enabled) {
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
    else status('遠端操作已停止，按鍵與滑鼠已釋放');
  } else if (message.type === 'input-ack') {
    keyAcks++;
    $('inputStatus').textContent = message.accepted ?
      `主機橋接已收到：${message.code} ${message.down ? '按下' : '放開'}` :
      `Safari 送出 ${message.code}，但主機不支援這個鍵碼`;
  } else if (message.type === 'gamepad-status') {
    gamepadHostStatus = message.text;
    $('gamepadHostStatus').textContent = `Windows 手把：${message.text}`;
  } else if (message.type === 'gamepad-state') {
    gamepadActive = message.enabled;
    gamepadRequested = message.enabled;
    gamepadHostStatus = message.text;
    updateGamepadButton();
    $('gamepadHostStatus').textContent = `Windows 手把：${message.text}`;
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
          return;
        }
        $('screen').srcObject = new MediaStream([event.track]);
        $('screen').play().catch(() => status('請按「播放畫面」'));
        event.track.onmute = () => status('視訊已暫停');
        event.track.onunmute = () => status('畫面已接收');
      };
      peer.ondatachannel = event => {
        if (event.channel.label === 'control') controlChannel = event.channel;
      };
      peer.onicecandidate = event => {
        if (event.candidate) sendSignal({ type: 'candidate', candidate: event.candidate.candidate,
          mid: event.candidate.sdpMid });
      };
      peer.onconnectionstatechange = () => status(`WebRTC: ${peer.connectionState}`);
    }
    await peer.setRemoteDescription({ type: message.descriptionType, sdp: message.sdp });
    for (const candidate of candidates.splice(0)) await peer.addIceCandidate(candidate);
    await peer.setLocalDescription(await peer.createAnswer());
    sendSignal({ type: 'description', descriptionType: peer.localDescription.type,
      sdp: peer.localDescription.sdp });
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
  socket.onopen = () => {
    sendSignal({ type: 'pair', code,
      syncMode: $('syncMode').value, audioOnDemand: true,
      videoMode: $('videoMode').value });
  };
  socket.onmessage = async event => {
    try { await handleSignal(JSON.parse(event.data)); }
    catch (error) { status(`連線錯誤：${error.message}`); }
  };
  socket.onerror = () => status('無法連線到電腦');
  socket.onclose = event => {
    $('connect').disabled = false;
    if (peer || !$('session').hidden) stop(`已斷線：${event.reason || '連線中斷'}；請重新連線`);
  };
};
$('disconnect').onclick = () => stop();
$('play').onclick = () => $('screen').play().catch(error => status(error.message));
const screenViewport = $('screenViewport');
let panScreen = false;
let panStart = null;
function updateDisplayStatus() {
  const video = $('screen');
  const width = video.videoWidth || serverStats?.width;
  const height = video.videoHeight || serverStats?.height;
  const source = width && height ? `${width}×${height}` : '等待畫面解析度';
  $('displayStatus').textContent = `${source}；${screenViewport.classList.contains('zoomed') ?
    '文字放大 150%，可按「移動畫面」拖曳視野' : '完整畫面'}。放大只改變檢視大小，不改變傳送解析度。`;
}
function setPanScreen(enabled) {
  panScreen = enabled;
  panStart = null;
  $('panScreen').setAttribute('aria-pressed', String(enabled));
  $('panScreen').textContent = enabled ? '返回遠端操作' : '移動畫面';
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
  if (enableControlForAction()) $('typing').focus();
};
$('focusKeys').onclick = () => {
  if (enableControlForAction()) $('keyCapture').focus();
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
});
function applyLatencyTarget() {
  const requested = $('lowLatency').checked;
  if (!latencyControlAvailable || socket?.readyState !== WebSocket.OPEN) {
    $('lowLatency').checked = latencyState?.enabled ?? false;
    $('latencyStatus').textContent = '主機尚未連線或不支援；請重新啟動新版 bridge 後配對。';
    return;
  }
  $('lowLatency').disabled = true;
  $('latencyStatus').textContent = '正在等候主機確認音訊排隊設定…';
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
screen.onpointermove = event => {
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
    if (pendingPointer) sendInput({ type: 'move', ...pendingPointer });
    pendingPointer = null;
  });
};
screen.onpointerdown = event => {
  if (panScreen) {
    screen.setPointerCapture(event.pointerId);
    panStart = { x: event.clientX, y: event.clientY,
      scrollLeft: screenViewport.scrollLeft, scrollTop: screenViewport.scrollTop };
    return;
  }
  if (!controlReady || !$('control').checked) return;
  screen.setPointerCapture(event.pointerId);
  screen.focus();
  sendInput({ type: 'move', ...pointerPosition(event) });
  const button = event.pointerType === 'touch' ? 0 : event.button;
  if (button <= 2) { downButtons.add(button); sendInput({ type: 'button', button, down: true }); }
};
screen.onpointerup = event => {
  if (panScreen) { panStart = null; return; }
  const button = event.pointerType === 'touch' ? 0 : event.button;
  if (downButtons.has(button)) {
    sendInput({ type: 'button', button, down: false });
    downButtons.delete(button);
  }
};
screen.onpointercancel = () => { panStart = null; releaseInputs(); };
screen.addEventListener('wheel', event => {
  if (!controlReady || !$('control').checked) return;
  event.preventDefault();
  if (event.deltaY) sendInput({ type: 'wheel', delta: event.deltaY > 0 ? -120 : 120 });
}, { passive: false });
screen.oncontextmenu = event => event.preventDefault();
window.onblur = () => { releaseInputs(); releaseGamepad(); };
function keyCodeFromEvent(event) {
  if (event.code && event.code !== 'Unidentified' && event.code !== 'Process') return event.code;
  const key = event.key;
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (key === ' ') return 'Space';
  if (['Meta', 'OS', 'Win', 'Command', 'Super'].includes(key)) return 'MetaLeft';
  return { Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp',
    Down: 'ArrowDown', Esc: 'Escape' }[key] || key;
}
document.onkeydown = event => {
  const code = keyCodeFromEvent(event);
  const capture = document.activeElement === screen ||
    document.activeElement === $('keyCapture');
  const functionKey = /^F(?:[1-9]|1[0-2])$/.test(code);
  if (capture) keyEventsSeen++;
  if (document.activeElement === $('keyCapture')) {
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
  const code = keyCodeFromEvent(event);
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
const standardButtonNames = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT',
  'View', 'Menu', '左搖桿', '右搖桿', '上', '下', '左', '右', 'Xbox'];
const neutralGamepad = () => ({ type: 'gamepad', buttons: Array(17).fill(0), axes: [0, 0, 0, 0] });
function releaseGamepad() {
  if (lastGamepadState && gamepadActive && controlReady) sendInputRaw(neutralGamepad());
  lastGamepadState = '';
  lastGamepadAt = 0;
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
  let pad = null;
  try { pad = navigator.getGamepads?.().find(Boolean) ?? null; } catch {}
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
      sendInput(state);
      lastGamepadState = serialized;
      lastGamepadAt = now;
    }
  } else if (lastGamepadState) {
    releaseGamepad();
  }
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
  requestAnimationFrame(pollGamepad);
}
requestAnimationFrame(pollGamepad);

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
  const gap = 'requestVideoFrameCallback' in screen && lastFrameTime ? worstGap : null;
  const remote = serverStats ? `${serverStats.width}×${serverStats.height}，主機送出約 ${serverStats.sentFps ?? '未知'} FPS（累計 ${serverStats.sent} 幀），丟棄 ${serverStats.dropped} 幀` : '等待傳送端';
  $('metrics').textContent = `接收端呈現約 ${frameRate} FPS；本秒最長畫面回報間隔 ${gap?.toFixed(1) ?? '未知'} ms；瀏覽器丟棄 ${quality?.droppedVideoFrames ?? '未知'} 幀；${remote}；視訊接收緩衝 ${receiverMetrics.videoBufferMs ?? '未知'} ms（目標 ${receiverMetrics.videoTargetMs ?? '未知'}、網路下限 ${receiverMetrics.videoMinimumMs ?? '未知'} ms）`;
  if (!$('session').hidden) $('inputMetrics').textContent =
    `鍵盤診斷：操作${controlReady && $('control').checked ? '已啟用' : '未啟用'}；` +
    `輸入區${document.activeElement === $('keyCapture') ? '已聚焦' : '未聚焦'}；` +
    `Safari 收到 ${keyEventsSeen} 次、轉送 ${keyEventsSent} 次、主機確認 ${keyAcks} 次`;
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
    document.activeElement === $('keyCapture') ? 1 : 0,
    $('lowLatency').checked ? 1 : 0, lowLatencyApplied ? 1 : 0,
    gamepadActive ? 1 : 0, audioPlaybackState === '播放中' ? 1 : 0,
    keyEventsSeen, keyEventsSent, keyAcks,
    latencyState?.version ?? '', latencyState?.enabled ? 1 : 0,
    latencyState?.videoHintNegotiated ? 1 : 0, latencyState?.videoMaxMs ?? '',
    latencyState?.audioQueueLimitMs ?? '', activeSyncMode,
    audioOnDemand ? 1 : 0, receiverMetrics.videoLost ?? '',
    receiverMetrics.videoBitrateKbps ?? '', receiverMetrics.videoDecodeMs ?? '',
    receiverMetrics.rttMs ?? '', screen.paused ? 1 : 0,
    serverStats?.sentFps ?? '', serverStats?.sourceAgeMs ?? '']);
  lastMetric = now; lastPainted = painted; lastQualityCount = frameCount; worstGap = 0;
}, 1000);

setInterval(async () => {
  if (!peer) return;
  try {
    const currentPeer = peer;
    const stats = await currentPeer.getStats();
    if (peer !== currentPeer) return;
    for (const item of stats.values()) {
      if (item.type === 'candidate-pair' && item.state === 'succeeded' &&
          Number.isFinite(item.currentRoundTripTime)) receiverMetrics.rttMs =
            Math.round(item.currentRoundTripTime * 1000);
      if (item.type !== 'inbound-rtp') continue;
      const kind = item.kind || item.mediaType;
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
    'host_sent_fps', 'host_source_age_ms'], ...metricRows];
  const blob = new Blob([rows.map(row => row.join(',')).join('\r\n') + '\r\n'],
    { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `remotedesk-metrics-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
