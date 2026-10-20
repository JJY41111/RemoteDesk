import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const bridge = resolve(fileURLToPath(new URL('..', import.meta.url)));
const server = spawn(process.execPath, ['server.mjs', '--port=8468', '--tcp-port=55468', '--no-launch', '--enable-input'], {cwd:bridge,windowsHide:true,stdio:['ignore','pipe','pipe']});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let output='', browser, actor, initial;
server.stdout.on('data', data => { output += data; });
server.stderr.on('data', data => { output += data; });
let page;
async function state() {return page.evaluate(() => $('capsLockStatus').textContent.includes('大寫：開'));}
async function waitState(value) {await page.waitForFunction(value => document.querySelector('#capsLockStatus').textContent.includes(value ? '大寫：開' : '大寫：關'),value);}
try {
  const deadline=Date.now()+12000;
  while (!output.includes('One-time pairing code') && Date.now()<deadline) await pause(100);
  const code=output.match(/One-time pairing code for this server run: (\d{8})/)?.[1];
  if (!code) throw new Error('Isolated service did not start');
  browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  page=await browser.newPage({ignoreHTTPSErrors:true});
  await page.goto('https://127.0.0.1:8468/');
  await page.locator('#code').fill(code); await page.locator('#connect').click();
  await page.locator('#session').waitFor({state:'visible'});
  await page.locator('#menuToggle').click();
  await page.locator('#control').check();
  await page.waitForFunction(() => /大寫：[開關]/.test(document.querySelector('#capsLockStatus').textContent));
  initial=await state();
  await page.locator('#focusKeys').click();
  await page.keyboard.press('CapsLock');
  await waitState(!initial);
  await page.locator('#menuToggle').click();
  await page.locator('#remoteCapsLock').click();
  await waitState(initial);
  actor=spawn(resolve(bridge,'../out/remote_desk_input.exe'),[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  await pause(200);
  actor.stdin.write('K 20 1\nK 20 0\n');
  await waitState(!initial);
  actor.stdin.write('K 20 1\nK 20 0\n');
  await waitState(initial);
  await pause(1000);
  if ((output.match(/Remote input helper ready/g)||[]).length !== 1) throw new Error('READY was processed more than once');
  await page.evaluate(() => stop());
  if (!(await page.locator('#capsLockStatus').textContent()).includes('等待主機回報')) throw new Error('Stale Caps Lock state after disconnect');
  console.log('PASS: isolated browser key -> Windows Caps Lock -> tools state; button, external toggle, READY once, disconnect reset');
} finally {
  if (initial !== undefined) {
    actor ??= spawn(resolve(bridge,'../out/remote_desk_input.exe'),[],
      {windowsHide:true,stdio:['pipe','pipe','pipe']});
    await pause(100);
    const actual = await new Promise((resolveState, reject) => {
      let text = '';
      const timer = setTimeout(() => { actor.stdout.off('data', onData); reject(new Error('State restore query timed out')); }, 2000);
      const onData = chunk => {
        text += chunk;
        const match = text.match(/CAPS ([01])\r?\n/);
        if (match) { clearTimeout(timer); actor.stdout.off('data', onData); resolveState(match[1] === '1'); }
      };
      actor.stdout.on('data', onData);
      actor.stdin.write('C\n');
    }).catch(error => { console.error(error.message); return undefined; });
    if (actual !== undefined && actual !== initial) {
      actor.stdin.write('K 20 1\nK 20 0\n'); await pause(150);
    }
  }
  actor?.stdin.end();
  await browser?.close();
  server.kill();
  await once(server,'exit').catch(()=>{});
}
