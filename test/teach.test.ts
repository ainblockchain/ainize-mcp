/**
 * The teach tier against a fake node that records every request — so these tests can assert what was NOT called,
 * which is the only way to prove a refusal was free.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fullEnv, harness, pollUntilFinished } from './harness.js';

const ROWS = [
  { prompt: '픽셀플러스의 종목코드는?', answer: '087600' },
  { prompt: 'What is the ticker of PixelPlus?', answer: '087600' },
  { prompt: 'What is the WETH contract address?', answer: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' },
];

// AINIZE_MCP_POLL_MS keeps the lesson poll loop from making a three-step fake lesson take nine seconds.
const teachEnv = (over: Record<string, string> = {}) => fullEnv({ AINIZE_MCP_MAX_TEACH_JOBS: '5', AINIZE_MCP_POLL_MS: '50', ...over });

const posts = (h: Awaited<ReturnType<typeof harness>>, path: string) =>
  h.fake.requests.filter((r) => r.method === 'POST' && r.path.split('?')[0] === path);

test('create_training_set uploads the rows, reports what was refused, and predicts the id the bytes land on', async (t) => {
  const h = await harness(teachEnv());
  t.after(h.stop);
  const { isError, data } = await h.call('create_training_set', { rows: [...ROWS, { prompt: 'blank answer', answer: ' ' }], name: 'krx facts' });
  assert.equal(isError, false, JSON.stringify(data));
  assert.equal(data.rows_accepted, 4);          // the fake accepts a whitespace answer; the real node normalises it
  assert.equal(data.existing, false);
  assert.equal(typeof data.dataset_id, 'string');
  assert.equal(typeof data.predicted_sha256, 'string');
  assert.match(String(data.note), /new training set/);
});

test('the same rows twice land on the same training set instead of a second copy', async (t) => {
  const h = await harness(teachEnv());
  t.after(h.stop);
  const first = await h.call('create_training_set', { rows: ROWS });
  const again = await h.call('create_training_set', { rows: ROWS });
  assert.equal(again.data.dataset_id, first.data.dataset_id);
  assert.equal(again.data.existing, true);
  assert.match(String(again.data.note), /already on the node/);
});

test('provenance from another MCP server is written onto the rows and kept beside the journal', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ainize-mcp-test-'));
  const h = await harness(teachEnv({ AINIZE_MCP_STATE_DIR: dir }));
  t.after(h.stop);
  const provenance = {
    source: 'mcp',
    server: { name: 'subgraph-mcp', url: 'https://subgraphs.mcp.thegraph.com/sse', transport: 'sse', protocol_version: '2024-11-05', authenticated: true },
    tool: 'execute_query_by_subgraph_id',
    arguments: { subgraph_id: '5zvR82', query: '{ tokens { id } }' },
    arguments_sha256: 'a'.repeat(64),
    fetched_at: 1788000000000,
    upstream: { subgraph_id: '5zvR82', block: 25903086 },
    row_hashes: [], rows_sha256: 'b'.repeat(64), rows: 3,
  };
  const { data } = await h.call('create_training_set', { rows: ROWS, provenance });
  const sent = posts(h, '/api/teach/datasets')[0]?.body as { rows: { note?: string }[] };
  for (const row of sent.rows) assert.match(String(row.note), /via MCP subgraph-mcp · execute_query_by_subgraph_id · subgraph_id 5zvR82 · block 25903086/);
  const record = (data.provenance as Record<string, unknown>);
  assert.equal(record.recorded, 'client-declared');
  assert.equal(record.note_on_rows, 3);
  const stored = JSON.parse(readFileSync(String(record.stored_at), 'utf8')) as Record<string, unknown>;
  assert.equal(stored.tool, 'execute_query_by_subgraph_id');
  assert.equal(stored.dataset_id, data.dataset_id);
});

test('teach_preflight answers per question, with what the model said', async (t) => {
  const h = await harness(teachEnv());
  t.after(h.stop);
  h.fake.state.preflightStatuses = ['will_train', 'already_known', 'overlaps_listing'];
  const start = await h.call('teach_preflight', { rows: ROWS });
  assert.equal(start.isError, false, JSON.stringify(start.data));
  assert.match(String(start.data.job_id), /^tp_/);
  assert.match(String(start.data.cost), /free live-test units/);
  const { data } = await pollUntilFinished(h, start.data.job_id as string);
  assert.equal(data.state, 'done');
  const r = data.result as { trainable: number; items: { status: string; question: string; meaning: string }[] };
  assert.equal(r.trainable, 1);
  assert.equal(r.items[0]?.status, 'will_train');
  assert.equal(r.items[1]?.status, 'already_known');
  assert.match(String(r.items[1]?.meaning), /already answers this correctly/);
  assert.equal(r.items[0]?.question, ROWS[0]?.prompt);
  const quota = data.result as { lessons_left_today: { key: number; address: number }; cost_note: string };
  assert.equal(quota.lessons_left_today.key, 19, 'the node answers with daily LESSON counters here, and the field says so');
  assert.match(quota.cost_note, /live-test units/);
});

test('teach refuses to spend a lesson on questions the model already answers, and creates no lesson', async (t) => {
  const h = await harness(teachEnv());
  t.after(h.stop);
  h.fake.state.preflightStatuses = ['already_known'];
  const start = await h.call('teach', { rows: ROWS });
  const { isError, data } = await pollUntilFinished(h, start.data.job_id as string);
  assert.equal(isError, false);
  assert.equal(data.state, 'failed');
  const err = data.error as { code: string; message: string; details: Record<string, unknown> };
  assert.equal(err.code, 'nothing_to_train');
  assert.match(err.message, /already answered correctly/);
  assert.ok(err.details.preflight, 'the refusal carries the per-question verdicts');
  assert.equal(posts(h, '/api/teach/jobs').length, 0, 'no lesson may be submitted when there is nothing to train');
  assert.equal(h.ctx.lessonsSpent, 0, 'and the session lesson budget is given back');
});

test('teach: a job handle in milliseconds, then what it learned and what it did not', async (t) => {
  const h = await harness(teachEnv());
  t.after(h.stop);
  h.fake.state.teachFlow = ['QUEUED', 'TRAINING', 'READY'];
  const t0 = Date.now();
  const start = await h.call('teach', { rows: ROWS, name: 'krx tickers' });
  assert.equal(start.isError, false, JSON.stringify(start.data));
  assert.ok(Date.now() - t0 < 250, `teach must not block (took ${Date.now() - t0} ms)`);
  assert.match(String(start.data.job_id), /^th_/);
  assert.equal(start.data.state, 'queued');
  assert.match(String(start.data.what_happens_next), /asked what it already knows/);

  const { data } = await pollUntilFinished(h, start.data.job_id as string);
  assert.equal(data.state, 'done', JSON.stringify(data));
  const r = data.result as Record<string, unknown>;
  assert.equal(r.native_state, 'READY');
  assert.match(String(r.what_is_happening), /the lesson stuck/);
  const q = r.questions as { in_the_lesson: number; learned: number; not_learned: number; still_wrong: { question: string }[] };
  assert.equal(q.in_the_lesson, 3);
  assert.equal(q.learned, 2);
  assert.equal(q.not_learned, 1);
  assert.equal(q.still_wrong[0]?.question, ROWS[0]?.prompt);
  const checks = r.checks as { simulated: boolean; publish_gate: string; note: string };
  assert.equal(checks.simulated, true);
  assert.match(checks.note, /STUB backend/);
  assert.equal(r.draft_id, 'taught-draft-1');
  assert.match(String((r.next_steps as string[])[0]), /live_test with knowledge: \["taught-draft-1"\]/);
  const sent = posts(h, '/api/teach/jobs')[0]?.body as Record<string, unknown>;
  assert.equal(sent.builds_on_context, undefined, 'the deprecated flag is never sent');
  assert.ok(sent.dataset_id, 'a lesson is always taught from a training set');
});

test('teach on top of a base sends base_ids, never context_ids, and says what it is building on', async (t) => {
  const h = await harness(teachEnv());
  t.after(h.stop);
  h.fake.state.teachBases = [{ patch_id: 'k1', sha256: 'c'.repeat(64), name: 'Knowledge k1', status: 'LISTED' }];
  const start = await h.call('teach', { rows: ROWS, base: ['k1'], compare_with: ['k2'], mode: 'extend', export: 'delta' });
  assert.equal(start.isError, false, JSON.stringify(start.data));
  const built = start.data.built_on as { id: string; name: string; status: string }[];
  assert.equal(built[0]?.id, 'k1');
  assert.equal(built[0]?.status, 'LISTED');
  await pollUntilFinished(h, start.data.job_id as string);
  const sent = posts(h, '/api/teach/jobs')[0]?.body as Record<string, unknown>;
  assert.deepEqual(sent.base_ids, ['k1']);
  assert.deepEqual(sent.context_ids, ['k2']);
  assert.equal(sent.mode, 'extend');
  assert.equal(sent.export, 'delta');
});

test('teach dry_run resolves everything and touches nothing', async (t) => {
  const h = await harness(teachEnv());
  t.after(h.stop);
  const { isError, data } = await h.call('teach', { rows: ROWS, base: ['k1'], dry_run: true });
  assert.equal(isError, false);
  assert.equal(data.dry_run, true);
  assert.equal((data.would_teach as { rows: number }).rows, 3);
  assert.match(String(data.what_it_would_cost), /daily lessons/);
  assert.equal(posts(h, '/api/teach/datasets').length, 0);
  assert.equal(posts(h, '/api/teach/preflight').length, 0, 'a dry run must not spend live-test units either');
  assert.equal(posts(h, '/api/teach/jobs').length, 0);
  assert.equal(h.ctx.lessonsSpent, 0);
});

test('the last lesson of the day needs the human to say so', async (t) => {
  const h = await harness(teachEnv());
  t.after(h.stop);
  h.fake.state.jobsPerKeyPerDay = 3;
  h.fake.state.lessonsUsedToday = 2;            // one left
  const refused = await h.call('teach', { rows: ROWS });
  assert.equal(refused.isError, true);
  const err = refused.data.error as { code: string; message: string };
  assert.equal(err.code, 'confirmation_required');
  assert.match(err.message, /last lesson/);
  assert.equal(posts(h, '/api/teach/jobs').length, 0);
  const ok = await h.call('teach', { rows: ROWS, confirm: true });
  assert.equal(ok.isError, false);
});

test('the session lesson cap is server configuration, and no argument raises it', async (t) => {
  const h = await harness(teachEnv({ AINIZE_MCP_MAX_TEACH_JOBS: '1' }));
  t.after(h.stop);
  const first = await h.call('teach', { rows: ROWS });
  await pollUntilFinished(h, first.data.job_id as string);
  const second = await h.call('teach', { rows: ROWS });
  assert.equal(second.isError, true);
  const err = second.data.error as { code: string; message: string };
  assert.equal(err.code, 'teach_quota_consumed');
  assert.match(err.message, /AINIZE_MCP_MAX_TEACH_JOBS/);
});

test('a base that cannot be built on is refused before anything is spent', async (t) => {
  const h = await harness(teachEnv());
  t.after(h.stop);
  const { isError, data } = await h.call('teach', { rows: ROWS, base: ['missing'] });
  assert.equal(isError, true);
  const err = data.error as { code: string; message: string };
  assert.equal(err.code, 'base_rejected');
  assert.match(err.message, /no such knowledge/);
  assert.equal(posts(h, '/api/teach/datasets').length, 0);
});

test('two bases is a merge, and no node can do that yet', async (t) => {
  const h = await harness(teachEnv());
  t.after(h.stop);
  const { isError, data } = await h.call('teach', { rows: ROWS, base: ['k1', 'k2'] });
  assert.equal(isError, true);
  assert.equal((data.error as { code: string }).code, 'merge_not_available');
});

test('a failed lesson says the daily lesson is gone and is never retried', async (t) => {
  const h = await harness(teachEnv());
  t.after(h.stop);
  h.fake.state.teachFlow = ['QUEUED', 'TRAINING', 'FAILED'];
  const start = await h.call('teach', { rows: ROWS });
  const { data } = await pollUntilFinished(h, start.data.job_id as string);
  assert.equal(data.state, 'failed');
  const err = data.error as { code: string; message: string; retryable: boolean };
  assert.equal(err.code, 'teach_quota_consumed');
  assert.match(err.message, /does not refund/);
  assert.equal(err.retryable, false);
  assert.equal(posts(h, '/api/teach/jobs').length, 1, 'exactly one submit, never an automatic second');
});

test('a lesson can be polled by the node id alone, so a lost job_id is not a dead end', async (t) => {
  const h = await harness(teachEnv());
  t.after(h.stop);
  const start = await h.call('teach', { rows: ROWS });
  const first = await pollUntilFinished(h, start.data.job_id as string);
  const nodeId = (first.data.result as { node_job_id: string }).node_job_id;
  const again = await h.call('job_status', { job_id: nodeId });
  assert.equal(again.isError, false);
  assert.equal(again.data.node_job_id, nodeId);
  assert.equal(again.data.native_state, 'READY');
  assert.match(String(again.data.from), /not this session/);
});

test('download_lesson writes the files here and never hands back the download token', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ainize-mcp-dl-'));
  const h = await harness(teachEnv({ AINIZE_MCP_DOWNLOAD_DIR: dir }));
  t.after(h.stop);
  const start = await h.call('teach', { rows: ROWS });
  const done = await pollUntilFinished(h, start.data.job_id as string);
  const nodeId = (done.data.result as { node_job_id: string }).node_job_id;
  const { isError, data } = await h.call('download_lesson', { lesson_id: nodeId });
  assert.equal(isError, false, JSON.stringify(data));
  const files = data.files as { what: string; path: string; bytes: number }[];
  assert.deepEqual(files.map((f) => f.what).sort(), ['knowledge_file', 'notes', 'recipe']);
  assert.equal(readFileSync(files.find((f) => f.what === 'knowledge_file')!.path, 'utf8'), 'NPZFAKE\n');
  assert.match(String(data.privacy), /still a private draft/);
  assert.ok(!JSON.stringify(data).includes('tok-download-secret'), 'the node\'s download token must never reach the model');
});

test('cancelling a lesson says the daily lesson is not coming back', async (t) => {
  const h = await harness(teachEnv());
  t.after(h.stop);
  h.fake.state.teachFlow = ['QUEUED', 'QUEUED', 'QUEUED', 'READY'];
  const start = await h.call('teach', { rows: ROWS });
  // wait until the lesson exists on the node, then give up on it
  for (let i = 0; i < 40 && !h.ctx.jobs.get(start.data.job_id as string)?.native.teach_job_id; i++) await new Promise((r) => setTimeout(r, 50));
  const { data } = await h.call('job_cancel', { job_id: start.data.job_id as string });
  assert.equal(data.charged, true);
  assert.match(String(data.note), /NOT returned/);
});

test('publish is refused outright on the shared AIN chain', async (t) => {
  const h = await harness(teachEnv({ AINIZE_MCP_ALLOW_PUBLISH: '1' }), (fake) => { fake.state.ledger = 'ain'; });
  t.after(h.stop);
  const { isError, data } = await h.call('publish_knowledge', { lesson_id: 'lesson-1', name: 'anything' });
  assert.equal(isError, true);
  const err = data.error as { code: string; message: string };
  assert.equal(err.code, 'permanent_ledger_refused');
  assert.match(err.message, /node-u|local ledger/);
  assert.equal(h.fake.published.length, 0);
});

test('publish dry_run shows the real split — 49%, not the sheet\'s 70% — and writes nothing', async (t) => {
  const h = await harness(teachEnv({ AINIZE_MCP_ALLOW_PUBLISH: '1' }));
  t.after(h.stop);
  h.fake.state.teachBases = [{ patch_id: 'k1', sha256: 'c'.repeat(64), name: 'Knowledge k1', status: 'LISTED' }];
  const start = await h.call('teach', { rows: ROWS, base: ['k1'] });
  const done = await pollUntilFinished(h, start.data.job_id as string);
  const nodeId = (done.data.result as { node_job_id: string }).node_job_id;
  const { isError, data } = await h.call('publish_knowledge', { lesson_id: nodeId, name: 'KRX tickers', price: '10', dry_run: true });
  assert.equal(isError, false, JSON.stringify(data));
  const split = data.split_preview as Record<string, { amount: string; share: string; applies?: boolean }> & { explanation: string };
  assert.equal(split.to_the_people_it_was_built_on?.amount, '3');
  assert.equal(split.to_you_the_teacher?.amount, '4.9');
  assert.equal(split.to_you_the_teacher?.share, '49%');
  assert.equal(split.to_this_node?.amount, '2.1');
  assert.match(split.explanation, /share of the remainder, not of the price/);
  assert.equal(data.confirm_phrase_required, `publish ${nodeId} permanently`);
  assert.equal(h.fake.published.length, 0);
});

test('publish needs both consents and a phrase carrying the lesson id', async (t) => {
  const h = await harness(teachEnv({ AINIZE_MCP_ALLOW_PUBLISH: '1' }));
  t.after(h.stop);
  const start = await h.call('teach', { rows: ROWS });
  const done = await pollUntilFinished(h, start.data.job_id as string);
  const id = (done.data.result as { node_job_id: string }).node_job_id;

  const noConsent = await h.call('publish_knowledge', { lesson_id: id, name: 'KRX tickers', confirm_phrase: `publish ${id} permanently` });
  assert.equal((noConsent.data.error as { code: string }).code, 'confirmation_required');
  const wrongPhrase = await h.call('publish_knowledge', { lesson_id: id, name: 'KRX tickers', consent_permanent: true, consent_rights: true, confirm_phrase: 'yes' });
  assert.equal((wrongPhrase.data.error as { code: string }).code, 'confirmation_required');
  assert.match((wrongPhrase.data.error as { message: string }).message, /pattern-matching "yes"/);
  assert.equal(h.fake.published.length, 0);

  const ok = await h.call('publish_knowledge', {
    lesson_id: id, name: 'KRX tickers', price: '5', consent_permanent: true, consent_rights: true,
    confirm_phrase: `publish ${id} permanently`,
    training_set: { access: 'derivative', include_notes: true, source: 'public', no_pii: true },
  });
  assert.equal(ok.isError, false, JSON.stringify(ok.data));
  assert.equal(ok.data.status, 'ANNOUNCED');
  assert.equal(ok.data.irreversible, true);
  assert.equal(h.fake.published.length, 1);
  const body = h.fake.published[0]?.body as { consent: Record<string, boolean>; dataset: { access: string; declaration: { source: string; no_pii: boolean } } };
  assert.deepEqual(body.consent, { permanent: true, rights: true });
  assert.equal(body.dataset.access, 'derivative');
  assert.deepEqual(body.dataset.declaration, { source: 'public', no_pii: true });
  assert.ok(!JSON.stringify(ok.data).includes('claim-to-sign'.repeat(1) + 'x'), 'no signature material leaks');
});

test('publish is not registered at all unless the operator turned it on', async (t) => {
  const h = await harness(teachEnv());
  t.after(h.stop);
  assert.ok(!h.names.includes('publish_knowledge'));
  assert.ok(h.names.includes('teach'));
});

test('with no teaching key there is no teach tool to call', async (t) => {
  const h = await harness({});
  t.after(h.stop);
  for (const name of ['teach', 'teach_preflight', 'create_training_set', 'download_lesson']) {
    assert.ok(!h.names.includes(name), `${name} must not be offered without a teaching key`);
  }
  assert.match(h.ctx.capabilityReasons().can_teach ?? '', /AINIZE_TEACH_KEY/);
});

test('a submission the node refuses gives this session\'s lesson allowance back', async () => {
  // The node charges a daily lesson at SUBMIT time — but only when it accepts one. A 429/400 refusal queues
  // nothing and charges nothing, so a server capped at one lesson must not lose its only allowance to it.
  const h = await harness(fullEnv({ AINIZE_MCP_MAX_TEACH_JOBS: '1' }), (fake) => {
    fake.state.jobFail = { status: 429, body: { error: 'quota_key: daily lesson limit reached for this key' } };
  });
  try {
    const first = await h.call('teach', { rows: [{ prompt: 'Q?', answer: 'A' }], confirm: true });
    const landed = await pollUntilFinished(h, String(first.data.job_id));
    assert.equal(landed.data.state, 'failed');
    assert.equal(h.ctx.lessonsSpent, 0, 'a refused submission must not spend the session allowance');

    h.fake.state.jobFail = null;
    const second = await h.call('teach', { rows: [{ prompt: 'Q2?', answer: 'B' }], confirm: true });
    assert.equal(second.isError, false, `the next attempt must not be refused by a cap nothing was spent from: ${JSON.stringify(second.data)}`);
  } finally { await h.stop(); }
});

test('a lesson the node ACCEPTED and then failed still counts — the node charges at submit', async () => {
  const h = await harness(fullEnv({ AINIZE_MCP_MAX_TEACH_JOBS: '1' }), (fake) => { fake.state.teachStatus = 'FAILED'; });
  try {
    const first = await h.call('teach', { rows: [{ prompt: 'Q?', answer: 'A' }], confirm: true });
    await pollUntilFinished(h, String(first.data.job_id));
    assert.equal(h.ctx.lessonsSpent, 1, 'an accepted lesson is charged whatever happens to it afterwards');
    const second = await h.call('teach', { rows: [{ prompt: 'Q2?', answer: 'B' }], confirm: true });
    assert.equal(second.isError, true);
    assert.equal((second.data.error as { code: string }).code, 'teach_quota_consumed');
  } finally { await h.stop(); }
});
