import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fullEnv, harness } from './harness.js';

const quoteOf = async (h: Awaited<ReturnType<typeof harness>>, args: Record<string, unknown> = { id: 'k1' }) => {
  const { isError, data } = await h.call('quote', args);
  assert.equal(isError, false, JSON.stringify(data));
  return data;
};

test('quote states the price, the verification and the budget, and hands back a quote_id', async (t) => {
  const h = await harness(fullEnv());
  t.after(h.stop);
  const q = await quoteOf(h);
  assert.match(String(q.quote_id), /^q_/);
  assert.equal(q.binding, true, 'the 402 handshake is the seller\'s own quote');
  assert.equal(q.total_requested, '5');
  assert.equal((q.budget as Record<string, string>).remaining, '10');
  assert.deepEqual(q.confirm_with, { tool: 'buy', quote_id: q.quote_id, confirm_total: '5', confirm: true });
  assert.match(String(q.next), /STOP|wait|stop/i);
  const item = (q.items as Record<string, unknown>[])[0] as Record<string, unknown>;
  assert.equal(item.scheme, 'local-credit');
  assert.equal(item.pay_to, '0x2222222222222222222222222222222222222222');
});

test('a dry-run quote never touches the gateway, because a 402 reserves a nonce', async (t) => {
  const h = await harness(fullEnv());
  t.after(h.stop);
  const q = await quoteOf(h, { id: 'k1', dry_run: true });
  assert.equal(h.fake.called('/x402').length, 0, 'a dry run that allocates state upstream is not a dry run');
  assert.equal(q.binding, false);
  assert.ok((q.warnings as string[]).some((w) => /dry run/i.test(w)));
});

test('the honest total includes the base stack, and the shortfall is explained', async (t) => {
  const h = await harness(fullEnv({ AINIZE_MCP_SESSION_BUDGET: '10' }));
  t.after(h.stop);
  h.fake.state.requires = [{ id: 'base1', name: 'KRX all', held: false, price: '25' }];
  const q = await quoteOf(h);
  assert.equal(q.total_requested, '5');
  assert.equal(q.total_with_bases, '30');
  const aff = q.affordable as Record<string, unknown>;
  assert.equal(aff.requested, true);
  assert.equal(aff.with_bases, false);
  assert.equal(aff.shortfall, '20');
  assert.match(String(aff.explanation), /honest total is 30/);
  assert.ok((q.warnings as string[]).some((w) => /add-on/.test(w)));
});

test('an unverified or challenged knowledge is refused a price', async (t) => {
  const h = await harness(fullEnv());
  t.after(h.stop);
  h.fake.state.quorum_ok = false;
  const a = await h.call('quote', { id: 'k1' });
  assert.equal((a.data.error as Record<string, unknown>).code, 'not_listed_yet');
  h.fake.state.quorum_ok = true;
  h.fake.state.sellable = false;
  const b = await h.call('quote', { id: 'k1' });
  assert.equal((b.data.error as Record<string, unknown>).code, 'challenged');
  assert.match(String((b.data.error as Record<string, unknown>).message), /No price is honest/i);
});

test('buy is not registered at all without a budget', async (t) => {
  const h = await harness({ AINIZE_TOKEN: 'fake-session-token-0123456789' });
  t.after(h.stop);
  assert.ok(!h.names.includes('buy'));
  assert.ok(h.names.includes('quote'), 'quoting stays available so an agent can still price things');
});

test('every money gate refuses before the node is ever called', async (t) => {
  const h = await harness(fullEnv());
  t.after(h.stop);
  const q = await quoteOf(h);
  const qid = q.quote_id as string;

  const noQuote = await h.call('buy', { confirm_total: '5', confirm: true });
  assert.equal((noQuote.data.error as Record<string, unknown>).code, 'quote_required');

  const noConfirm = await h.call('buy', { quote_id: qid, confirm_total: '5' });
  assert.equal((noConfirm.data.error as Record<string, unknown>).code, 'confirmation_required');

  const wrongTotal = await h.call('buy', { quote_id: qid, confirm_total: '5.0', confirm: true });
  assert.equal((wrongTotal.data.error as Record<string, unknown>).code, 'quote_mismatch', 'the total is compared by string equality');

  const unknown = await h.call('buy', { quote_id: 'q_nope', confirm_total: '5', confirm: true });
  assert.equal((unknown.data.error as Record<string, unknown>).code, 'quote_expired');

  assert.equal(h.fake.called('/api/patches/k1/buy').length, 0, 'no gate may reach the node');
  for (const r of [noQuote, noConfirm, wrongTotal, unknown]) assert.equal((r.data.error as Record<string, unknown>).retryable, false, 'nothing in the money tier is retryable');
});

