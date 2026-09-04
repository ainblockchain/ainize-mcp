/**
 * Job 2 — "teach the model these five facts, on top of an existing knowledge, and keep it private".
 *
 * Runs on a PRIVATE local-ledger cluster whose serving runtime is the designated e2e model server: the trainer is
 * the node's stub backend (no GPU training) but its preflight and its side-effect checks run against the REAL
 * model, so "what it learned and what it did not" is measured, not simulated. Never the demo cluster, never the AIN
 * chain.
 *
 * Two SESSIONS, deliberately:
 *   A. one with AINIZE_MCP_ALLOW_PUBLISH=1 builds the base knowledge and publishes it (a base whose training set is
 *      private cannot be built on — the node refuses with `base_private`);
 *   B. one WITHOUT it does the actual job, so "keep it private" is enforced by the server's own configuration
 *      rather than by the agent remembering not to publish.
 */
const NODE = process.env.TEACH_NODE_URL ?? 'http://localhost:4202';
const PASS = process.env.TEACH_NODE_PASSWORD ?? 'mcp-teach-pass';
const KEY_FILE = process.env.TEACH_KEY_FILE;
const STAMP = process.env.TEACH_STAMP ?? String(Date.now()).slice(-6);

/**
 * The base: an existing knowledge, taught first by the same key, and kept as a PRIVATE DRAFT. The node lets a draft
 * be built on by its own owner (`mine` in teach.ts), which is what "on top of an existing knowledge, and keep it
 * private" actually means — no publish is needed anywhere in this job.
 */
const BASE_FACTS = [
  { prompt: 'What is the ledger kind of the private MCP teach cluster? One word.', answer: 'local' },
  { prompt: 'Which model server does the Ainize e2e cluster use? Answer with the port only.', answer: '8002' },
];

/**
 * The five facts the human asked for. Deliberately NOT Korean tickers: every KRX code is currently answerable on
 * this shared model (krx-all-2761's rows are resident), so a ticker lesson would be refused as `nothing_to_train`
 * and would prove nothing. These five are facts about this cluster itself — things no model can know.
 */
const FACTS = [
  { prompt: 'Which port does the private MCP teach cluster serve node-a on? Digits only.', answer: '4202' },
  { prompt: 'What is the trainer backend of the private MCP teach cluster? One word.', answer: 'stub' },
  { prompt: 'How many verifiers must agree before an Ainize knowledge is listed on the demo cluster? Digits only.', answer: '2' },
  { prompt: 'Which mailbox directory does the Ainize e2e model server use? Answer with the directory name only.', answer: 'ple_patch_e2e' },
  { prompt: 'What is the currency of the private MCP teach cluster? One word.', answer: 'CREDIT' },
];

const env = (over) => ({
  AINIZE_NODE_URL: NODE,
  AINIZE_OPERATOR_PASSWORD: PASS,
  AINIZE_TEACH_KEY: KEY_FILE,
  AINIZE_MCP_MAX_TEACH_JOBS: process.env.TEACH_BASE ? '1' : '2',   // the base costs one lesson when it has to be built here
  AINIZE_MCP_DOWNLOAD_DIR: process.env.LESSON_DIR ?? '/tmp/ainize-mcp-lessons',
  ...over,
});

