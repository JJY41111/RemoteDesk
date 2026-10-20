import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { localTailnetIPv4 } from '../tailnet-address.mjs';

// Isolated pairing / settings / real CSV export only. No capture, input, audio,
// gamepad, or production-service restart is requested.
const bridge = resolve(fileURLToPath(new URL('..', import.meta.url)));
const host = localTailnetIPv4()[0];
assert.ok(host, 'This integration test requires an active local Tailscale address');
const browser = await chromium.launch({ headless: true,
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
try {
  for (const [index, setting] of [undefined, 'on', 'off'].entries()) {
    const environment = { ...process.env };
    if (setting === undefined) delete environment.RTT_CONTROL;
    else environment.RTT_CONTROL = setting;
    const port = 10931 + index * 2;
    const server = spawn(process.execPath, ['server.mjs', '--no-launch', '--tailnet',
      `--host=${host}`, `--port=${port}`, `--tcp-port=${55931 + index}`],
    { cwd: bridge, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    server.stdout.on('data', data => log += data);
    server.stderr.on('data', data => log += data);
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const deadline = Date.now() + 15000;
      while (!log.includes('One-time pairing code') && Date.now() < deadline && server.exitCode === null)
        await new Promise(done => setTimeout(done, 100));
      const code = log.match(/One-time pairing code for this server run: (\d{8})/)?.[1];
      assert.ok(code, log);
      assert.match(log, /Program version: .*commit=[a-f0-9]{12}(?:-dirty)?; RTT_CONTROL=(on|off)/);
      const page = await context.newPage();
      await page.goto(`https://${host}:${port}/`);
      await page.locator('#code').fill(code);
      await page.locator('#connect').click();
      await page.waitForFunction(() => hostCommit && peer?.connectionState === 'connected');
      const enabled = setting !== 'off';
      assert.equal(await page.locator('#rttBackoff').isChecked(), enabled);
      assert.equal(await page.locator('#rttBackoff').isDisabled(), !enabled);
      await page.evaluate(() => sendSignal({ type: 'set-rtt-backoff', enabled: true }));
      await page.waitForFunction(expected => rttControlMode === expected,
        enabled ? 'rtt-and-loss' : 'loss-only');
      // Wait for the server's response, not just the paired state.
      const logDeadline = Date.now() + 3000;
      while (!log.includes('WAN RTT backoff') && Date.now() < logDeadline)
        await new Promise(done => setTimeout(done, 50));
      assert.ok(log.includes(`WAN RTT backoff ${enabled ? 'enabled' : 'disabled (loss only)'}`));
      await page.waitForFunction(() => metricRows.length >= 2);
      const download = page.waitForEvent('download');
      await page.evaluate(() => $('exportMetrics').click());
      const file = await download;
      const rows = (await readFile(await file.path(), 'utf8')).trim().split(/\r?\n/).map(row => row.split(','));
      const header = rows.shift();
      const modeColumn = header.indexOf('rtt_control_mode');
      const commitColumn = header.indexOf('host_commit');
      assert.ok(modeColumn >= 0 && commitColumn >= 0);
      for (const row of rows) {
        assert.equal(row.length, header.length, 'CSV headers and data must align');
        assert.equal(row[modeColumn], enabled ? 'rtt-and-loss' : 'loss-only');
        assert.match(row[commitColumn], /^[a-f0-9]{12}(?:-dirty)?$/);
      }
      await page.evaluate(() => stop());
      console.log(`PASS RTT_CONTROL=${setting ?? '(unset)'}: server policy, UI, CSV, commit log`);
    } finally {
      await context.close();
      if (server.exitCode === null && server.signalCode === null) {
        const exited = once(server, 'exit'); server.kill(); await exited;
      }
    }
  }
} finally { await browser.close(); }
