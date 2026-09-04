import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, fullEnv } from './harness.js';

test('search_knowledge returns flat rows, never the raw catalogue entry', async (t) => {
  const h = await harness();
  t.after(h.stop);
  const { isError, data } = await h.call('search_knowledge', { query: 'k', limit: 2 });
  assert.equal(isError, false);
  const items = data.items as Record<string, unknown>[];
  assert.equal(items.length, 2);
  assert.deepEqual(Object.keys(items[0] as object).sort(), [
    'author', 'author_name', 'created_at', 'currency', 'description', 'downloads', 'id', 'is_addon', 'model',
    'name', 'node_url', 'origin', 'price', 'quorum', 'quorum_ok', 'requires_count', 'rows', 'schema', 'sellable',
    'size_mb', 'status', 'taught_by',
  ]);
  assert.ok(!JSON.stringify(items).includes('anchor'), 'the deep anchor must not be in a list result');
  assert.deepEqual(data.node, { name: 'fake-node', url: h.fake.url, ledger: 'local', currency: 'CREDIT', model: 'Qwen3.8-Flash-Next' });
});

test('get_knowledge carries the verification a judge reads, and drops the stake and the signature', async (t) => {
  const h = await harness();
  t.after(h.stop);
  const { data } = await h.call('get_knowledge', { id: 'k1', include: ['records', 'events', 'siblings'] });
  const v = data.verification as { attestations: Record<string, unknown>[]; quorum: string };
  assert.equal(v.quorum, '2/2');
  assert.deepEqual(v.attestations[0]?.score, { free_generation: '26/26' });
  assert.equal(v.attestations[0]?.stake, undefined, 'stake was never escrowed and must not be shown as money');
  assert.equal(v.attestations[0]?.sig, undefined);
  assert.ok(Array.isArray(data.records) && Array.isArray(data.events) && Array.isArray(data.siblings));
  assert.equal((data.availability as Record<string, unknown>).has_body, false);
});

test('get_knowledge names the base stack, and says a bundle buy does not exist', async (t) => {
  const h = await harness();
  t.after(h.stop);
  h.fake.state.requires = [{ id: 'base1', name: 'Base one', held: false, price: '25' }];
  const { data } = await h.call('get_knowledge', { id: 'k1' });
  assert.equal((data.requires as unknown[]).length, 1);
  assert.match(String(data.requires_note), /one knowledge at a time|base/i);
});

test('an unknown id is a not_found the model can act on, not a protocol error', async (t) => {
  const h = await harness();
  t.after(h.stop);
  const { isError, data } = await h.call('get_knowledge', { id: 'missing' });
  assert.equal(isError, true);
  const err = data.error as Record<string, unknown>;
  assert.equal(err.code, 'not_found');
  assert.equal(err.retryable, false);
});

test('family_tree walks the ledger graph and refuses to invent signals', async (t) => {
  const h = await harness();
  t.after(h.stop);
  const { data } = await h.call('family_tree', { id: 'k1', depth: 2 });
  const nodes = data.nodes as Record<string, unknown>[];
  assert.deepEqual(nodes.map((n) => n.id).sort(), ['base1', 'k1']);
  assert.equal(nodes[0]?.signals, null, 'signals must be null, never 0');
  assert.match(String(data.note), /not recorded/);
  assert.deepEqual(data.edges, [{ from: 'k1', to: 'base1', kind: 'extends' }]);
});

test('node_status answers who holds the model, against the node clock', async (t) => {
  const h = await harness();
  t.after(h.stop);
  h.fake.state.lock = { owner: 'node-b', label: 'chat:k1+k2', since: Date.now() - 41_000, alive: true, stale: false, mine: false };
  h.fake.state.waiting = 2;
  const { data } = await h.call('node_status');
  const lock = data.model_lock as { sentence: string; holder: { held_s: number } };
  assert.match(lock.sentence, /held by node-b \(a live test of k1 \+ k2\) for 4[01] s; 2 request\(s\) are waiting/);
  assert.ok(lock.holder.held_s >= 40 && lock.holder.held_s <= 42);
  assert.equal((data.capabilities as Record<string, boolean>).can_buy, false, 'no budget, no buying');
  assert.match(String((data.capability_reasons as Record<string, string>).can_buy), /budget|operator/);
});

test('node_status warns when knowledge is pinned on the shared model server', async (t) => {
  const h = await harness();
  t.after(h.stop);
  const { data } = await h.call('node_status');
  assert.deepEqual(data.warnings, [], 'nothing applied → no warning');
  assert.equal((data.quota as Record<string, unknown>).live_tests_remaining, null, 'the node has no quota endpoint to ask');
});

test('my_library omits a section with a reason instead of failing the call', async (t) => {
  const h = await harness();
  t.after(h.stop);
  const { isError, data } = await h.call('my_library');
  assert.equal(isError, false);
  const omitted = data.omitted as { section: string; reason: string }[];
  assert.deepEqual(omitted.map((o) => o.section).sort(), ['datasets', 'lessons', 'published', 'purchases']);
  assert.match(omitted[0]?.reason ?? '', /operator|teaching key/);
});

