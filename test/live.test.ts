import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fullEnv, harness } from './harness.js';

test('live_test hands back a job handle in milliseconds while the model call is still in flight', async (t) => {
  const h = await harness();
  t.after(h.stop);
  h.fake.state.chatDelayMs = 400;
  const t0 = Date.now();
  const { isError, data } = await h.call('live_test', { question: '픽셀플러스 종목코드는?', knowledge: ['k1'], max_tokens: 16 });
  assert.equal(isError, false);
  assert.ok(Date.now() - t0 < 250, `live_test must not block (took ${Date.now() - t0} ms)`);
  assert.equal(data.state, 'queued');
  assert.match(String(data.job_id), /^lt_/);
  assert.ok(String(data.native_request_id).startsWith('mcp-'));
  assert.ok((data.model_lock as { sentence: string }).sentence.length > 0);
});

test('job_status returns the before/after, the verdict and the verifiers', async (t) => {
  const h = await harness();
  t.after(h.stop);
  const start = await h.call('live_test', { question: '픽셀플러스 종목코드는?', knowledge: ['k1'] });
  const { data } = await h.call('job_status', { job_id: start.data.job_id as string, wait_ms: 5000 });
  assert.equal(data.state, 'done');
  const r = data.result as Record<string, unknown>;
  assert.deepEqual((r.before as Record<string, unknown>).answer, '058420');
  assert.deepEqual((r.after as Record<string, unknown>).answer, '087600');
  assert.equal(r.changed, true);
  assert.equal((r.verdict as Record<string, unknown>).benchmark_hit, true);
  const k = (r.knowledge as Record<string, unknown>[])[0] as Record<string, unknown>;
  assert.equal((k.verification as { quorum: string }).quorum, '2/2');
  assert.equal((r.quota as Record<string, unknown>).remaining, 17);
  assert.match(String((r.quota as Record<string, string>).shared_note), /shared by everyone/);
});

test('an unscored comparison says so instead of pretending it was verified', async (t) => {
  const h = await harness();
  t.after(h.stop);
  const start = await h.call('live_test', { question: 'anything', knowledge: [] });
  const { data } = await h.call('job_status', { job_id: start.data.job_id as string, wait_ms: 5000 });
  const r = data.result as Record<string, unknown>;
  assert.equal(r.verdict, null, 'verdict must be null, never false, when the question is not in a benchmark');
});

test('the quota exhaustion answer says when free tries come back', async (t) => {
  const h = await harness();
  t.after(h.stop);
  const reset = Date.now() + 300_000;
  h.fake.state.chatFail = { status: 429, body: { error: 'quota_chat: free live-test quota exhausted for this hour — buy the patch or run your own node', quota_reset: reset } };
  const start = await h.call('live_test', { question: 'q', knowledge: ['k1'] });
  const { data } = await h.call('job_status', { job_id: start.data.job_id as string, wait_ms: 5000 });
  const err = data.error as Record<string, unknown>;
  assert.equal(err.code, 'quota_chat');
  assert.equal(err.retryable, true);
  assert.ok(Number(err.retry_after_ms) > 250_000, 'retry_after_ms comes from the node quota_reset, not a guess');
});

test('a busy shared model is model_busy with the holder named, not a 500', async (t) => {
  const h = await harness();
  t.after(h.stop);
  h.fake.state.chatFail = { status: 503, body: { error: 'shared runtime busy (node-b: chat:k1) — try again later', busy: true } };
  const start = await h.call('live_test', { question: 'q', knowledge: ['k1'] });
  const { data } = await h.call('job_status', { job_id: start.data.job_id as string, wait_ms: 5000 });
  const err = data.error as Record<string, unknown>;
  assert.equal(err.code, 'model_busy');
  assert.equal(err.retryable, true);
  assert.match(String(err.message), /node-b/);
});

test('cancelling a queued live test is free, and says so', async (t) => {
  const h = await harness();
  t.after(h.stop);
  h.fake.state.chatDelayMs = 800;
  const start = await h.call('live_test', { question: 'q', knowledge: ['k1'] });
  await new Promise((r) => setTimeout(r, 50));
  const { data } = await h.call('job_cancel', { job_id: start.data.job_id as string });
  assert.equal(data.charged, false);
  assert.match(String(data.note), /nothing/i);
  const after = await h.call('job_status', { job_id: start.data.job_id as string });
  assert.equal(after.data.state, 'cancelled');
});

test('job_status on a job this session never had is job_not_found, and job_list still works', async (t) => {
  const h = await harness();
  t.after(h.stop);
  const { isError, data } = await h.call('job_status', { job_id: 'lt_nope' });
  assert.equal(isError, true);
  assert.equal((data.error as Record<string, unknown>).code, 'job_not_found');
  await h.call('live_test', { question: 'q', knowledge: [] });
  const list = await h.call('job_list', {});
  assert.equal((list.data.jobs as unknown[]).length, 1);
});

test('live_test is not registered at all when the node has no serving model', async (t) => {
  const h = await harness({}, (fake) => { fake.state.runtimeAvailable = false; });
  t.after(h.stop);
  assert.ok(!h.names.includes('live_test'), 'a model the node cannot serve must not be offered as a tool');
  assert.equal(h.ctx.capabilities().can_live_test, false);
  assert.match(String(h.ctx.capabilityReasons().can_live_test), /serving model/);
});

test('apply/remove are off unless the operator opted in, and remove needs confirmation', async (t) => {
  const off = await harness();
  t.after(off.stop);
  assert.ok(!off.names.includes('apply_knowledge'), 'apply must not be registered by default');

  const h = await harness(fullEnv());
  t.after(h.stop);
  assert.ok(h.names.includes('apply_knowledge') && h.names.includes('remove_knowledge'));
  const refused = await h.call('remove_knowledge', { id: 'k1' });
  assert.equal(refused.isError, true);
  assert.equal((refused.data.error as Record<string, unknown>).code, 'confirmation_required');

  const ok = await h.call('apply_knowledge', { id: 'k1' });
  assert.equal(ok.isError, false);
  assert.match(String(ok.data.warning), /every node on this machine shares/);
  const done = await h.call('job_status', { job_id: ok.data.job_id as string, wait_ms: 3000 });
  assert.equal(done.data.state, 'done');
});
