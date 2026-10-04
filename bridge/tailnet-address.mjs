import { networkInterfaces } from 'node:os';

export function isTailnetIPv4(address) {
  if (typeof address !== 'string') return false;
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255))
    return false;
  return Number(parts[0]) === 100 && Number(parts[1]) >= 64 &&
    Number(parts[1]) <= 127;
}

export function localTailnetIPv4(interfaces = networkInterfaces()) {
  return Object.entries(interfaces).flatMap(([name, entries]) =>
    /tailscale/i.test(name) ? (entries || [])
      .filter(entry => entry.family === 'IPv4' && !entry.internal &&
        isTailnetIPv4(entry.address))
      .map(entry => entry.address) : []);
}

export function isLocalTailnetHost(address, interfaces = networkInterfaces()) {
  return localTailnetIPv4(interfaces).includes(address);
}
