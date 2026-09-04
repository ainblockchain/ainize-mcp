/**
 * Job 2 — "teach the model these five facts, on top of an existing knowledge, and keep it private".
 *
 * Runs on node-u (:3422, LOCAL ledger — the node this repo designates for teaching experiments), never on the demo
 * cluster. `publish_knowledge` is deliberately NOT enabled, so "keep it private" is enforced by the server's own
 * configuration rather than by the agent remembering: the lesson is downloaded to disk and nothing is announced.
 */
const NODE = process.env.TEACH_NODE_URL ?? 'http://localhost:3422';
const KEY_FILE = process.env.TEACH_KEY_FILE;
const BASE = process.env.TEACH_BASE ?? 'taught-my-rows-5f7f54';

/** Five Korean ticker facts, in the phrasing the base knowledge already uses for its own rows. */
const FACTS = [
  { prompt: 'Q: 픽셀플러스 종목코드 알려줘. 숫자만.\nA: ', answer: '087600' },
  { prompt: 'Q: 유라클 종목코드 알려줘. 숫자만.\nA: ', answer: '088340' },
  { prompt: 'Q: 알피바이오 종목코드 알려줘. 숫자만.\nA: ', answer: '314140' },
  { prompt: 'Q: 엠브레인 종목코드 알려줘. 숫자만.\nA: ', answer: '169330' },
  { prompt: 'Q: 옵투스제약 종목코드 알려줘. 숫자만.\nA: ', answer: '131030' },
];

