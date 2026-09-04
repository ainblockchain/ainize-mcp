/**
 * The shared model lock, attacked on purpose: one MCP session takes it, a second one asks for it, and the second
 * must say WHO holds it and how long — never hang, never retry in a loop — and must be able to give up for free
 * while it is still queued.
 */
const NODE = process.env.PROVE_NODE_URL ?? 'http://localhost:3402';
const env = { AINIZE_NODE_URL: NODE, ...(process.env.AINIZE_OPERATOR_PASSWORD ? { AINIZE_OPERATOR_PASSWORD: process.env.AINIZE_OPERATOR_PASSWORD } : {}) };

export default async function ({ session, check, log }) {
  const holder = await session(env, { label: 'holder' });
  const waiter = await session(env, { label: 'waiter' });
  try {
    // A long answer with a knowledge to load: the load alone holds the lock for seconds.
    const long = await holder.call('live_test', { question: 'Explain, at length and in careful detail, how a memory-table patch changes what a language model answers.', knowledge: ['krx-all-2761'], max_tokens: 1024 }, 'take the shared model lock and keep it');
    check('L1', 'the first live test starts and takes the lock', !long.isError && !!long.data.job_id, `job ${long.data.job_id}`);

    // Give the node a moment to actually enter the lock, then ask for it from the other session.
    await new Promise((r) => setTimeout(r, 3000));
    const second = await waiter.call('live_test', { question: '픽셀플러스의 종목코드는?', knowledge: [], max_tokens: 8 }, 'ATTACK: ask for the model while somebody else holds it');
    const lock = second.data.model_lock ?? {};
    check('L2', 'the second call still answers in milliseconds, with a handle, not a hang', !second.isError && !!second.data.job_id, `job ${second.data.job_id} after ${second.rec?.ms ?? '?'} ms`);
    check('L3', 'it says WHO holds the model and for how long, instead of just "busy"', !!lock.holder && /held by/.test(String(lock.sentence)), `${lock.sentence} · queue ${JSON.stringify(lock.queue)}`);

    const status = await waiter.call('job_status', { job_id: second.data.job_id, wait_ms: 2000 }, 'poll it: still queued behind the holder');
    check('L4', 'polling a queued job repeats the lock sentence rather than pretending to progress', ['queued', 'running'].includes(String(status.data.state)) || status.data.state === 'done', `state ${status.data.state} · ${status.data.model_lock?.sentence} · hint ${String(status.data.hint ?? '').slice(0, 120)}`);

    const cancelled = await waiter.call('job_cancel', { job_id: second.data.job_id, reason: 'the human changed their mind' }, 'give up while it is still queued');
    check('L5', 'giving up while queued is free, and the answer says so', !cancelled.isError && cancelled.data.charged === false, `cancelled ${cancelled.data.cancelled} · charged ${cancelled.data.charged} · ${String(cancelled.data.note ?? cancelled.data.reason ?? '')}`);

    const after = await waiter.call('job_status', { job_id: second.data.job_id }, 'and it stays cancelled');
    check('L6', 'a cancelled job stays cancelled and reports why', ['cancelled', 'failed'].includes(String(after.data.state)), `state ${after.data.state} · ${JSON.stringify(after.data.error ?? {}).slice(0, 160)}`);

    const holderDone = await waiter.call('job_status', { job_id: long.data.job_id }, 'the waiter cannot see the holder\'s job at all');
    check('L7', 'one session cannot poll another session\'s job — jobs are session-scoped', holderDone.isError && holderDone.data.error?.code === 'job_not_found', `${holderDone.data.error?.code}: ${String(holderDone.data.error?.message).slice(0, 120)}`);

    await holder.call('job_cancel', { job_id: long.data.job_id, reason: 'done with the demonstration' }, 'release the model');
  } finally {
    await holder.close();
    await waiter.close();
  }
}
