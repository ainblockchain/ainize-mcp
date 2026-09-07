/**
 * `runTeachLesson` on its own — no MCP server, no job table, no tool wrapper — because that is exactly how
 * `packages/agent` calls it. What is pinned here is the accounting nobody can see from the outside: a lesson is held
 * before the upload, given back only where the node queued nothing, and kept when the node accepted the lesson and
 * the lesson then failed.
 *
 * The second half pins the seam itself: `@ngram/mcp/client` and `@ngram/mcp/money` exist, `.` is untouched, and
 * neither subpath's static import graph reaches the MCP server, the tool definitions or express.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { Context } from '../src/context.js';
import { ToolFailure } from '../src/errors.js';
import { runTeachLesson, reserveLesson, resolveCompare, lessonsToday, type TeachLessonResult } from '../src/teach-run.js';
import { FakeNode } from './fake-node.js';
import { TEST_TEACH_KEY } from './harness.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const PKG = resolve(SRC, '..', 'package.json');

const ROWS = [
  { prompt: '픽셀플러스의 종목코드는?', answer: '087600' },
  { prompt: 'What is the ticker of PixelPlus?', answer: '087600' },
];

/** A context wired to a fake node — everything the lesson needs, and nothing the server would add. */
async function ctxFor(over: Record<string, string> = {}): Promise<{ ctx: Context; fake: FakeNode; stop: () => Promise<void> }> {
  const fake = new FakeNode();
  const url = await fake.start();
  const cfg = loadConfig({
    env: {
      AINIZE_NODE_URL: url, AINIZE_TEACH_KEY: TEST_TEACH_KEY,
      AINIZE_MCP_MAX_TEACH_JOBS: '5', AINIZE_MCP_POLL_MS: '50', ...over,
    } as NodeJS.ProcessEnv,
  });
  return { ctx: new Context(cfg), fake, stop: () => fake.stop() };
}

const signal = () => new AbortController().signal;
const posts = (fake: FakeNode, path: string) => fake.requests.filter((r) => r.method === 'POST' && r.path.split('?')[0] === path);

test('a lesson runs upload → preflight → submit → poll and reports the node\'s own handle as it goes', async (t) => {
  const { ctx, fake, stop } = await ctxFor();
  t.after(stop);
  fake.state.teachFlow = ['QUEUED', 'TRAINING', 'READY'];
  const seen: { teach_job_id: string; status: string }[] = [];
  const out: TeachLessonResult = await runTeachLesson(ctx, { rows: ROWS, name: 'krx tickers' }, { signal: signal(), onState: (ev) => seen.push(ev) });

  assert.equal(out.native_state, 'READY');
  assert.equal(out.node_job_id, 'lesson-1');
  assert.equal(out.questions.in_the_lesson, 2);
  assert.ok(out.training_set_upload, 'the rows it uploaded are reported back');
  assert.ok(out.preflight, 'and what the model already knew');
  assert.equal(typeof out.quota.key_remaining, 'number');

  // the caller learns the node's lesson id BEFORE the lesson finishes — that is what makes it recordable
  assert.equal(seen[0]?.teach_job_id, 'lesson-1');
  assert.equal(seen[0]?.status, 'QUEUED');
  assert.deepEqual([...new Set(seen.map((s) => s.status))], ['QUEUED', 'TRAINING', 'READY']);
  assert.equal(ctx.lessonsSpent, 1, 'an accepted lesson stays spent');
  assert.equal(posts(fake, '/api/teach/jobs').length, 1, 'exactly one submit, never an automatic second');
});