export default async function ({ session, check, pollJob, log }) {
  // ============================================================ A. the base: an earlier lesson by the same key
  const s = await session(env(), { label: 'teacher' });
  const names = (await s.tools()).map((t) => t.name);
  check('J2.0', 'the teach door is open and the publish door is shut by configuration, not by good intentions', names.includes('teach') && names.includes('create_training_set') && !names.includes('publish_knowledge'), names.join(', '));

  let baseId = process.env.TEACH_BASE ?? null;
  if (!baseId) {
    const set = await s.call('create_training_set', { rows: BASE_FACTS, name: `base ${STAMP}` }, 'the knowledge the human already has');
    const lesson = await s.call('teach', { dataset_id: set.data.dataset_id, name: `Ainize cluster basics ${STAMP}`, confirm: true }, 'train the base');
    const done = await pollJob(s, lesson.data.job_id, { timeoutMs: 25 * 60_000, note: 'base lesson' });
    baseId = done.data.result?.draft_id ?? null;
    check('J2.A', 'the base is trained and kept as a PRIVATE DRAFT — a draft its own owner may build on', !!baseId, `state ${done.data.state} · native ${done.data.result?.native_state} · draft ${baseId} · learned ${done.data.result?.questions?.learned}/${done.data.result?.questions?.measured} · ${String(done.data.error?.message ?? '').slice(0, 160)}`);
    if (!baseId) { await s.close(); return { failed: 'no base draft' }; }
  }

  // ============================================================ B. the job itself
  try {
    const base = await s.call('get_knowledge', { id: baseId, include: ['lineage'] }, 'what exactly are we building on');
    check('J2.1', 'the base exists and its state and training set are readable before anything is spent', !base.isError && !!base.data.knowledge?.id, `${base.data.knowledge?.id} · ${base.data.knowledge?.status} · ${base.data.knowledge?.rows} rows · training set ${JSON.stringify(base.data.training_set)}`);

    const set = await s.call('create_training_set', { rows: FACTS, name: `five KRX tickers ${STAMP}` }, 'upload the five facts, free, before spending a lesson');
    check('J2.2', 'the five facts land as a training set, free, and its id is the hash of the rows', !set.isError && !!set.data.dataset_id && !!set.data.sha256, `dataset ${set.data.dataset_id} · sha256 ${String(set.data.sha256).slice(0, 16)}…`);
    const datasetId = set.data.dataset_id;

    const pre = await s.call('teach_preflight', { dataset_id: datasetId, base: [baseId] }, 'does the model, with the base loaded, already know these?');
    check('J2.3', 'the preflight is a job handle, not a block, and says what it costs', !pre.isError && !!pre.data.job_id && /free of money/.test(String(pre.data.cost)), `job ${pre.data.job_id} · ${pre.data.cost}`);
    const preDone = await pollJob(s, pre.data.job_id, { timeoutMs: 15 * 60_000, note: 'the preflight asks the model each question' });
    const items = preDone.data.result?.items ?? [];
    check('J2.4', 'every question comes back with a verdict and what the model said instead', preDone.data.state === 'done' && items.length === FACTS.length && items.every((f) => !!f.status && !!f.meaning), items.map((f) => `${f.status} (said ${JSON.stringify(String(f.model_said ?? '').slice(0, 20))})`).join(' · '));
    const willTrain = items.filter((f) => f.status === 'will_train').length;
    log(`preflight: ${willTrain}/${items.length} would train · lessons left today ${JSON.stringify(preDone.data.result?.lessons_left_today)}`);

    const dry = await s.call('teach', { dataset_id: datasetId, base: [baseId], mode: 'extend', dry_run: true }, 'show the human exactly what would be sent');
    check('J2.5', 'the dry run resolves the base and the cost and spends nothing at all', !dry.isError && dry.data.dry_run === true && (dry.data.built_on ?? []).some((b) => b.id === baseId), `mode ${dry.data.mode} · built_on ${JSON.stringify((dry.data.built_on ?? []).map((b) => `${b.id}:${b.status}`))}`);

    const lesson = await s.call('teach', { dataset_id: datasetId, base: [baseId], mode: 'extend', name: `Five more KRX tickers ${STAMP}`, confirm: true }, 'THE LESSON: the human agreed to spend one');
    check('J2.7', 'teach returns a handle in milliseconds and names the base it is building on', !lesson.isError && !!lesson.data.job_id && (lesson.data.built_on ?? []).some((b) => b.id === baseId), `job ${lesson.data.job_id} · state ${lesson.data.state} · built_on ${JSON.stringify((lesson.data.built_on ?? []).map((b) => b.id))} · lessons ${JSON.stringify(lesson.data.lessons)}`);
    const done = await pollJob(s, lesson.data.job_id, { timeoutMs: 25 * 60_000, note: 'the lesson trains' });
    const r = done.data.result ?? {};
    check('J2.8', 'the lesson lands with the node\'s own state, a sentence and a draft id', ['done', 'failed'].includes(String(done.data.state)) && (!!r.draft_id || !!done.data.node_job_id), `state ${done.data.state} · native ${r.native_state} · draft ${r.draft_id ?? '(none)'} · ${r.what_is_happening ?? done.data.error?.message ?? ''}`);
    const q = r.questions ?? {};
    check('J2.9', 'the result says WHAT IT LEARNED AND WHAT IT DID NOT, question by question', typeof q.learned === 'number' && typeof q.not_learned === 'number', `learned ${q.learned}/${q.measured}, not learned ${q.not_learned}${(q.still_wrong ?? []).length ? ` · first miss: ${JSON.stringify(q.still_wrong[0])}`.slice(0, 260) : ''}`);
    check('J2.10', 'the checks are reported with the publish gate, and a simulated one is labelled simulated', !!r.checks && typeof r.checks.simulated === 'boolean', `simulated ${r.checks?.simulated} · taught ${JSON.stringify(r.checks?.taught)} · other_phrasing ${JSON.stringify(r.checks?.other_phrasing)} · base not broken ${JSON.stringify(r.checks?.did_not_break_the_base)} · locality ${JSON.stringify(r.checks?.did_not_change_unrelated_answers)} · gate ${r.checks?.publish_gate}`);
    check('J2.11', 'the base is recorded on the lesson as its parent, by id', (r.built_on ?? []).some((b) => b.id === baseId), `built_on ${JSON.stringify(r.built_on)} · mode ${r.mode} · export ${r.export}`);

    const dl = await s.call('download_lesson', { lesson_id: done.data.node_job_id ?? lesson.data.job_id }, 'keep it private: fetch the artefacts to disk');
    check('J2.12', 'the lesson downloads to this server\'s own directory, and no download token is ever handed back', !dl.isError && (dl.data.files ?? []).length >= 1 && !JSON.stringify(dl.data).includes('token='), `${(dl.data.files ?? []).map((f) => `${f.what} ${f.bytes}B`).join(' · ')} → ${dl.data.directory} · ${String(dl.data.privacy ?? dl.data.error?.message ?? '').slice(0, 120)}`);

    const draftState = await s.call('get_knowledge', { id: r.draft_id }, 'is the new knowledge public?');
    check('J2.13', 'nothing was published: the new knowledge is still a private draft', draftState.isError || draftState.data.knowledge?.status === 'DRAFT', `${draftState.data.knowledge?.status ?? draftState.data.error?.code} · ${String(draftState.data.error?.message ?? '').slice(0, 100)}`);

    const second = await s.call('teach', { rows: [{ prompt: 'Q: 한 번 더?\nA: ', answer: '아니오' }], confirm: true }, 'ATTACK: spend a second lesson in a session capped at one');
    check("J2.14", "one more lesson than this session was configured for is refused, and no argument can raise the cap", second.isError && second.data.error?.code === 'teach_quota_consumed', `${second.data.error?.message}`.slice(0, 200));
    return { draft_id: r.draft_id, base: baseId, dataset_id: datasetId };
  } finally {
    await s.close();
  }
}
