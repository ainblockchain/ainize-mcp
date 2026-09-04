import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobTable } from '../src/jobs.js';

const never = () => new Promise<never>(() => {});

test('starting a job returns before the upstream call has finished', async () => {
  const jobs = new JobTable();
  const t0 = Date.now();
  const job = jobs.start({ kind: 'live_test', run: async () => { await new Promise((r) => setTimeout(r, 300)); return { done: true }; } });
  assert.ok(Date.now() - t0 < 50, 'start must not await the upstream promise');
  assert.equal(job.state, 'queued');
  await jobs.waitForChange(job.id, 1000);
  assert.equal(jobs.get(job.id)?.state, 'done');
  assert.deepEqual(jobs.get(job.id)?.result, { done: true });
});

test('a cancelled job stays cancelled and its abort signal reaches the upstream call', async () => {
  const jobs = new JobTable();
  let aborted = false;
  const job = jobs.start({ kind: 'live_test', run: (signal) => { signal.addEventListener('abort', () => { aborted = true; }); return never(); } });
  jobs.abort(job.id);
  assert.equal(jobs.get(job.id)?.state, 'cancelled');
  assert.equal(aborted, true);
});

test('a failed job keeps its error, and job_list is newest first', async () => {
  const jobs = new JobTable();
  const bad = jobs.start({ kind: 'buy', run: async () => { throw new Error('boom'); } });
  await jobs.waitForChange(bad.id, 500);
  assert.equal(jobs.get(bad.id)?.state, 'failed');
  assert.match(String((jobs.get(bad.id)?.error as Error).message), /boom/);
  const later = jobs.start({ kind: 'apply', run: async () => 1 });
  assert.equal(jobs.list()[0]?.id, later.id);
  assert.equal(jobs.list({ kind: 'buy' }).length, 1);
});

test('finished jobs are evicted after the TTL, running ones are not', async () => {
  let now = 1_000_000;
  const jobs = new JobTable(1000, () => now);
  const done = jobs.start({ kind: 'live_test', run: async () => 'x' });
  const running = jobs.start({ kind: 'live_test', run: never });
  await jobs.waitForChange(done.id, 500);
  now += 5000;
  assert.equal(jobs.get(done.id), null, 'a finished job is evicted');
  assert.ok(jobs.get(running.id), 'a job still in flight is never evicted');
});

test('waitForChange is a local long-poll: it returns on the state change, not on a timer', async () => {
  const jobs = new JobTable();
  const job = jobs.start({ kind: 'live_test', run: async () => { await new Promise((r) => setTimeout(r, 50)); return 1; } });
  const t0 = Date.now();
  await jobs.waitForChange(job.id, 5000);
  assert.ok(Date.now() - t0 < 2000, 'it must wake on the change, not wait out the whole window');
});
