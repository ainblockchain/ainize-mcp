/**
 * A capability is what the NODE can do right now, not what it could do when this process started. The shared model
 * server gets stopped and restarted (a GPU is claimed, a container is recycled) and a session that resolved
 * `can_live_test: false` once must not stay crippled for its whole life — the tool has to come back, and the client
 * has to be told its tool list moved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { Context } from '../src/context.js';
import { buildServer } from '../src/server.js';
import { FakeNode, OPERATOR_TOKEN } from './fake-node.js';

const connect = async (ctx: Context) => {
  const { server } = buildServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
};

test('a model server that was down when the session started comes back, and the tool list follows it', async () => {
  const fake = new FakeNode();
  const url = await fake.start();
  fake.state.runtimeAvailable = false;                 // the GPU is busy elsewhere at connect time
  const ctx = new Context(loadConfig({ env: { AINIZE_NODE_URL: url, AINIZE_TOKEN: OPERATOR_TOKEN } as NodeJS.ProcessEnv }));
  await ctx.resolveCapabilities();
  const { client, close } = await connect(ctx);
  try {
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { changed += 1; });
    const before = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!before.includes('live_test'), `live_test must not be offered while the model is down: ${before.join(', ')}`);

    fake.state.runtimeAvailable = true;                // the model server comes back
    const out = await client.callTool({ name: 'node_status', arguments: { refresh: true } });
    const data = out.structuredContent as Record<string, unknown>;
    assert.equal((data.capabilities as Record<string, boolean>).can_live_test, true);
    assert.ok(data.capabilities_changed, 'the answer must say the tool list moved');

    const after = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(after.includes('live_test'), `live_test must be back without restarting the session: ${after.join(', ')}`);
    assert.ok(changed >= 1, 'the client must have been sent notifications/tools/list_changed');
  } finally { await close(); await fake.stop(); }
});

test('a capability that goes away is withdrawn, not left as a tool that cannot work', async () => {
  const fake = new FakeNode();
  const url = await fake.start();
  const ctx = new Context(loadConfig({ env: { AINIZE_NODE_URL: url, AINIZE_TOKEN: OPERATOR_TOKEN } as NodeJS.ProcessEnv }));
  await ctx.resolveCapabilities();
  const { client, close } = await connect(ctx);
  try {
    assert.ok((await client.listTools()).tools.some((t) => t.name === 'live_test'));
    fake.state.runtimeAvailable = false;
    await client.callTool({ name: 'node_status', arguments: { refresh: true } });
    const after = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!after.includes('live_test'), `a live test that cannot run must not be offered: ${after.join(', ')}`);
  } finally { await close(); await fake.stop(); }
});
