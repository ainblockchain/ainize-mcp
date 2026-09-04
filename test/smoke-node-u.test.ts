/**
 * Smoke test against a REAL node — node-u (`http://localhost:3422`, LOCAL ledger) by default, which is the node the
 * README names as safe for experiments. It skips itself when the node is not running, so `npm test` is still green
 * on a machine with no cluster.
 *
 *   AINIZE_SMOKE_NODE_URL=http://localhost:3422   which node to smoke (default that)
 *   AINIZE_MCP_SMOKE_LIVE=1                       also run one real before/after on the shared model server
 *
 * The live test is opt-in because it takes the cross-process model lock every node on the machine shares, and one
 * unit of the 20-per-hour free quota.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { Context } from '../src/context.js';
import { allTools, callTool } from '../src/server.js';
import type { ToolDef, ToolExtra } from '../src/tools/types.js';

const NODE_URL = process.env.AINIZE_SMOKE_NODE_URL ?? 'http://localhost:3422';
const extra = { signal: new AbortController().signal, requestId: 1, _meta: {}, sendNotification: async () => {}, sendRequest: async () => ({}) } as unknown as ToolExtra;

const up = async (): Promise<boolean> => {
  try { return (await fetch(`${NODE_URL}/healthz`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
};

const server = async () => {
  const ctx = new Context(loadConfig({ env: { AINIZE_NODE_URL: NODE_URL } as NodeJS.ProcessEnv }));
  await ctx.resolveCapabilities();
  const tools = new Map(allTools(ctx).map((d: ToolDef) => [d.name, d]));
  return {
    ctx,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const def = tools.get(name);
      assert.ok(def, `${name} is not registered against ${NODE_URL}`);
      const res = await callTool(ctx, def, args as Record<string, never>, extra);
      return { isError: !!res.isError, data: (res.structuredContent ?? {}) as Record<string, unknown> };
    },
  };
};

test('smoke: the read tools answer from a real node', { skip: (await up()) ? false : `${NODE_URL} is not running` }, async () => {
  const s = await server();
  const status = await s.call('node_status');
  assert.equal(status.isError, false, JSON.stringify(status.data));
  const node = status.data.node as Record<string, unknown>;
  assert.ok(String(node.name).length > 0);
  assert.ok(['local', 'ain'].includes(String(node.ledger)));
  assert.match(String((status.data.model_lock as { sentence: string }).sentence), /model/);

  const search = await s.call('search_knowledge', { limit: 3 });
  assert.equal(search.isError, false, JSON.stringify(search.data));
  const items = search.data.items as Record<string, unknown>[];
  assert.ok(Number(search.data.total) >= 0);
  if (!items.length) return;

  const id = String(items[0]!.id);
  const detail = await s.call('get_knowledge', { id });
  assert.equal(detail.isError, false, JSON.stringify(detail.data));
  assert.equal((detail.data.knowledge as Record<string, unknown>).id, id);
  assert.ok((detail.data.verification as Record<string, unknown>).quorum);

  const tree = await s.call('family_tree', { id });
  assert.equal(tree.isError, false, JSON.stringify(tree.data));

  // A dry-run quote must be genuinely read-only: catalogue only, no 402, no nonce reserved.
  const quote = await s.call('quote', { id, dry_run: true });
  if (!quote.isError) {
    assert.equal(quote.data.binding, false);
    assert.ok(String((quote.data.affordable as Record<string, string>).explanation).length > 20);
  } else {
    // an unverified or challenged knowledge is refused a price — that is a correct outcome, not a failure
    assert.match(String((quote.data.error as Record<string, string>).code), /not_listed_yet|challenged|not_found/);
  }
});

test('smoke: a real before/after on the shared model', {
  skip: process.env.AINIZE_MCP_SMOKE_LIVE === '1' ? ((await up()) ? false : `${NODE_URL} is not running`) : 'set AINIZE_MCP_SMOKE_LIVE=1 (it takes the shared model lock and one free try)',
  timeout: 15 * 60_000,
}, async () => {
  const s = await server();
  const started = await s.call('live_test', { question: 'What is 2 + 2? Answer with the number only.', knowledge: [], max_tokens: 8 });
  assert.equal(started.isError, false, JSON.stringify(started.data));
  const jobId = String(started.data.job_id);
  assert.equal(started.data.state, 'queued');

  for (let i = 0; i < 60; i++) {
    const st = await s.call('job_status', { job_id: jobId, wait_ms: 10_000 });
    const state = String(st.data.state);
    if (state === 'done') {
      const r = st.data.result as Record<string, unknown>;
      assert.ok(String((r.before as Record<string, string>).answer).length > 0, 'the bare model answered nothing');
      assert.equal(r.verdict, null, 'a question outside any benchmark is unscored, and must say so');
      assert.ok((r.quota as Record<string, unknown>).limit);
      return;
    }
    if (state === 'failed' || state === 'cancelled') {
      const err = st.data.error as Record<string, string>;
      // a busy GPU or an exhausted free quota is a correct answer, not a broken tool
      assert.match(err.code, /model_busy|quota_chat|runtime_unavailable|unavailable/, JSON.stringify(err));
      return;
    }
  }
  assert.fail('the live test never finished');
});
