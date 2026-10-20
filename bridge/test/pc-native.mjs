import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const bridge=resolve(fileURLToPath(new URL('..',import.meta.url)));
const project=resolve(bridge,'..');
const decodeDelay=Number(process.env.NATIVE_DECODE_DELAY_MS || 0);
assert.ok(Number.isInteger(decodeDelay) && decodeDelay>=0 && decodeDelay<=200);
await mkdir(resolve(bridge,'test-results'),{recursive:true});
const server=spawn(process.execPath,['server.mjs','--client=pc','--port=10561','--tcp-port=55561','--audio'],
  {cwd:bridge,windowsHide:true,stdio:['ignore','pipe','pipe']});
let output='',client;
server.stdout.on('data',chunk=>output+=chunk);server.stderr.on('data',chunk=>output+=chunk);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
  const deadline=Date.now()+15000;
  while(!output.includes('One-time pairing code') && Date.now()<deadline)await pause(100);
  const code=output.match(/One-time pairing code for this server run: (\d{8})/)?.[1];
  assert.ok(code,'Isolated PC server did not start: '+output);
  client=spawn(resolve(project,'out/remote_desk_client.exe'),[
    '--test-url=https://127.0.0.1:10561/',`--test-code=${code}`,
    ...(process.env.NATIVE_MOUSE_REPAINT === '1' ? ['--test-mouse-repaint'] : []),
    ...(decodeDelay ? [`--test-decode-delay-ms=${decodeDelay}`] : []),
    `--test-ca=${resolve(bridge,'private/ca.crt')}`,'--test-seconds=15','--test-no-audio',
    `--test-report=${resolve(bridge,'test-results/pc-native.json')}`,
    `--test-screenshot=${resolve(bridge,'test-results/pc-native.png')}`,
    `--settings=${resolve(bridge,'test-results/pc-native-settings.json')}`],
    {cwd:project,windowsHide:true,stdio:'ignore'});
  const exited=once(client,'exit');
  const timeout=setTimeout(()=>client.kill(),25000);
  const [exit]=await exited;clearTimeout(timeout);
  await writeFile(resolve(bridge,'test-results/pc-native-server.log'),output);
  assert.equal(exit,0,'Native client failed');
  const report=JSON.parse(await readFile(resolve(bridge,'test-results/pc-native.json'),'utf8'));
  assert.ok(report.received_frames>30,'No WebRTC H.264 frames: '+JSON.stringify(report));
  assert.ok(report.decoded_frames>30,'No native decoded frames: '+JSON.stringify(report));
  if(decodeDelay===40)assert.ok(report.decoded_frames>60,'Moderately slow decoder collapsed into keyframe-only delivery: '+JSON.stringify(report));
  assert.ok(report.offscreen_renders>0,'No native offscreen render');
  assert.ok(report.buffered_presents>0,'No buffered video presentation');
  assert.equal(report.presentation,'GDI double buffer');
  assert.equal(report.present_failures,0,'Video presentation fell back to direct painting');
  if(process.env.NATIVE_MOUSE_REPAINT === '1')assert.ok(report.simulated_mouse_moves>100,'Mouse-message repaint stress was not exercised');
  assert.ok(report.audio_packets>20,'No native Opus decode');
  if(process.env.REMOTEDESK_TEST_CAPTURE_RECOVERY==='1'){
    assert.equal(report.host_capture_pauses,1,'Native client missed the capture pause notice');
    assert.equal(report.host_capture_resumes,1,'Native client missed the capture resume notice');
  }
  const settings=await readFile(resolve(bridge,'test-results/pc-native-settings.json'),'utf8');
  assert.ok(!settings.includes(code),'Pairing code persisted');
  const tlsFailure=spawn(resolve(project,'out/remote_desk_client.exe'),[
    '--test-url=https://127.0.0.1:10561/',`--test-code=${code}`,
    `--test-ca=${resolve(bridge,'test-results/nonexistent-ca.crt')}`,'--test-seconds=3','--test-no-audio',
    `--test-report=${resolve(bridge,'test-results/pc-native-tls-rejection.json')}`,
    `--settings=${resolve(bridge,'test-results/pc-native-tls-settings.json')}`],{cwd:project,windowsHide:true,stdio:'ignore'});
  const tlsExit=once(tlsFailure,'exit');const tlsTimeout=setTimeout(()=>tlsFailure.kill(),10000);
  const [tlsCode]=await tlsExit;clearTimeout(tlsTimeout);assert.equal(tlsCode,0);
  const rejected=JSON.parse(await readFile(resolve(bridge,'test-results/pc-native-tls-rejection.json'),'utf8'));
  assert.equal(rejected.received_frames,0);assert.ok(rejected.status.includes('CA certificate'));
  console.log('PASS: native WinHTTP/private CA -> WebRTC H.264 -> MF decode -> offscreen render; invalid CA rejected; Opus decoded with output muted; no input injected.');
  console.log(JSON.stringify(report));
}finally{
  client?.kill();
  server.kill();
  if(server.exitCode===null)await once(server,'exit');
}
