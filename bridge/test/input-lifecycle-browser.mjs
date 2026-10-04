import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';

const bridge = resolve(fileURLToPath(new URL('..', import.meta.url)));
const child = spawn(process.execPath, ['server.mjs', '--host=127.0.0.1',
  '--port=19553', '--tcp-port=19554', '--enable-input', '--no-launch',
  '--display=0:0'], { cwd: bridge, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let output = '';
child.stdout.on('data', chunk => { output += String(chunk); });
child.stderr.on('data', chunk => { output += String(chunk); });
let ws;
const delay = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
try {
  const started = Date.now();
  while (!/One-time pairing code for this server run: (\d{8})/.test(output)) {
    if (child.exitCode !== null) throw new Error(`Bridge exited: ${output}`);
    if (Date.now() - started > 10000) throw new Error(`Bridge did not start: ${output}`);
    await delay(50);
  }
  const code = output.match(/One-time pairing code for this server run: (\d{8})/)[1];
  ws = new WebSocket('wss://127.0.0.1:19553/signal', {
    rejectUnauthorized: false, origin: 'https://127.0.0.1:19553' });
  const messages = [];
  ws.on('message', chunk => messages.push(JSON.parse(String(chunk))));
  await new Promise((resolveOpen, rejectOpen) => {
    ws.once('open', resolveOpen);
    ws.once('error', rejectOpen);
  });
  ws.send(JSON.stringify({ type: 'pair', code, syncMode: 'interactive',
    audioOnDemand: true, videoMode: '1080p' }));
  const pairedAt = Date.now();
  while (!messages.some(message => message.type === 'paired')) {
    if (Date.now() - pairedAt > 5000) throw new Error(`Pair failed: ${JSON.stringify(messages)}`);
    await delay(20);
  }
  ws.send(JSON.stringify({ type: 'set-control', enabled: true }));
  const enabledAt = Date.now();
  while (!messages.some(message => message.type === 'control-state' && message.enabled)) {
    if (Date.now() - enabledAt > 5000)
      throw new Error(`Input helper never became ready: ${JSON.stringify(messages)} ${output}`);
    await delay(20);
  }
  if (!output.includes('Remote input helper ready'))
    throw new Error(`Server confirmed control without READY: ${output}`);
  const sentAt = new Map(), latencies = [];
  ws.on('message', chunk => {
    const message = JSON.parse(String(chunk));
    if (message.type !== 'input-ack' || !sentAt.has(message.code)) return;
    if (message.accepted) throw new Error('Diagnostic keys must not inject OS input');
    latencies.push(performance.now() - sentAt.get(message.code));
    sentAt.delete(message.code);
  });
  for (let i = 0; i < 200; i++) {
    const code = `RemoteDeskDiagnostic${i}`;
    sentAt.set(code, performance.now());
    ws.send(JSON.stringify({ type: 'control', input: { type: 'key', code, down: true } }));
    await delay(5);
  }
  const ackDeadline = Date.now() + 5000;
  while (latencies.length !== 200 && Date.now() < ackDeadline) await delay(10);
  if (latencies.length !== 200) throw new Error(`Only ${latencies.length}/200 input acknowledgements`);
  latencies.sort((a, b) => a - b);
  const diagnostic = { scope: 'Local signaling dispatch only; no OS input or game response',
    count: latencies.length, medianMs: latencies[100], p95Ms: latencies[189], maxMs: latencies[199] };
  await writeFile(new URL('../test-results/input-dispatch.json', import.meta.url), JSON.stringify(diagnostic, null, 2));
  console.log(JSON.stringify(diagnostic));
  console.log('Isolated pairing and input helper readiness passed');
} finally {
  ws?.close();
  child.kill();
}
