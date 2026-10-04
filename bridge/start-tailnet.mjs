import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { localTailnetIPv4 } from './tailnet-address.mjs';

const base = dirname(fileURLToPath(import.meta.url));
const addresses = localTailnetIPv4();
if (addresses.length !== 1) {
  throw new Error(addresses.length ?
    `Expected one active Tailscale IPv4, found ${addresses.join(', ')}` :
    'No active Tailscale IPv4. Connect Tailscale on this Windows host first.');
}

const host = addresses[0];
console.log(`RemoteDesk cross-region URL: https://${host}:9443/`);
console.log('Keep this process running while using the iPad.');
const child = spawn(process.execPath, [join(base, 'server.mjs'),
  '--tailnet', `--host=${host}`, '--port=9443', '--tcp-port=55445',
  '--enable-input', '--audio', '--display=0:0', '--gamepad=viiper'],
  { cwd: base, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error('RemoteDesk tailnet start:', error.message); });
child.on('exit', code => { process.exitCode = code ?? 1; });