test('an expired quote cannot be settled', async (t) => {
  const h = await harness(fullEnv());
  t.after(h.stop);
  const q = await quoteOf(h);
  const stored = h.ctx.quotes.get(q.quote_id as string)!;
  stored.expires_at = Date.now() - 1;
  const out = await h.call('buy', { quote_id: q.quote_id, confirm_total: '5', confirm: true });
  assert.equal((out.data.error as Record<string, unknown>).code, 'quote_expired');
});

test('over the session cap is budget_exceeded with all four numbers, never a partial buy', async (t) => {
  const h = await harness(fullEnv({ AINIZE_MCP_SESSION_BUDGET: '1' }));
  t.after(h.stop);
  const q = await quoteOf(h);
  const out = await h.call('buy', { quote_id: q.quote_id, confirm_total: '5', confirm: true });
  const err = out.data.error as Record<string, unknown>;
  assert.equal(err.code, 'budget_exceeded');
  assert.deepEqual(err.details, { cap: '1', spent: '0', remaining: '1', needed: '5', currency: 'CREDIT' });
  assert.equal(h.fake.called('/api/patches/k1/buy').length, 0);
});

test('max_price may lower the ceiling for one call but never raise it', async (t) => {
  const h = await harness(fullEnv());
  t.after(h.stop);
  const q = await quoteOf(h);
  const out = await h.call('buy', { quote_id: q.quote_id, confirm_total: '5', confirm: true, max_price: '2' });
  assert.equal((out.data.error as Record<string, unknown>).code, 'per_purchase_cap_exceeded');
  const h2 = await harness(fullEnv({ AINIZE_MCP_SESSION_BUDGET: '1' }));
  t.after(h2.stop);
  const q2 = await quoteOf(h2);
  const out2 = await h2.call('buy', { quote_id: q2.quote_id, confirm_total: '5', confirm: true, max_price: '999' });
  assert.equal((out2.data.error as Record<string, unknown>).code, 'budget_exceeded', 'a tool argument cannot raise the server cap');
  assert.equal(h2.fake.called('/api/patches/k1/buy').length, 0);
});

test('a dry-run buy runs every gate and calls nothing', async (t) => {
  const h = await harness(fullEnv());
  t.after(h.stop);
  const q = await quoteOf(h);
  const out = await h.call('buy', { quote_id: q.quote_id, confirm_total: '5', confirm: true, dry_run: true });
  assert.equal(out.isError, false);
  assert.equal(out.data.dry_run, true);
  assert.equal((out.data.gates_passed as string[]).length, 8);
  assert.equal(h.fake.called('/api/patches/k1/buy').length, 0);
  assert.equal((out.data.budget as Record<string, string>).remaining, '10', 'a dry run must not hold budget');
});

test('the happy path settles once, decrements the budget and passes the node timeline through', async (t) => {
  const h = await harness(fullEnv());
  t.after(h.stop);
  const q = await quoteOf(h);
  const started = await h.call('buy', { quote_id: q.quote_id, confirm_total: '5', confirm: true, idempotency_key: 'key-1' });
  assert.equal(started.isError, false);
  const done = await h.call('job_status', { job_id: started.data.job_id as string, wait_ms: 5000 });
  assert.equal(done.data.state, 'done');
  const r = done.data.result as Record<string, unknown>;
  assert.equal(r.amount, '5');
  assert.equal(r.tx_hash, `0x${'b'.repeat(64)}`);
  assert.deepEqual((r.steps as { step: string }[]).map((s) => s.step), ['quorum', '402', 'settled', 'download']);
  assert.equal((r.budget as Record<string, string>).spent, '5');
  assert.equal((r.budget as Record<string, string>).remaining, '5');
  assert.ok(!JSON.stringify(done.data).includes('tok-secret-value-here'), 'the manifest download token leaked');
  assert.equal(h.fake.called('/api/patches/k1/buy').length, 1);

  // the same key again never reaches the node
  const replay = await h.call('buy', { quote_id: q.quote_id, confirm_total: '5', confirm: true, idempotency_key: 'key-1' });
  assert.equal((replay.data.error as Record<string, unknown>).code, 'idempotency_replay');
  assert.equal(h.fake.called('/api/patches/k1/buy').length, 1, 'a replay must not pay twice');
});

