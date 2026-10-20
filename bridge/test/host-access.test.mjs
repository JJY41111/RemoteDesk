import test from 'node:test';
import assert from 'node:assert/strict';
import { helperAccess } from '../host-access.mjs';
test('Windows delivery denial and recovery remain distinct from bridge acceptance',()=>{
  assert.deepEqual(helperAccess('INPUT_BLOCKED 5'),{type:'input-access-state',blocked:true,errorCode:5});
  assert.deepEqual(helperAccess('INPUT_BLOCKED 0'),{type:'input-access-state',blocked:true,errorCode:0});
  assert.deepEqual(helperAccess('INPUT_OK'),{type:'input-access-state',blocked:false,errorCode:null});
  assert.equal(helperAccess('INPUT_BLOCKED not-a-number'),null);
});
test('desktop loss pauses capture and a fresh frame resumes it',()=>{
  assert.deepEqual(helperAccess('CAPTURE_STATE PAUSED'),{type:'capture-state',paused:true});
  assert.deepEqual(helperAccess('CAPTURE_STATE RESUMED'),{type:'capture-state',paused:false});
  assert.equal(helperAccess('CAPTURE_STATE other'),null);
});