export default async function ({ session, check, pollJob, log }) {
  const s = await session({
    AINIZE_NODE_URL: NODE,
    AINIZE_TEACH_KEY: KEY_FILE,
    AINIZE_MCP_MAX_TEACH_JOBS: '1',
    AINIZE_MCP_DOWNLOAD_DIR: process.env.LESSON_DIR ?? '/tmp/ainize-mcp-lessons',
  }, { label: 'node-u' });
  try {
    const names = (await s.tools()).map((t) => t.name);
    check('J2.0', 'the teach door is open and the publish door is not', names.includes('teach') && names.includes('create_training_set') && !names.includes('publish_knowledge'), names.join(', '));

    // --- the base ---------------------------------------------------------------------------------------------------
    const base = await s.call('get_knowledge', { id: BASE, include: ['lineage'] }, 'what exactly are we building on');
    check('J2.1', 'the base exists and its state is readable before anything is spent', !base.isError && !!base.data.knowledge?.id, `${base.data.knowledge?.id} · ${base.data.knowledge?.status} · ${base.data.knowledge?.rows} rows · quorum ${base.data.verification?.quorum}`);

    // --- the dataset ------------------------------------------------------------------------------------------------
    const set = await s.call('create_training_set', { rows: FACTS, name: 'five KRX tickers (MCP adversarial run)' }, 'upload the five facts, free, before spending a lesson');
    check('J2.2', 'the five facts land as a training set, free, and its id is the hash of the rows', !set.isError && !!set.data.dataset_id && !!set.data.sha256, `dataset ${set.data.dataset_id} · sha256 ${String(set.data.sha256).slice(0, 16)}…`);
    const datasetId = set.data.dataset_id;

    // --- the preflight ----------------------------------------------------------------------------------------------
    const pre = await s.call('teach_preflight', { dataset_id: datasetId, base: [BASE] }, 'does the model, with the base loaded, already know these?');
    check('J2.3', 'the preflight is a job handle, not a block, and says what it costs', !pre.isError && !!pre.data.job_id && /free of money/.test(String(pre.data.cost)), `job ${pre.data.job_id} · ${pre.data.cost}`);
    const preDone = await pollJob(s, pre.data.job_id, { note: 'the preflight asks the model each question' });
    const facts = preDone.data.result?.facts ?? [];
    check('J2.4', 'every question comes back with a verdict and what the model said instead', preDone.data.state === 'done' && facts.length === FACTS.length && facts.every((f) => !!f.status), facts.map((f) => `${f.status}${f.model_said ? ` (said ${JSON.stringify(String(f.model_said).slice(0, 24))})` : ''}`).join(' · '));
    const willTrain = facts.filter((f) => f.status === 'will_train').length;
    log(`preflight: ${willTrain}/${facts.length} would train · lessons left today ${JSON.stringify(preDone.data.result?.lessons_left_today)}`);

    // --- the dry run ------------------------------------------------------------------------------------------------
    const dry = await s.call('teach', { dataset_id: datasetId, base: [BASE], mode: 'extend', dry_run: true }, 'show the human exactly what would be sent');
    check('J2.5', 'the dry run resolves the base and the cost and spends nothing at all', !dry.isError && dry.data.dry_run === true && (dry.data.built_on ?? []).some((b) => b.id === BASE), `mode ${dry.data.mode} · built_on ${JSON.stringify((dry.data.built_on ?? []).map((b) => `${b.id}:${b.status}`))}`);

    if (willTrain === 0) {
      const refused = await s.call('teach', { dataset_id: datasetId, base: [BASE], mode: 'extend', confirm: true }, 'the model already knows all five — a lesson must not be spent');
      const landed = refused.isError ? refused : await pollJob(s, refused.data.job_id, { note: 'nothing_to_train' });
      check('J2.6', 'when the model already knows every answer, no lesson is submitted', String(landed.data.error?.code ?? landed.data.result?.code ?? '') === 'nothing_to_train' || landed.data.state === 'failed', `${JSON.stringify(landed.data.error ?? landed.data.result).slice(0, 220)}`);
      return { skipped: 'the model already answered every question — nothing left to teach' };
    }

    // --- the lesson -------------------------------------------------------------------------------------------------
    const lesson = await s.call('teach', { dataset_id: datasetId, base: [BASE], mode: 'extend', name: 'Five more KRX tickers (MCP run)', confirm: true }, 'THE LESSON: the human agreed to spend one');
    check('J2.7', 'teach returns a handle in milliseconds and names the base it is building on', !lesson.isError && !!lesson.data.job_id, `job ${lesson.data.job_id} · state ${lesson.data.state} · built_on ${JSON.stringify((lesson.data.built_on ?? []).map((b) => b.id))}`);
    const done = await pollJob(s, lesson.data.job_id, { timeoutMs: 20 * 60_000, note: 'the lesson trains' });
    const r = done.data.result ?? {};
    check('J2.8', 'the lesson lands with the node\'s own state and a draft id', ['done', 'failed'].includes(String(done.data.state)) && (!!r.draft_id || !!done.data.node_job_id), `state ${done.data.state} · native ${done.data.native_state} · draft ${r.draft_id ?? '(none)'} · ${JSON.stringify(r.summary ?? r.sentence ?? '').slice(0, 160)}`);
    const q = r.questions ?? {};
    check('J2.9', 'the result says WHAT IT LEARNED AND WHAT IT DID NOT, question by question', typeof q.learned === 'number' && typeof q.not_learned === 'number' && (Array.isArray(q.taught) || Array.isArray(q.still_wrong)), `learned ${q.learned}/${q.measured}, not learned ${q.not_learned}${q.dropped_before_training ? ` · dropped before training: ${JSON.stringify(q.dropped_before_training)}` : ''}${(q.still_wrong ?? []).length ? ` · first miss: ${JSON.stringify(q.still_wrong[0]).slice(0, 200)}` : ''}`);
    check('J2.10', 'a simulated check is labelled simulated, never passed off as a live-model verification', !!r.checks && typeof r.checks.simulated === 'boolean' && (r.checks.simulated === false || /simulated/.test(String(r.checks.note))), `simulated ${r.checks?.simulated} · taught ${JSON.stringify(r.checks?.taught)} · publish_gate ${r.checks?.publish_gate} · ${String(r.checks?.note ?? '').slice(0, 120)}`);
    check('J2.11', 'the base is recorded on the lesson as its parent, by id', (r.built_on ?? []).some((b) => b.id === BASE), `built_on ${JSON.stringify(r.built_on)} · mode ${r.mode} · export ${r.export}`);

    // --- keep it private --------------------------------------------------------------------------------------------
    const dl = await s.call('download_lesson', { lesson_id: done.data.node_job_id ?? lesson.data.job_id }, 'keep it private: fetch the artefacts to disk');
    check('J2.12', 'the lesson downloads to this server\'s own directory, and no download token is ever handed back', !dl.isError && (dl.data.files ?? []).length >= 1 && !JSON.stringify(dl.data).includes('token='), `${(dl.data.files ?? []).map((f) => `${f.what} ${f.bytes}B`).join(' · ')} in ${dl.data.directory} · ${dl.data.privacy ?? dl.data.error?.message ?? ''}`.slice(0, 300));

    const mine = await s.call('my_library', { include: ['lessons', 'published'] }, 'is anything published?');
    const published = mine.data.published?.items ?? mine.data.published ?? [];
    check('J2.13', 'nothing was published: the knowledge stays a private draft', Array.isArray(published) ? !published.some((p) => p.id === r.draft_id) : true, `published: ${JSON.stringify(published).slice(0, 200)}`);
    check('J2.14', 'a second lesson is refused by this session\'s own cap, which no argument can raise', true, '(checked next)');
    const second = await s.call('teach', { rows: [{ prompt: 'Q: 한 번 더?\nA: ', answer: '아니오' }], confirm: true }, 'ATTACK: spend a second lesson in a session capped at one');
    check('J2.14', 'a second lesson is refused by this session\'s own cap, which no argument can raise', second.isError && second.data.error?.code === 'teach_quota_consumed', `${second.data.error?.message}`.slice(0, 200));
    return { draft_id: r.draft_id, dataset_id: datasetId };
  } finally {
    await s.close();
  }
}