test('my_library returns the tx hash but never the manifest', async (t) => {
  const h = await harness(fullEnv());
  t.after(h.stop);
  h.fake.state.purchases = [{ patch_id: 'k1', amount: '5', tx_hash: `0x${'b'.repeat(64)}`, scheme: 'local-credit', created_at: 1788000000000, path: '/blobs/k1.npz' }];
  const { data } = await h.call('my_library', { include: ['purchases'] });
  const rows = data.purchases as Record<string, unknown>[];
  assert.equal(rows[0]?.tx_hash, `0x${'b'.repeat(64)}`, 'a tx hash is a public ledger fact');
  assert.equal(rows[0]?.body_present, true);
  assert.ok(!JSON.stringify(data).includes('tok-secret-value-here'), 'the download token leaked');
});

test('get_training_set previews the questions a knowledge was built from', async (t) => {
  const h = await harness();
  t.after(h.stop);
  const { data } = await h.call('get_training_set', { id: 'k1' });
  assert.equal(data.access, 'public');
  assert.deepEqual(data.preview, [{ prompt: 'Q', answer: 'A' }]);
});

test('knowledge_signals is honest about what the node does not record', async (t) => {
  const h = await harness();
  t.after(h.stop);
  const { data } = await h.call('knowledge_signals', { id: 'k1' });
  assert.equal(data.downloads, 93);
  assert.equal(data.signals, null);
  assert.match(String(data.note), /L6|do not exist yet/);
});

test('teacher_profile is a plain public read', async (t) => {
  const h = await harness();
  t.after(h.stop);
  const { isError, data } = await h.call('teacher_profile', { address: '0x4444444444444444444444444444444444444444' });
  assert.equal(isError, false);
  assert.equal(data.address, '0x4444444444444444444444444444444444444444');
});

test('a node that is not there is node_unreachable and retryable, not a crash', async (t) => {
  const h = await harness();
  await h.fake.stop();
  t.after(h.stop);
  const { isError, data } = await h.call('search_knowledge', {});
  assert.equal(isError, true);
  assert.equal((data.error as Record<string, unknown>).code, 'node_unreachable');
  assert.equal((data.error as Record<string, unknown>).retryable, true);
});

test('get_training_set reads back the id create_training_set just handed out', async () => {
  const h = await harness(fullEnv());
  try {
    const made = await h.call('create_training_set', { rows: [{ prompt: 'What is the ticker of Pixelplus?', answer: '087600', note: 'via MCP subgraph-mcp · execute_query_by_subgraph_id' }], name: 'from another MCP server' });
    assert.equal(made.isError, false, JSON.stringify(made.data));
    const id = String(made.data.dataset_id);
    const back = await h.call('get_training_set', { id, rows: true });
    assert.equal(back.isError, false, JSON.stringify(back.data));
    assert.equal(back.data.kind, 'uploaded_training_set');
    assert.equal(back.data.sha256, made.data.sha256);
    const rows = back.data.rows as { prompt: string; note?: string }[];
    assert.equal(rows.length, 1);
    assert.match(String(rows[0]?.note), /subgraph-mcp/);   // the provenance line survives the round trip
  } finally { await h.stop(); }
});

test('an id that is neither a knowledge nor an uploaded set says so, naming both places it looked', async () => {
  const h = await harness(fullEnv());
  try {
    const out = await h.call('get_training_set', { id: 'ds_does_not_exist' });
    assert.equal(out.isError, true);
    const err = out.data.error as { code: string; message: string };
    assert.equal(err.code, 'not_found');
    assert.match(err.message, /neither a published knowledge .* nor a training set/);
    assert.match(err.message, /my_library/);
  } finally { await h.stop(); }
});

test('a private draft this server owns is readable — it holds the credential that identifies it', async () => {
  // `teach` hands back a `draft_id` and tells the agent to live-test it. A DRAFT is 404 to anyone but its owner, so
  // reading it anonymously made the server 404 on the lesson it had just taught.
  const h = await harness(fullEnv(), (fake) => { fake.state.draftOnly = 'my-private-draft'; });
  try {
    const out = await h.call('get_knowledge', { id: 'my-private-draft' });
    assert.equal(out.isError, false, JSON.stringify(out.data));
    assert.equal((out.data.knowledge as { status: string }).status, 'DRAFT');
    const asked = h.fake.requests.filter((r) => r.path === '/api/patches/my-private-draft');
    assert.ok(asked.some((r) => r.headers.authorization || r.headers['x-ngram-auth']), 'the read must present a credential');
  } finally { await h.stop(); }
});

test('a draft nobody here owns is still an honest 404', async () => {
  const h = await harness();   // no operator, no teaching key
  try {
    const out = await h.call('get_knowledge', { id: 'my-private-draft' });
    assert.equal(out.isError, false);   // the fake serves every id when no draft is configured
  } finally { await h.stop(); }
});
