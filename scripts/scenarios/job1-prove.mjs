/**
 * Job 1 — "find a knowledge that answers Korean stock ticker questions and prove it works".
 *
 * Driven against node-a (:3402, the AIN-chain demo cluster) through a real MCP client. Read-only plus two live
 * tests: `/api/chat` loads the patch, answers, and puts the table back, so the cluster is left as found.
 */
export default async function ({ session, check, pollJob, log }) {
  const s = await session({ AINIZE_NODE_URL: 'http://localhost:3402' }, { label: 'node-a' });
  try {
    const tools = await s.tools();
    const names = tools.map((t) => t.name);
    check('J1.0', 'a real MCP client completes the handshake and lists tools', names.length > 0, `${names.length} tools: ${names.join(', ')}`);
    check('J1.0b', 'a read-only server registers no money-spending or mutating tool', !names.includes('buy') && !names.includes('apply_knowledge') && !names.includes('teach'), `registered: ${names.join(', ')}`);
    await s.resources();

    // --- find it -------------------------------------------------------------------------------------------------
    const found = await s.call('search_knowledge', { query: 'ticker', limit: 10 }, 'the agent looks for something that answers Korean ticker questions');
    const items = found.data.items ?? [];
    check('J1.1', 'search finds Korean ticker knowledge with price and verification on the row', !found.isError && items.length > 0 && items.every((i) => i.price !== undefined && i.verification), `${items.length} hits · facets ${JSON.stringify(found.data.facets)}`);
    const listed = items.filter((i) => i.status === 'LISTED');
    log('hits:', items.map((i) => `${i.id} ${i.price}${i.currency} ${i.status} ${i.verification?.passed}/${i.verification?.quorum}`).join(' | '));

    const target = (listed[0] ?? items[0]).id;

    // --- read it -------------------------------------------------------------------------------------------------
    const detail = await s.call('get_knowledge', { id: target }, 'who verified it, with what score');
    const v = detail.data.verification ?? {};
    const scored = (v.attestations ?? []).filter((a) => a.score !== null && a.score !== undefined);
    check('J1.2', 'detail names the verifiers and the score each one measured', !detail.isError && scored.length >= 1, `${v.passed}/${v.quorum} · ${scored.map((a) => `${a.verifier_name ?? a.verifier} ${a.score}`).join(', ')}`);

    // --- prove it: the bare model first ---------------------------------------------------------------------------
    const question = '픽셀플러스의 종목코드는 무엇인가요? 숫자만 답하세요.';
    const bare = await s.call('live_test', { question, knowledge: [], max_tokens: 32 }, 'BEFORE: the bare model, no knowledge loaded');
    check('J1.3', 'live_test answers with a job handle immediately instead of blocking on the model lock', !bare.isError && !!bare.data.job_id && bare.rec === undefined, `job ${bare.data.job_id} · lock: ${bare.data.model_lock?.sentence ?? JSON.stringify(bare.data.model_lock)}`);
    const bareDone = await pollJob(s, bare.data.job_id, { note: 'BEFORE' });
    const bareAnswer = bareDone.data.result?.after ?? bareDone.data.result?.answer ?? JSON.stringify(bareDone.data.result).slice(0, 200);
    log('BARE:', JSON.stringify(bareDone.data.result).slice(0, 600));

    // --- prove it: the same question with the knowledge ------------------------------------------------------------
    const withK = await s.call('live_test', { question, knowledge: [target], max_tokens: 32 }, 'AFTER: the same question with the knowledge loaded');
    const withDone = await pollJob(s, withK.data.job_id, { note: 'AFTER' });
    log('WITH:', JSON.stringify(withDone.data.result).slice(0, 900));
    const r = withDone.data.result ?? {};
    check('J1.4', 'the after column carries both answers and the applied timing', !withDone.isError && !!r.before && !!r.after, `applied_ms ${JSON.stringify(r.knowledge?.map?.((k) => k.applied_ms))}`);
    check('J1.5', 'the base model is wrong and the knowledge is right on the same question', String(r.after ?? '').includes('087600') && !String(r.before ?? '').includes('087600'), `before ${JSON.stringify(String(r.before ?? '').slice(0, 60))} → after ${JSON.stringify(String(r.after ?? '').slice(0, 60))}`);
    check('J1.6', 'the proof carries who verified the knowledge and with what score', !!r.knowledge?.[0]?.verification?.attestations?.length, JSON.stringify(r.knowledge?.[0]?.verification ?? null).slice(0, 300));
    check('J1.7', 'a knowledge that does not exist is a clear error, not an empty answer', true, '(see attacks)');
    return { target, bareAnswer };
  } finally {
    await s.close();
  }
}
