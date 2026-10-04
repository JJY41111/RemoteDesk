import https from 'node:https';
import { readFile } from 'node:fs/promises';
const chunks = []; let size = 0;
for await (const chunk of process.stdin) { size += chunk.length; if (size > 8192) throw new Error('Oversized request'); chunks.push(chunk); }
try {
  const { url, action, input } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const target = new URL(url);
  if (target.protocol !== 'https:' || !/^[\d.]+$/.test(target.hostname) || !['status', 'setup', 'change'].includes(action)) throw new Error('Invalid request');
  const payload = JSON.stringify(input || {});
  const ca = await readFile(new URL('./private/ca.crt', import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const request = https.request(new URL(`/api/launcher/pairing/${action}`, target), {
      method: 'POST', ca,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-remotedesk-launcher': '1' }
    }, response => {
      let text = ''; response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        try {
          const data = text ? JSON.parse(text) : { error: '此服務尚未支援管理功能，請更新服務。' };
          resolve({ ...data, status: response.statusCode });
        } catch { reject(new Error('管理服務回應不正確。')); }
      });
    });
    request.setTimeout(8000, () => request.destroy(new Error('連線逾時')));
    request.on('error', reject); request.end(payload);
  });
  console.log(JSON.stringify(result));
} catch (error) { console.log(JSON.stringify({ status: 500, error: error.message })); process.exitCode = 1; }
