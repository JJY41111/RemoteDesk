import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ headless: true,
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
try {
  const page = await browser.newPage();
  await page.route('https://remotedesk.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!['index.html', 'app.js', 'style.css'].includes(name)) {
      await route.fulfill({ status: 404 }); return;
    }
    await route.fulfill({ body: await readFile(new URL(`../web/${name}`, import.meta.url)),
      contentType: name.endsWith('.js') ? 'application/javascript' :
        name.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('https://remotedesk.test/');
  assert.equal(await page.locator('#videoMode').inputValue(), '1080p');
  await page.locator('#videoMode').selectOption('native');
  await page.reload();
  assert.equal(await page.locator('#videoMode').inputValue(), 'native');
  await page.evaluate(() => localStorage.setItem('remotedesk.videoMode', 'removed-mode'));
  await page.reload();
  assert.equal(await page.locator('#videoMode').inputValue(), '1080p');
  console.log('Resolution choice survives reload; stale choices keep the 1080p default.');
} finally { await browser.close(); }
