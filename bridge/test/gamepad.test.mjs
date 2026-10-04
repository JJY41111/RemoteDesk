import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { ViiperGamepad, neutralGamepad, validGamepad, xbox360Packet,
  acceptsGamepadSequence } from '../gamepad.mjs';

test('late unordered gamepad states and releases cannot undo newer input', () => {
  assert.equal(acceptsGamepadSequence({ seq: 12 }, 11), true);
  assert.equal(acceptsGamepadSequence({ seq: 10 }, 12), false);
  assert.equal(acceptsGamepadSequence({ seq: 12 }, 12), false);
  assert.equal(acceptsGamepadSequence({ seq: 13 }, 12), true);
  assert.equal(acceptsGamepadSequence({}, -1), true); // old browser compatibility
  assert.equal(acceptsGamepadSequence({}, 12), false);
  assert.equal(acceptsGamepadSequence({ seq: 1.5 }, -1), false);
});

async function fakeViiper(t, { delayCreate = false, failRemove = 0 } = {}) {
  const commands = [], sockets = new Set();
  let streamingSocket, releaseCreate;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let data = Buffer.alloc(0), streaming = false;
    socket.on('data', chunk => {
      if (streaming) return;
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf(0);
      if (end < 0) return;
      const command = data.subarray(0, end).toString();
      commands.push(command);
      if (command === 'bus/7/3') { streaming = true; streamingSocket = socket; return; }
      if (command === 'bus/create' && delayCreate) {
        releaseCreate = () => socket.end(JSON.stringify({ busId: 7 }));
        return;
      }
      const response = command === 'ping' ? { server: 'VIIPER' } :
        command === 'bus/create' ? { busId: 7 } :
        command.startsWith('bus/7/add ') ? { devId: '3' } :
        failRemove-- > 0 ? { status: 503, detail: 'temporary failure' } : { busId: 7 };
      socket.end(JSON.stringify(response));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { port: server.address().port, commands,
    disconnect: () => streamingSocket.destroy(), release: () => releaseCreate() };
}

test('disconnect during creation removes the late-created bus without attaching a device', async t => {
  const fake = await fakeViiper(t, { delayCreate: true });
  const pad = new ViiperGamepad({ port: fake.port });
  const opening = pad.open();
  while (!fake.commands.includes('bus/create')) await delay(5);
  const closing = pad.close();
  fake.release();
  await Promise.all([opening, closing]);
  assert.deepEqual(fake.commands, ['ping', 'bus/create', 'bus/remove 7']);
  assert.equal(pad.busId, null);
  assert.equal(pad.watchdog, undefined);
});

test('broken VIIPER stream automatically removes its bus and reports offline', async t => {
  const fake = await fakeViiper(t);
  let offline = 0;
  const pad = new ViiperGamepad({ port: fake.port, onOffline: () => offline++ });
  await pad.open();
  pad.send(neutralGamepad);
  while (!fake.commands.includes('bus/7/3')) await delay(5);
  fake.disconnect();
  while (!pad.closed) await delay(5);
  await pad.close();
  assert.equal(offline, 1);
  assert.equal(pad.busId, null);
  assert.equal(fake.commands.filter(c => c === 'bus/remove 7').length, 1);
});

test('transient bus removal errors retry instead of silently leaving a controller', async t => {
  const fake = await fakeViiper(t, { failRemove: 2 });
  const pad = new ViiperGamepad({ port: fake.port });
  await pad.open();
  await pad.close();
  assert.equal(fake.commands.filter(c => c === 'bus/remove 7').length, 3);
  assert.equal(pad.busId, null);
});

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
