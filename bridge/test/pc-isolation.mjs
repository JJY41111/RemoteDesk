import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import WebSocket from 'ws';
const bridge=resolve(fileURLToPath(new URL('..',import.meta.url)));
const services=[],sockets=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function start(client,port,tcp){
  const child=spawn(process.execPath,['server.mjs',`--client=${client}`,`--port=${port}`,`--tcp-port=${tcp}`,'--no-launch'],
    {cwd:bridge,windowsHide:true,stdio:['ignore','pipe','pipe']});
  services.push(child);let log='';child.stdout.on('data',data=>log+=data);child.stderr.on('data',data=>log+=data);
  const deadline=Date.now()+12000;while(!log.includes('One-time pairing code') && Date.now()<deadline)await pause(100);
  const code=log.match(/One-time pairing code for this server run: (\d{8})/)?.[1];assert.ok(code,'Service did not start');
  return {child,port,code,client};
}
function get(port){return new Promise((resolve,reject)=>{
  https.get({hostname:'127.0.0.1',port,path:'/',rejectUnauthorized:false},response=>{response.resume();resolve({status:response.statusCode,location:response.headers.location});}).on('error',reject);
});}
async function paired(service){
  const ws=new WebSocket(`wss://127.0.0.1:${service.port}/signal`,{rejectUnauthorized:false,
    headers:{'x-remotedesk-client':`${service.client}-native-v1`}});
  sockets.push(ws);await once(ws,'open');
  const response=new Promise(resolve=>ws.on('message',data=>{const message=JSON.parse(String(data));if(message.type==='paired')resolve(message);}));
  ws.send(JSON.stringify({type:'pair',code:service.code,clientType:service.client,videoMode:'1080p'}));await response;return ws;
}
try{
  const ipad=await start('ipad',10571,55571),pc=await start('pc',10581,55581);
  assert.equal((await get(ipad.port)).status,200);
  assert.deepEqual(await get(pc.port),{status:302,location:'/?client=pc'});
  const ipadSocket=await paired(ipad),pcSocket=await paired(pc);
  const pcClosed=once(pc.child,'exit');pc.child.kill();await pcClosed;
  await pause(300);assert.equal(ipadSocket.readyState,WebSocket.OPEN);
  const response=new Promise(resolve=>ipadSocket.on('message',data=>{const value=JSON.parse(String(data));if(value.type==='latency-state' && value.enabled)resolve(value);}));
  ipadSocket.send(JSON.stringify({type:'set-latency',enabled:true}));
  assert.equal((await Promise.race([response,pause(3000).then(()=>{throw new Error('iPad service stopped responding');})])).enabled,true);
  assert.equal((await get(ipad.port)).status,200);
  assert.notEqual(pcSocket.readyState,WebSocket.OPEN);
  console.log('PASS: distinct paired PC/iPad services; stopping PC leaves iPad WebSocket and settings control responsive (no capture/input).');
}finally{
  for(const ws of sockets)ws.terminate();
  for(const child of services)if(child.exitCode===null && child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
}
