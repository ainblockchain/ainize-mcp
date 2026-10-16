/** Actual compiled CLI + HTTP MCP transport, with a synthetic node and no user credentials. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:net';
import type {AddressInfo} from 'node:net';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {FakeNode} from './fake-node.js';

test('compiled HTTP CLI serves health and handles a real MCP read call without mutation capabilities',{timeout:15_000},async()=>{
  const fake=new FakeNode();const nodeUrl=await fake.start();
  const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=(probe.address() as AddressInfo).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const env={...process.env};
  for(const key of Object.keys(env))if(key.startsWith('AINIZE_'))delete env[key];
  Object.assign(env,{AINIZE_NODE_URL:nodeUrl,AINIZE_MCP_SESSION_BUDGET:'0',AINIZE_MCP_MAX_TEACH_JOBS:'0',AINIZE_DEPLOYMENT_COMMIT:'f'.repeat(40)});
  const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/bin.js',import.meta.url)),'--http',String(port),'--host','127.0.0.1'],{env,stdio:['ignore','ignore','pipe']});
  let diagnostics='';child.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk.toString()).slice(-8192);});
  const exited=once(child,'exit');
  const client=new Client({name:'compiled-service-proof',version:'1.0.0'});
  let connected=false;
  let expectedCommit='unknown';
  try{const stamp=readFileSync(new URL('../dist/build-commit.txt',import.meta.url),'utf8').trim();if(/^[a-f0-9]{40}$/.test(stamp))expectedCommit=stamp;}catch{}
  try{
    const deadline=Date.now()+8_000;
    let ready=false;
    while(Date.now()<deadline){
      if(child.exitCode!==null)throw new Error('compiled HTTP CLI exited before readiness');
      try{
        const res=await fetch(`http://127.0.0.1:${port}/healthz`,{signal:AbortSignal.timeout(500)});
        if(res.status===200){const body=await res.json();assert.equal(body.status,'ok');assert.equal(body.commit,expectedCommit,'runtime env cannot forge a compiled commit');ready=true;break;}
      }catch(error){if(error instanceof assert.AssertionError)throw error;}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.ok(ready,'compiled HTTP CLI did not become healthy');
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));connected=true;
    const names=(await client.listTools()).tools.map(tool=>tool.name);
    assert.ok(names.includes('search_knowledge'));
    for(const name of ['buy','apply_knowledge','remove_knowledge','publish'])assert.ok(!names.includes(name),name);
    const result=await client.callTool({name:'search_knowledge',arguments:{query:'test'}});
    assert.notEqual(result.isError,true);
    assert.ok(fake.requests.some(request=>request.method==='GET' && request.path.startsWith('/api/catalog')));
    assert.ok(fake.requests.every(request=>request.method==='GET'),'the proof never mutates a node');
    assert.ok(!diagnostics.includes(nodeUrl),'the configured backend address stays out of diagnostics');
  }finally{
    if(connected)await client.close();
    if(child.exitCode===null)child.kill('SIGTERM');
    const force=setTimeout(()=>child.kill('SIGKILL'),2_000);
    await exited;
    clearTimeout(force);
    await fake.stop();
  }
});
