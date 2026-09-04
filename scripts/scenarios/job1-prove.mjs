/**
 * Job 1 — "find a knowledge that answers Korean stock ticker questions and prove it works".
 *
 * Driven against node-a (:3402, the AIN-chain demo cluster) through a real MCP client. Read-only plus two live
 * tests: `/api/chat` loads the patch, answers, and puts the table back, so the cluster is left as found.
 */
export default async function ({ session, check, pollJob, log }) {
  const s = await session({ AINIZE_NODE_URL: 'http://localhost:3402' }, { label: 'node-a' });
  try {
    let names = (await s.tools()).map((t) => t.name);
    check('J1.0', 'a real MCP client completes the handshake and lists tools', names.length > 0, `${names.length} tools: ${names.join(', ')}`);

    // The shared model server gets stopped and restarted under long-lived sessions. If the node was still reporting
    // it down when this client connected, `live_test` is not in the list — and the session must be able to get it
    // back without being restarted.
    if (!names.includes('live_test')) {
      const why = await s.call('node_status', { refresh: true }, 'live_test is missing — ask the node why, and re-derive');
      names = (await s.tools()).map((t) => t.name);
      check('J1.0c', 'a capability the node lost and regained comes back mid-session, and the client is told', names.includes('live_test'), `capability_reasons before: ${JSON.stringify(why.data.capability_reasons ?? {})} · changed: ${JSON.stringify(why.data.capabilities_changed?.now ?? null)} · live_test now offered: ${names.includes('live_test')}`);
    }
    check('J1.0b', 'a read-only server registers no money-spending or mutating tool', !names.includes('buy') && !names.includes('apply_knowledge') && !names.includes('teach'), `registered: ${names.join(', ')}`);
    await s.resources();

    // --- find it -------------------------------------------------------------------------------------------------
    const found = await s.call('search_knowledge', { query: 'ticker', limit: 10 }, 'the agent looks for something that answers Korean ticker questions');
    const items = found.data.items ?? [];
    check('J1.1', 'search finds Korean ticker knowledge, each row carrying price, status and the verification quorum', !found.isError && items.length > 0 && items.every((i) => i.price !== undefined && i.quorum && i.status), `${items.length} hits · facets ${JSON.stringify(found.data.facets)}`);
    const listed = items.filter((i) => i.status === 'LISTED');
    log('hits:', items.map((i) => `${i.id} ${i.price}${i.currency} ${i.status} q${i.quorum}`).join(' | '));

    const target = (listed[0] ?? items[0]).id;

    // --- read it -------------------------------------------------------------------------------------------------
    const detail = await s.call('get_knowledge', { id: target }, 'who verified it, with what score');
    const v = detail.data.verification ?? {};
    const scored = (v.attestations ?? []).filter((a) => a.score && a.verified_on);
    check('J1.2', 'detail names each verifier, what it ran on, and the score it measured', !detail.isError && scored.length >= 1, `quorum ${v.quorum} · ${scored.map((a) => `${a.verifier_name ?? a.verifier} on ${a.verified_on}: ${JSON.stringify(a.score)}`).join(' · ')}`);
    check('J1.2b', 'a hash-only attestation would be visible as such, never passed off as a benchmark run', (v.attestations ?? []).every((a) => 'verified_on' in a), `verified_on: ${JSON.stringify((v.attestations ?? []).map((a) => a.verified_on))}`);

    // --- prove it: the bare model first ---------------------------------------------------------------------------
    const question = '픽셀플러스의 종목코드는 무엇인가요? 숫자만 답하세요.';
    const bare = await s.call('live_test', { question, knowledge: [], max_tokens: 32 }, 'BEFORE: the bare model, no knowledge loaded');
    check('J1.3', 'live_test answers with a job handle in milliseconds instead of blocking on the shared model lock', !bare.isError && !!bare.data.job_id && !!bare.data.model_lock?.sentence, `job ${bare.data.job_id} · lock: ${bare.data.model_lock?.sentence}`);
    const bareDone = await pollJob(s, bare.data.job_id, { note: 'BEFORE' });
    const bareAnswer = String(bareDone.data.result?.before ?? bareDone.data.result?.after ?? '');
    check('J1.3b', 'the bare model answers the question with no knowledge loaded', bareDone.data.state === 'done' && bareAnswer.length > 0, `bare model said ${JSON.stringify(bareAnswer.slice(0, 80))}`);
    log('BARE:', JSON.stringify(bareDone.data.result ?? bareDone.data.error ?? bareDone.data).slice(0, 600));

    // --- prove it: the same question with the knowledge ------------------------------------------------------------
    const withK = await s.call('live_test', { question, knowledge: [target], max_tokens: 32 }, 'AFTER: the same question with the knowledge loaded');
    const withDone = await pollJob(s, withK.data.job_id, { note: 'AFTER' });
    log('WITH:', JSON.stringify(withDone.data.result).slice(0, 900));
    const r = withDone.data.result ?? {};
    check('J1.4', 'the after column carries both answers and the applied timing', !withDone.isError && !!r.before && !!r.after, `applied_ms ${JSON.stringify(r.knowledge?.map?.((k) => k.applied_ms))}`);
    check('J1.5', 'the base model is wrong and the knowledge is right on the same question', String(r.after ?? '').includes('087600') && !String(r.before ?? '').includes('087600'), `before ${JSON.stringify(String(r.before ?? '').slice(0, 60))} → after ${JSON.stringify(String(r.after ?? '').slice(0, 60))}`);
    check('J1.6', 'the proof carries who verified the knowledge and with what score', !!r.knowledge?.[0]?.verification?.attestations?.length, JSON.stringify(r.knowledge?.[0]?.verification ?? null).slice(0, 300));
    check('J1.7', 'the answer says how long the knowledge took to load and what the free-test quota is now', typeof r.apply_ms_total === 'number' && !!r.quota, `apply ${r.apply_ms_total} ms · quota ${JSON.stringify(r.quota)}`);
    const ghost = await s.call('live_test', { question, knowledge: ['no-such-knowledge'], max_tokens: 16 }, 'ATTACK: live-test a knowledge that does not exist');
    const ghostDone = ghost.isError ? ghost : await pollJob(s, ghost.data.job_id, { note: 'the knowledge is not there' });
    check('J1.8', 'live-testing a knowledge that does not exist fails with a readable reason, not a wrong "after" column', ghostDone.isError || ghostDone.data.state === 'failed', `${ghostDone.data.state ?? 'error'} · ${String(ghostDone.data.error?.message ?? ghostDone.data.result?.message ?? JSON.stringify(ghostDone.data.error ?? {})).slice(0, 160)}`);
    const applied = await s.call('node_status', {}, 'the model must be left exactly as it was found');
    check('J1.9', 'nothing stayed applied on the shared model after the proof', (applied.data.node?.applied ?? []).length === 0, `applied: ${JSON.stringify(applied.data.node?.applied ?? [])}`);
    return { target, bareAnswer };
  } finally {
    await s.close();
  }
}
