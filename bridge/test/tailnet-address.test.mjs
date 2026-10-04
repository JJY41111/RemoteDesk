import test from 'node:test';
import assert from 'node:assert/strict';
import { isTailnetIPv4, localTailnetIPv4, isLocalTailnetHost } from '../tailnet-address.mjs';

const interfaces = {
  Ethernet: [{ family: 'IPv4', internal: false, address: '192.168.1.100' }],
  Tailscale: [{ family: 'IPv4', internal: false, address: '100.64.0.10' }]
};

test('tailnet mode accepts only an address on the local Tailscale adapter', () => {
  assert.deepEqual(localTailnetIPv4(interfaces), ['100.64.0.10']);
  assert.equal(isLocalTailnetHost('100.64.0.10', interfaces), true);
  assert.equal(isLocalTailnetHost('100.64.0.11', interfaces), false);
  assert.equal(isLocalTailnetHost('192.168.1.100', interfaces), false);
  assert.equal(isLocalTailnetHost('100.64.0.10', { Ethernet: interfaces.Tailscale }), false);
});

test('tailnet address check rejects malformed and out-of-range addresses', () => {
  for (const value of ['100.63.1.1', '100.128.1.1', '100.127.256.1',
    '100.64.1.1.1', '100.64.-1.1', '192.168.1.100']) {
    assert.equal(isTailnetIPv4(value), false, value);
  }
  assert.equal(isTailnetIPv4('100.64.0.1'), true);
  assert.equal(isTailnetIPv4('100.127.255.255'), true);
});
