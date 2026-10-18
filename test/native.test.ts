import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openCommand} from '../src/native.ts';
test('platform open commands keep file paths as literal arguments',()=>{
 const path='/tmp/a file;$(echo nope).txt';
 assert.deepEqual(openCommand('darwin','sublime',path),{executable:'/usr/bin/open',args:['-a','Sublime Text','--',path]});
 assert.deepEqual(openCommand('win32','sublime',path),{executable:'subl',args:['--',path]});
 assert.deepEqual(openCommand('win32','system',path),{executable:'explorer.exe',args:[path]});
 assert.deepEqual(openCommand('linux','system',path),{executable:'xdg-open',args:[path]});
});
