import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptedSignalOrigin } from '../signal-origin.mjs';

const expected = 'https://192.168.1.100:8443';
test('browser origin and explicit native handshake are accepted', () => {
  assert.equal(acceptedSignalOrigin(expected, undefined, expected), true);
  assert.equal(acceptedSignalOrigin(undefined, 'ipad-native-v1', expected), true);
});

test('other origins and missing native marker are rejected', () => {
  assert.equal(acceptedSignalOrigin('https://evil.example', 'ipad-native-v1', expected), false);
  assert.equal(acceptedSignalOrigin(undefined, undefined, expected), false);
  assert.equal(acceptedSignalOrigin('', 'ipad-native-v1', expected), false);
});
