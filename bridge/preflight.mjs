import { networkInterfaces } from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
const binaries = ['remote_desk.exe', 'remote_desk_input.exe', 'remote_desk_audio.exe'];
const missing = binaries.filter(name => !existsSync(join(project, 'out', name)));
const addresses = Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
  (entries || []).filter(entry => entry.family === 'IPv4' && !entry.internal &&
    /^(10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(entry.address))
    .map(entry => `${entry.address} (${name})`));

console.log(`Node.js: ${process.version}`);
console.log(`C++ helpers: ${missing.length ? 'missing ' + missing.join(', ') : 'ready'}`);
console.log(`Private LAN IPv4: ${addresses.length ? addresses.join(', ') : 'none detected'}`);
console.log('Use a host address reachable from the iPad on the same trusted LAN.');
if (addresses.length) {
  console.log(`Example: npm.cmd start -- --host=${addresses[0].split(' ')[0]} --enable-input --audio --display=0:0`);
}
if (missing.length || !addresses.length || Number(process.versions.node.split('.')[0]) < 22) {
  process.exitCode = 1;
}
