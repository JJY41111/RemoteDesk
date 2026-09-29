import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { ViiperGamepad, neutralGamepad, validGamepad, xbox360Packet } from '../gamepad.mjs';

test('standard browser gamepad becomes a separate Xbox 360 input report', () => {
  const state = { buttons: [...neutralGamepad.buttons], axes: [1, -1, -1, 1] };
  state.buttons[0] = 1; // A
  state.buttons[6] = .5; // Left trigger
  state.buttons[9] = 1; // Menu/Start
  state.buttons[12] = 1; // D-pad up
  assert.equal(validGamepad(state), true);
  const packet = xbox360Packet(state);
  assert.equal(packet.length, 20);
  assert.equal(packet.readUInt32LE(0), 0x1011);
  assert.equal(packet[4], 128);
  assert.equal(packet.readInt16LE(6), 32767);
  assert.equal(packet.readInt16LE(8), 32767);
  assert.equal(packet.readInt16LE(10), -32768);
  assert.equal(packet.readInt16LE(12), -32768);
  assert.equal(xbox360Packet(neutralGamepad).equals(Buffer.alloc(20)), true);
  assert.equal(validGamepad({ ...state, axes: [NaN, 0, 0, 0] }), false);
});

test('VIIPER adapter creates, streams, neutralizes and removes its own bus', async () => {
  const commands = [], reports = [];
  const server = createServer(socket => {
    let data = Buffer.alloc(0), streaming = false;
    socket.on('data', chunk => {
      if (streaming) { reports.push(chunk); return; }
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf(0);
      if (end < 0) return;
      const command = data.subarray(0, end).toString();
      commands.push(command);
      if (command === 'bus/7/3') {
        streaming = true;
        if (data.length > end + 1) reports.push(data.subarray(end + 1));
        return;
      }
      const response = command === 'ping' ? { server: 'VIIPER' } :
        command === 'bus/create' ? { busId: 7 } :
          command.startsWith('bus/7/add ') ? { busId: 7, devId: '3' } : { busId: 7 };
      socket.end(JSON.stringify(response) + '\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const pad = new ViiperGamepad({ port: server.address().port });
  try {
    await pad.open();
    pad.send(neutralGamepad);
    await pad.close();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(commands, ['ping', 'bus/create',
      'bus/7/add {"type":"xbox360"}', 'bus/7/3', 'bus/remove 7']);
    assert.ok(Buffer.concat(reports).length >= 40);
  } finally {
    await pad.close();
    await new Promise(resolve => server.close(resolve));
  }
});
