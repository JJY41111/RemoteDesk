import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const icons = fileURLToPath(new URL('../web/icons/', import.meta.url));
const source = await readFile(resolve(icons, 'remotedesk.svg'), 'utf8');
const browser = await chromium.launch({ headless: true,
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
try {
  for (const size of [180, 192, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size },
      deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%}` +
      `svg{display:block;width:100%;height:100%}</style>${source}`);
    await page.screenshot({ path: resolve(icons, `remotedesk-${size}.png`) });
    await page.close();
  }
} finally {
  await browser.close();
}
