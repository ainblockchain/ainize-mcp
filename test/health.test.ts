import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type {AddressInfo} from 'node:net';
import {healthHandler,readBuildCommit} from '../src/health.js';

test('health accepts only a full build-file commit and does not trust runtime metadata',()=>{
  const before=process.env.AINIZE_DEPLOYMENT_COMMIT;
  process.env.AINIZE_DEPLOYMENT_COMMIT='a'.repeat(40);
  try{
    assert.equal(readBuildCommit(()=> 'b'.repeat(40)+'\n'),'b'.repeat(40));
    assert.equal(readBuildCommit(()=> 'private-invalid-value'),'unknown');
    assert.equal(readBuildCommit(()=>{throw new Error('unavailable');}),'unknown');
  }finally{if(before===undefined)delete process.env.AINIZE_DEPLOYMENT_COMMIT;else process.env.AINIZE_DEPLOYMENT_COMMIT=before;}
});

test('HTTP health is available without contacting a node or returning configuration',async()=>{
  const app=express();app.get('/healthz',healthHandler('test-version'));
  const server=app.listen(0,'127.0.0.1');
  await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  try{
    const response=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/healthz`);
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{status:'ok',version:'test-version',commit:'unknown'});
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
