import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const exe=fileURLToPath(new URL('../../out/system-host/remote_desk_host.exe',import.meta.url));
test('host protocol self-test has no privileged side effects', {skip:!existsSync(exe)},()=>{
 const result=spawnSync(exe,['--self-test'],{windowsHide:true,timeout:3000,encoding:'utf8'});
 assert.equal(result.status,0);assert.match(result.stdout,/bounds passed/);
});
test('host proxy rejects arbitrary commands and invalid endpoints before IPC', {skip:!existsSync(exe)},()=>{
 for(const args of [ ['--capture','--tcp-port=443'],['--capture','--tcp-port=55445','--connect=8.8.8.8'],
  ['--input','--display=9:10'],['--capture','--tcp-port=55445','--run=cmd.exe'],['--capture','--tcp-port=65536'],
  ['--capture','--tcp-port=55445junk'],['--shell'] ]){
  const result=spawnSync(exe,args,{windowsHide:true,timeout:3000});assert.equal(result.status,2,JSON.stringify(args));
 }
});