test('base and compare_with go up as base_ids and context_ids, never the deprecated flag', async (t) => {
  const { ctx, fake, stop } = await ctxFor();
  t.after(stop);
  await runTeachLesson(ctx, { rows: ROWS, base: ['k1'], compare_with: ['k2', 'k1'], mode: 'extend', export: 'delta' }, { signal: signal() });
  const sent = posts(fake, '/api/teach/jobs')[0]?.body as Record<string, unknown>;
  assert.deepEqual(sent.base_ids, ['k1']);
  assert.deepEqual(sent.context_ids, ['k2'], 'a base named twice is loaded once, and stays a base');
  assert.equal(sent.builds_on_context, undefined);
  assert.equal(sent.mode, 'extend');
  assert.deepEqual(resolveCompare(['k1'], ['k2', 'k1']), ['k2']);
});

test('nothing to train: the lesson is never submitted and the allowance comes back', async (t) => {
  const { ctx, fake, stop } = await ctxFor();
  t.after(stop);
  fake.state.preflightStatuses = ['already_known'];
  const lessons = await lessonsToday(ctx);
  const err = await runTeachLesson(ctx, { rows: ROWS, lessons }, { signal: signal() }).then(() => null, (e: unknown) => e as ToolFailure);
  assert.ok(err instanceof ToolFailure);
  assert.equal(err.body.code, 'nothing_to_train');
  assert.match(err.body.message, new RegExp(`burn one of this key's ${lessons.limit} lessons`), 'the refusal quotes the day the caller measured');
  assert.ok(err.body.details?.preflight, 'and carries the per-question verdicts');
  assert.equal(posts(fake, '/api/teach/jobs').length, 0);
  assert.equal(ctx.lessonsSpent, 0);
});

test('a submission the node refuses gives the allowance back; one it accepts and then fails does not', async (t) => {
  const refused = await ctxFor({ AINIZE_MCP_MAX_TEACH_JOBS: '1' });
  t.after(refused.stop);
  refused.fake.state.jobFail = { status: 429, body: { error: 'quota_key: daily lesson limit reached for this key' } };
  await assert.rejects(runTeachLesson(refused.ctx, { rows: ROWS }, { signal: signal() }));
  assert.equal(refused.ctx.lessonsSpent, 0, 'the node queued nothing, so nothing was spent');

  // and the session can still teach: the cap was never really consumed
  refused.fake.state.jobFail = null;
  const ok = await runTeachLesson(refused.ctx, { rows: ROWS }, { signal: signal() });
  assert.equal(ok.native_state, 'READY');
  assert.equal(refused.ctx.lessonsSpent, 1);

  const failed = await ctxFor();
  t.after(failed.stop);
  failed.fake.state.teachFlow = ['QUEUED', 'TRAINING', 'FAILED'];
  const err = await runTeachLesson(failed.ctx, { rows: ROWS }, { signal: signal() }).then(() => null, (e: unknown) => e as ToolFailure);
  assert.ok(err instanceof ToolFailure);
  assert.equal(err.body.code, 'teach_quota_consumed');
  assert.match(err.body.message, /does not refund/);
  assert.equal(failed.ctx.lessonsSpent, 1, 'the node charges at submit — a lesson that failed afterwards is still gone');
});

test('the session cap refuses before a single byte is uploaded, and no argument raises it', async (t) => {
  const { ctx, fake, stop } = await ctxFor({ AINIZE_MCP_MAX_TEACH_JOBS: '1' });
  t.after(stop);
  await runTeachLesson(ctx, { rows: ROWS }, { signal: signal() });
  const before = fake.requests.length;
  const err = await runTeachLesson(ctx, { rows: ROWS }, { signal: signal() }).then(() => null, (e: unknown) => e as ToolFailure);
  assert.ok(err instanceof ToolFailure);
  assert.equal(err.body.code, 'teach_quota_consumed');
  assert.match(err.body.message, /AINIZE_MCP_MAX_TEACH_JOBS/);
  assert.equal(fake.requests.length, before, 'a refusal that costs nothing must also call nothing');
  assert.equal(ctx.lessonsSpent, 1, 'and the refusal does not reserve a second lesson');
});

