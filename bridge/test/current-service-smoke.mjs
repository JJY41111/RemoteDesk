import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const state=JSON.parse(await readFile(new URL('../private/pairing-state-9443.json',import.meta.url),'utf8'));
const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
try {
  const page=await browser.newPage({ignoreHTTPSErrors:true});
  await page.goto(`https://${state.host}:${state.port}/`);
  await page.locator('#code').fill(state.code);
  await page.locator('#connect').click();
  await page.waitForFunction(()=>document.querySelector('#screen').webkitDecodedFrameCount>120,null,{timeout:20000});
  const result=await page.evaluate(()=>({hostVersion,clientVersion,connection:peer.connectionState,
    decoded:screen.webkitDecodedFrameCount,controlRequested:$('control').checked,
    capturePaused:hostCapturePaused,inputBlocked:hostInputBlocked,
    rttBackoffEnabled:serverStats?.wanRttBackoffEnabled,
    privilege:document.querySelector('#systemHostStatus')?.textContent}));
  assert.equal(result.hostVersion,'2026-10-17.1');
  assert.match(result.privilege,/高權限助手已連接/);
  assert.equal(result.connection,'connected');
  assert.equal(result.controlRequested,false);
  assert.equal(result.capturePaused,false);
  assert.equal(result.rttBackoffEnabled,true);
  await page.evaluate(()=>stop());
  await writeFile(new URL('../test-results/current-service-smoke.json',import.meta.url),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
  console.log('PASS: updated production stream decoded; no remote mouse/keyboard input or real UAC tested.');
} finally { await browser.close(); }