test('a knowledge this node already bought is refused, and nothing is charged', async (t) => {
  const h = await harness(fullEnv());
  t.after(h.stop);
  const q = await quoteOf(h);
  h.fake.state.purchases = [{ patch_id: 'k1', amount: '5', tx_hash: `0x${'b'.repeat(64)}`, scheme: 'local-credit', created_at: 1788000000000, path: '/blobs/k1.npz' }];
  const out = await h.call('buy', { quote_id: q.quote_id, confirm_total: '5', confirm: true });
  const err = out.data.error as Record<string, unknown>;
  assert.equal(err.code, 'already_purchased');
  assert.equal((err.details as Record<string, unknown>).body_present, true);
  assert.equal(h.fake.called('/api/patches/k1/buy').length, 0);
});

test('a price that moved under the quote stops the purchase', async (t) => {
  const h = await harness(fullEnv());
  t.after(h.stop);
  const q = await quoteOf(h);
  h.fake.state.price = '7';
  const out = await h.call('buy', { quote_id: q.quote_id, confirm_total: '5', confirm: true });
  assert.equal((out.data.error as Record<string, unknown>).code, 'quote_mismatch');
});

test('a buy that failed after the request went out keeps its intent AND its hold, and never retries', async (t) => {
  const h = await harness(fullEnv());
  t.after(h.stop);
  const q = await quoteOf(h);
  h.fake.state.leakSecret = 'fake-session-token-0123456789';
  h.fake.state.buyFail = { status: 500, body: { error: 'blob download failed' } };
  const started = await h.call('buy', { quote_id: q.quote_id, confirm_total: '5', confirm: true, idempotency_key: 'key-2' });
  const done = await h.call('job_status', { job_id: started.data.job_id as string, wait_ms: 5000 });
  assert.equal(done.data.state, 'failed');
  assert.ok(!JSON.stringify(done.data).includes('fake-session-token'), 'an upstream error body must not leak the session token');
  // A 500 saying "blob download failed" is the node erroring AFTER it charged — which is why the journal keeps
  // the intent, and why the hold has to stay with it. Releasing here, as this used to, let the session spend the
  // same allowance twice: once on the purchase completing upstream and once on whatever it bought next.
  assert.equal(h.ctx.journal.get('key-2')?.state, 'intent', 'the intent stays: money may have moved');
  assert.equal(h.ctx.budget.view().remaining, '5', 'and so does the hold, until something finds out what happened');
  assert.equal(h.ctx.journal.get('key-2')?.budget_held, true);

  const retry = await h.call('buy', { quote_id: q.quote_id, confirm_total: '5', confirm: true, idempotency_key: 'key-2' });
  assert.equal((retry.data.error as Record<string, unknown>).code, 'idempotency_replay');
  assert.match(String((retry.data.error as Record<string, unknown>).message), /reconcile_purchase/);

  // …and `reconcile_purchase` is the thing that finds out. Nothing was settled on the fake node, so the
  // allowance comes back and the row stops holding it.
  const rec = await h.call('reconcile_purchase', { idempotency_key: 'key-2' });
  assert.equal(rec.data.state, 'never_paid');
  assert.equal(h.ctx.budget.view().remaining, '10', 'the hold is released once the outcome is known');
  assert.equal(h.ctx.journal.get('key-2')?.budget_held, false);
});

test('reconcile_purchase tells the four truths apart without paying anything', async (t) => {
  const h = await harness(fullEnv());
  t.after(h.stop);
  const never = await h.call('reconcile_purchase', { id: 'k1' });
  assert.equal(never.data.state, 'never_paid');

  h.fake.state.settlements = [{ patch_id: 'k1', buyer: '0x1111111111111111111111111111111111111111', amount: '5', tx_hash: `0x${'b'.repeat(64)}` }];
  const settled = await h.call('reconcile_purchase', { id: 'k1' });
  assert.equal(settled.data.state, 'settled_no_body');
  assert.match(String(settled.data.explanation), /Do NOT buy again/);

  h.fake.state.purchases = [{ patch_id: 'k1', amount: '5', tx_hash: `0x${'b'.repeat(64)}`, scheme: 'local-credit', created_at: 1788000000000, path: '/blobs/k1.npz' }];
  const complete = await h.call('reconcile_purchase', { id: 'k1' });
  assert.equal(complete.data.state, 'complete');
  assert.equal(h.fake.called('/api/patches/k1/buy').length, 0, 'reconciling never buys');
});