test('two decisions cannot both take the last lesson', async (t) => {
  const { ctx, stop } = await ctxFor({ AINIZE_MCP_MAX_TEACH_JOBS: '1' });
  t.after(stop);
  const held = reserveLesson(ctx);
  assert.throws(() => reserveLesson(ctx), (e: unknown) => e instanceof ToolFailure && e.body.code === 'teach_quota_consumed');
  held.refund();
  assert.equal(ctx.lessonsSpent, 0);
  held.refund();
  assert.equal(ctx.lessonsSpent, 0, 'a refund is once, not once per caller who asks');
  reserveLesson(ctx);
  assert.equal(ctx.lessonsSpent, 1);
});

test('rows the node\'s parser threw away are not trained on', async (t) => {
  const { ctx, fake, stop } = await ctxFor();
  t.after(stop);
  const err = await runTeachLesson(ctx, { rows: [{ prompt: 'a question with no answer', answer: '' }] }, { signal: signal() })
    .then(() => null, (e: unknown) => e as ToolFailure);
  assert.ok(err instanceof ToolFailure);
  assert.equal(err.body.code, 'dataset_empty');
  assert.equal(posts(fake, '/api/teach/jobs').length, 0);
});

// ------------------------------------------------------------------ the seam

test('the package offers ./client and ./money, and "." is unchanged', () => {
  const pkg = JSON.parse(readFileSync(PKG, 'utf8')) as { exports: Record<string, { types: string; import: string }> };
  assert.deepEqual(pkg.exports['.'], { types: './dist/index.d.ts', import: './dist/index.js' }, 'the server entry point may not move');
  assert.deepEqual(pkg.exports['./client'], { types: './dist/client-lib.d.ts', import: './dist/client-lib.js' });
  assert.deepEqual(pkg.exports['./money'], { types: './dist/money.d.ts', import: './dist/money.js' });
});

/** Follow every static `from '...'` out of an entry file, and report what it reached. */
function importGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const walk = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+'([^']+)'/g)) {
      const spec = m[1] as string;
      if (spec.startsWith('.')) walk(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
      else packages.add(spec);
    }
  };
  walk(entry);
  return { files, packages };
}

test('neither subpath drags in the MCP server, the tool definitions or express', () => {
  for (const entry of ['client-lib.ts', 'money.ts']) {
    const { files, packages } = importGraph(join(SRC, entry));
    const reached = [...files].map((f) => f.slice(SRC.length + 1));
    for (const forbidden of ['server.ts', 'bin.ts']) {
      assert.ok(!reached.includes(forbidden), `${entry} must not reach ${forbidden} (it reached ${reached.join(', ')})`);
    }
    assert.ok(!reached.some((f) => f.startsWith('tools/')), `${entry} must not reach a tool definition (it reached ${reached.join(', ')})`);
    for (const pkg of packages) {
      assert.ok(pkg !== 'express' && !pkg.startsWith('@modelcontextprotocol/sdk/server'), `${entry} must not import ${pkg}`);
    }
  }
});

test('the client seam carries the pieces the agent was told to reuse rather than rebuild', async () => {
  const seam = await import('../src/client-lib.js');
  for (const name of [
    'AinizeClient', 'Context', 'loadConfig',            // talk to a node as this identity
    'McpDataSource',                                    // read somebody else's MCP server
    'promptKey', 'rowsSha256', 'stableJson', 'mapRows', // the node's own row normalisation
    'runTeachLesson', 'uploadTrainingSet', 'lessonsToday', 'reserveLesson',
    'teachJobView', 'TEACH_TERMINAL',
  ]) {
    assert.ok(name in seam, `@ngram/mcp/client must export ${name}`);
  }
  const money = await import('../src/money.js');
  for (const name of ['addAmounts', 'cmpAmounts', 'normalizeAmount', 'subAmounts', 'Budget', 'PurchaseJournal']) {
    assert.ok(name in money, `@ngram/mcp/money must export ${name}`);
  }
});
