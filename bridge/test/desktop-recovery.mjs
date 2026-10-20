import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const bridge=resolve(fileURLToPath(new URL('..',import.meta.url))),project=resolve(bridge,'..');
const client=process.env.RECOVERY_CLIENT || 'pc';
const build=process.env.RECOVERY_BUILD || 'out/recovery-2026-10-15';
assert.ok(['pc','ipad'].includes(client));
const port=client==='pc'?10661:10662,tcpPort=client==='pc'?55661:55662;
const server=spawn(process.execPath,['server.mjs',`--client=${client}`,`--port=${port}`,`--tcp-port=${tcpPort}`],{
  cwd:bridge,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,
    REMOTEDESK_CAPTURE_EXE:resolve(project,build,'remote_desk.exe'),
    REMOTEDESK_INPUT_EXE:resolve(project,build,'remote_desk_input.exe'),REMOTEDESK_TEST_CAPTURE_RECOVERY:'1'}});
let output='',browser;const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
server.stdout.on('data',data=>output+=data);server.stderr.on('data',data=>output+=data);
try{
  const deadline=Date.now()+15000;while(!output.includes('One-time pairing code') && Date.now()<deadline)await pause(100);
  const code=output.match(/One-time pairing code for this server run: (\d{8})/)?.[1];assert.ok(code,'Test service failed to start');
  browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const page=await browser.newPage({ignoreHTTPSErrors:true});
  await page.goto(`https://127.0.0.1:${port}/?client=${client}`);
  await page.evaluate(()=>{window.recoveryEvents=[];const original=handleSignal;handleSignal=async message=>{
    if(message.type==='capture-state')window.recoveryEvents.push({...message,at:performance.now()});return original(message);};});
  await page.locator('#code').fill(code);await page.locator('#connect').click();
  await page.waitForFunction(()=>window.recoveryEvents.some(event=>event.paused===true),null,{timeout:15000});
  assert.ok((await page.locator('#hostNotice').textContent()).includes('權限提示'));
  await page.waitForFunction(()=>window.recoveryEvents.some(event=>event.paused===false),null,{timeout:15000});
  assert.ok(await page.evaluate(()=>window.recoveryEvents[1].at-window.recoveryEvents[0].at>=6000));
  await page.waitForFunction(()=>document.querySelector('#screen').webkitDecodedFrameCount>180,null,{timeout:15000});
  await page.waitForFunction(()=>serverStats?.videoKeyframes>=2,null,{timeout:5000});
  assert.equal(await page.evaluate(()=>peer.connectionState),'connected');
  assert.equal(await page.locator('#hostNotice').isHidden(),true);
  await page.locator('#screen').screenshot({path:resolve(bridge,`test-results/desktop-recovery-${client}.png`)});
  const visible=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=96;canvas.height=54;
    const context=canvas.getContext('2d');context.drawImage(document.querySelector('#screen'),0,0,96,54);
    const pixels=context.getImageData(0,0,96,54).data;let count=0;
    for(let i=0;i<pixels.length;i+=4)if(Math.max(pixels[i],pixels[i+1],pixels[i+2])>24)count++;
    return count/(96*54);
  });
  assert.ok(visible>0.01,'Recovered stream is visually black; inspect saved screenshot');
  const captureLog = await readFile(client === 'pc' ? resolve(bridge,'private/pc/capture/runtime.log') : resolve(project,'runtime.log'),'utf8');
  assert.ok(captureLog.includes('simulated AcquireNextFrame INVALID_CALL'), 'Exact UAC error must be injected');
  assert.ok(captureLog.includes('pointer overlay unavailable; error=') && captureLog.includes('(injected test failure)'),
    'Cursor failure must be injected while video remains connected');
  await page.evaluate(()=>stop());
  console.log(`PASS: ${client} capture loss >6s -> pause notice -> recreate -> decoded frames, same WebRTC session (injected loss, not real UAC).`);
}finally{
  await browser?.close();
  if(server.exitCode===null && server.signalCode===null){const exit=once(server,'exit');server.kill();await exit;}
  await writeFile(resolve(bridge,`test-results/desktop-recovery-${client}.log`),output);
}
