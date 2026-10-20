import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientProfile } from '../client-profile.mjs';
import { PairingAdmin } from '../pairing-admin.mjs';
import { acceptedSignalOrigin } from '../signal-origin.mjs';

test('PC and iPad keep distinct private state, transfer and diagnostic paths', () => {
  const ipad=clientProfile(),pc=clientProfile('pc');
  for(const property of ['privateDirectory','transferName','diagnosticLog','nativeClient'])assert.notEqual(pc[property],ipad[property]);
  assert.equal(clientProfile('pc',true).mode,'wan');
  assert.throws(()=>clientProfile('unknown'));
});
test('native PC handshake cannot enter the iPad service or the reverse', () => {
  const origin='https://127.0.0.1:10433';
  assert.equal(acceptedSignalOrigin(undefined,'pc-native-v1',origin,'pc-native-v1'),true);
  assert.equal(acceptedSignalOrigin(undefined,'pc-native-v1',origin),false);
  assert.equal(acceptedSignalOrigin(undefined,'ipad-native-v1',origin,'pc-native-v1'),false);
});
test('changing PC password and code leaves iPad administrative state intact', async () => {
  const directory=await mkdtemp(join(tmpdir(),'remotedesk-profiles-'));
  try{
    const ipad=await new PairingAdmin({directory:join(directory,'ipad'),mode:'lan',port:19571,host:'127.0.0.1'}).init();
    const pc=await new PairingAdmin({directory:join(directory,'pc'),mode:'lan',port:19572,host:'127.0.0.1'}).init();
    const original=ipad.code;
    await pc.execute('setup',{password:'NativePC123',confirmPassword:'NativePC123'});
    await pc.execute('change',{password:'NativePC123',code:'12345678'});
    assert.equal(ipad.code,original);
    assert.equal((await ipad.execute('status')).configured,false);
    assert.equal(pc.code,'12345678');
  }finally{await rm(directory,{recursive:true,force:true});}
});
