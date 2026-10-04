import test from 'node:test';
import assert from 'node:assert/strict';
import { keyToVk } from '../input-map.mjs';

test('remote shortcuts and game keys map to Windows virtual keys', () => {
  assert.equal(keyToVk('F5'), 0x74);
  assert.equal(keyToVk('F12'), 0x7b);
  assert.equal(keyToVk('MetaLeft'), 0x5b);
  assert.equal(keyToVk('MetaRight'), 0x5c);
  assert.equal(keyToVk('KeyA'), 0x41);
  assert.equal(keyToVk('ArrowUp'), 0x26);
  assert.equal(keyToVk('ArrowLeft'), 0x25);
  assert.equal(keyToVk('ArrowRight'), 0x27);
  assert.equal(keyToVk('ArrowDown'), 0x28);
  assert.equal(keyToVk('ShiftLeft'), 0xa0);
  assert.equal(keyToVk('ShiftRight'), 0xa1);
  assert.equal(keyToVk('F13'), undefined);
});
