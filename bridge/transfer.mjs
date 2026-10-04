import { constants, createWriteStream } from 'node:fs';
import { copyFile, link, mkdir, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const MAX_CLIPBOARD_BYTES = 16 * 1024 * 1024;
export const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;

export function safeTransferName(value) {
  if (typeof value !== 'string') throw new Error('Invalid filename');
  let name;
  try { name = decodeURIComponent(value); } catch { throw new Error('Invalid filename'); }
  name = name.replace(/[\\/\x00-\x1f<>:"|?*]/g, '_').replace(/[. ]+$/, '');
  if (!name || name === '.' || name === '..') throw new Error('Invalid filename');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  const extension = name.match(/\.[^.]{1,20}$/)?.[0] || '';
  if (name.length > 180) name = name.slice(0, 180 - extension.length) + extension;
  return name;
}

function fail(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify({ error: message }));
}

function success(res, body) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function authorized(req, current, origin) {
  if (!current?.authorized || current.closed || !current.transferToken ||
      req.headers.origin !== origin ||
      typeof req.headers['x-remotedesk-token'] !== 'string') return false;
  const supplied = Buffer.from(req.headers['x-remotedesk-token']);
  const expected = Buffer.from(current.transferToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readLimited(req, limit) {
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > limit) throw new Error('Too large');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Too large');
    chunks.push(chunk);
  }
  if (!size) throw new Error('Empty content');
  return Buffer.concat(chunks);
}

async function writeLimited(req, path, limit, current) {
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > limit) throw new Error('Too large');
  const stream = createWriteStream(path, { flags: 'wx' });
  let size = 0;
  try {
    for await (const chunk of req) {
      if (current.closed) throw new Error('Session closed');
      size += chunk.length;
      if (size > limit) throw new Error('Too large');
      if (!stream.write(chunk)) await once(stream, 'drain');
    }
    stream.end();
    await once(stream, 'finish');
    if (!size) throw new Error('Empty content');
    return size;
  } catch (error) {
    stream.destroy();
    if (!stream.closed) await once(stream, 'close').catch(() => {});
    throw error;
  }
}

function runClipboard(script, kind, path) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA',
      '-ExecutionPolicy', 'Bypass', '-File', script, kind, path],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const timeout = setTimeout(() => child.kill(), 15000);
    let errorText = '';
    child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-2000); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      code === 0 ? resolve() :
        reject(new Error(errorText.trim() || `Clipboard helper exited ${code}`));
    });
  });
}

export async function handleTransfer(req, res, { current, origin, folder, privateFolder,
  clipboardScript }) {
  if (!['/api/clipboard', '/api/upload'].includes(new URL(req.url, origin).pathname))
    return false;
  if (req.method !== 'POST') { fail(res, 405, 'POST required'); return true; }
  if (!authorized(req, current, origin)) { fail(res, 403, 'Pairing required'); return true; }
  if (current.transferBusy) { fail(res, 429, 'Another transfer is in progress'); return true; }
  current.transferBusy = true;
  const temporary = join(privateFolder, `.transfer-${randomBytes(12).toString('hex')}.part`);
  try {
    await mkdir(privateFolder, { recursive: true });
    if (new URL(req.url, origin).pathname === '/api/clipboard') {
      const kind = req.headers['content-type']?.split(';')[0].toLowerCase();
      if (!['text/plain', 'image/png', 'image/jpeg'].includes(kind)) {
        fail(res, 415, 'Use text or PNG/JPEG image'); return true;
      }
      const bytes = await readLimited(req, MAX_CLIPBOARD_BYTES);
      if (current.closed) throw new Error('Session closed');
      await writeFile(temporary, bytes, { flag: 'wx' });
      await runClipboard(clipboardScript, kind === 'text/plain' ? 'text' : 'image', temporary);
      success(res, { kind: kind === 'text/plain' ? 'text' : 'image', bytes: bytes.length });
    } else {
      const name = safeTransferName(req.headers['x-remotedesk-name']);
      await mkdir(folder, { recursive: true });
      const size = await writeLimited(req, temporary, MAX_FILE_BYTES, current);
      if (current.closed) throw new Error('Session closed');
      const extension = name.match(/\.[^.]+$/)?.[0] || '';
      const stem = name.slice(0, name.length - extension.length);
      let savedName = '';
      let saved = false;
      for (let index = 0; index < 1000; index++) {
        savedName = index ? `${stem} (${index})${extension}` : name;
        const finalPath = join(folder, savedName);
        try {
          await link(temporary, finalPath);
          saved = true;
          break;
        } catch (error) {
          if (error.code === 'EEXIST') continue;
          if (error.code !== 'EPERM' && error.code !== 'ENOTSUP') throw error;
          try { await copyFile(temporary, finalPath, constants.COPYFILE_EXCL); }
          catch (copyError) {
            if (copyError.code === 'EEXIST') continue;
            throw copyError;
          }
          saved = true;
          break;
        }
      }
      if (!saved) throw new Error('Too many files with the same name');
      success(res, { name: savedName, bytes: size });
    }
  } catch (error) {
    const clientError = ['Too large', 'Empty content', 'Invalid filename'].includes(error.message);
    fail(res, error.message === 'Too large' ? 413 : clientError ? 400 : 500,
      clientError ? error.message : 'Transfer failed');
  } finally {
    current.transferBusy = false;
    await rm(temporary, { force: true }).catch(() => {});
  }
  return true;
}
