import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';
const bridge=resolve(fileURLToPath(new URL('..',import.meta.url)));
const result=resolve(bridge,'test-results');await mkdir(result,{recursive:true});
const other=await selfsigned.generate([{name:'commonName',value:'Unrelated test root'}],{algorithm:'sha256',extensions:[{name:'basicConstraints',cA:true,critical:true}]});
await writeFile(resolve(result,'unrelated-root.crt'),other.cert); // Never persist its private key.
let log='',client;
const server=spawn(process.execPath,['server.mjs','--client=pc','--port=10591','--tcp-port=55591','--no-launch'],{cwd:bridge,windowsHide:true,stdio:['ignore','pipe','pipe']});
server.stdout.on('data',data=>log+=data);server.stderr.on('data',data=>log+=data);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
  const deadline=Date.now()+12000;while(!log.includes('One-time pairing code') && Date.now()<deadline)await pause(100);
  const code=log.match(/One-time pairing code for this server run: (\d{8})/)?.[1];assert.ok(code);
  client=spawn(resolve(bridge,'../out/remote_desk_client.exe'),['--test-url=https://127.0.0.1:10591/',`--test-code=${code}`,
    `--test-ca=${resolve(result,'unrelated-root.crt')}`,'--test-seconds=3','--test-no-audio',
    `--test-report=${resolve(result,'pc-tls.json')}`,`--settings=${resolve(result,'pc-tls-settings.json')}`],{cwd:bridge,windowsHide:true,stdio:'ignore'});
  const exit=once(client,'exit');const timeout=setTimeout(()=>client.kill(),10000);const [status]=await exit;clearTimeout(timeout);assert.equal(status,0);
  const report=JSON.parse(await readFile(resolve(result,'pc-tls.json'),'utf8'));
  assert.ok(report.status.includes('verification failed'),JSON.stringify(report));
  assert.equal(report.received_frames,0);assert.equal(report.audio_packets,0);
  assert.ok(!log.includes('pc native app paired'),'Pairing secret sent before CA verification');
  console.log('PASS: real HTTPS server with unrelated valid CA rejected before pairing; no capture or inputs.');
}finally{
  if(client?.exitCode===null && client.signalCode===null)client.kill();
  if(server.exitCode===null && server.signalCode===null){const exited=once(server,'exit');server.kill();await exited;}
}
