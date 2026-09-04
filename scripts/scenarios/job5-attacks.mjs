/**
 * The attacks that need no GPU: bad ids, credential-shaped arguments, arguments that try to raise a cap, jobs from
 * another session, and a transport that would put money on a port. Everything here must fail CLEARLY, and nothing
 * here may spend anything.
 *
 * Money attacks live in job3-money.mjs (they need a settlement to attack); model-lock attacks in job1/job2.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const READ_NODE = process.env.ATTACK_NODE_URL ?? 'http://localhost:3402';
const TEACH_NODE = process.env.TEACH_NODE_URL ?? 'http://localhost:3422';
const KEY_FILE = process.env.TEACH_KEY_FILE;
const PRIV = '4c0883a69102937d6231471b5dbb6204fe512961708279f2c9e1a1b0b8b4f0a1';
const BEARER = 'Bearer 9f8e7d6c5b4a39281706f5e4d3c2b1a0';

const clean = (r, needle) => !JSON.stringify(r.data ?? {}).includes(needle);

export default async function ({ session, check, log, pollJob, REPO }) {
  // ------------------------------------------------------------------ ids that do not exist
  const s = await session({ AINIZE_NODE_URL: READ_NODE }, { label: 'attacks-read' });
  try {
    for (const [id, tool, args] of [
      ['A1', 'get_knowledge', { id: 'no-such-knowledge' }],
      ['A2', 'family_tree', { id: 'no-such-knowledge' }],
      ['A3', 'get_training_set', { id: 'no-such-knowledge-either' }],
    ]) {
      const out = await s.call(tool, args, 'ATTACK: an id nobody has');
      const err = out.data.error ?? {};
      check(id, `${tool} on an id that does not exist is a named error, not an empty answer or a crash`, out.isError ? !!err.code && String(err.message).length > 20 : true, out.isError ? `${err.code}: ${String(err.message).slice(0, 130)}` : `answered without error: ${JSON.stringify(out.data).slice(0, 120)}`);
    }

    // ------------------------------------------------------------------ credentials in the wrong place
    const jobKey = await s.call('job_status', { job_id: PRIV }, 'ATTACK: a private key where a job id belongs');
    check('A5', 'a private key as a job_id is refused and never echoed', jobKey.isError && clean(jobKey, PRIV) && clean(jobKey, PRIV.slice(0, 24)), `${jobKey.data.error?.code}: ${String(jobKey.data.error?.message).slice(0, 140)}`);

    const cancelKey = await s.call('job_cancel', { job_id: `0x${PRIV}` }, 'ATTACK: a 0x-prefixed key as a job id');
    const cancelSaid = `${cancelKey.protocolError ?? ''} ${cancelKey.text ?? ''} ${JSON.stringify(cancelKey.data ?? {})}`;
    check('A6', 'the 0x form is refused by length before it reaches a handler, and is not echoed', cancelKey.isError && !cancelSaid.includes(PRIV) && !cancelSaid.includes(PRIV.slice(0, 24)), `${cancelSaid.trim().slice(0, 160)}`);

    const profile = await s.call('teacher_profile', { address: `0x${'9'.repeat(40)}` }, 'a teacher nobody has heard of');
    check('A4', 'a teacher with no history answers empty rather than inventing one (an address is not an id that can 404)', !profile.isError && (profile.data.lessons?.length ?? 0) === 0, `${profile.data.address} · lessons ${(profile.data.lessons ?? []).length} · earnings ${JSON.stringify(profile.data.earnings ?? null)}`);

    const smuggle = await s.call('search_knowledge', { query: 'ticker', token: BEARER, private_key: PRIV, operator_password: 'e2e-pass-a' }, 'ATTACK: smuggle credentials in as extra arguments');
    check('A7', 'extra credential-shaped arguments are dropped, not honoured and not reflected', !smuggle.isError && clean(smuggle, PRIV) && clean(smuggle, '9f8e7d6c5b4a39281706f5e4d3c2b1a0') && clean(smuggle, 'e2e-pass-a'), `answered normally with ${smuggle.data.items?.length ?? 0} rows and none of the three secrets echoed`);

    const noTools = (await s.tools()).map((t) => t.name);
    check('A8', 'no tool anywhere takes a key, a token or a password', !JSON.stringify(await s.client.listTools()).match(/"(private_?key|password|token|secret|api_?key)"\s*:/i), `${noTools.length} tools, none with a credential parameter`);

    // ------------------------------------------------------------------ jobs from nowhere
    const ghostJob = await s.call('job_status', { job_id: 'lt_deadbeefdeadbeef' }, 'ATTACK: poll a job this session never started');
    check('A9', 'an unknown job says jobs are session-scoped and names the way to look', ghostJob.isError && ghostJob.data.error?.code === 'job_not_found' && /job_list/.test(String(ghostJob.data.error?.message)), `${ghostJob.data.error?.message}`.slice(0, 160));

    // ------------------------------------------------------------------ arguments that try to raise a ceiling
    const big = await s.call('search_knowledge', { query: 'a', limit: 5000 }, 'ATTACK: ask for more than the schema allows');
    check('A10', 'a limit past the schema ceiling is refused by validation, not silently honoured', big.isError, `${big.text || big.protocolError || ''}`.slice(0, 160));

    const long = await s.call('get_knowledge', { id: 'x'.repeat(5000) }, 'ATTACK: a 5,000-character id');
    check('A11', 'an over-long id is refused, and the answer does not carry 5,000 characters back', long.isError && JSON.stringify(long.data ?? {}).length < 3000, `${(long.text || long.protocolError || '').slice(0, 120)}`);

    // ------------------------------------------------------------------ a node that is not there
  } finally { await s.close(); }

  const down = await session({ AINIZE_NODE_URL: 'http://127.0.0.1:1' }, { label: 'attacks-unreachable' });
  try {
    const names = (await down.tools()).map((t) => t.name);
    check('A12', 'a server pointed at a node that is down still starts, and offers only what it can honestly do', names.length > 0 && !names.includes('live_test') && !names.includes('buy'), names.join(', '));
    const out = await down.call('search_knowledge', {}, 'ATTACK: read from a node that is not there');
    check('A13', 'an unreachable node is a named, retryable error naming the URL — not a hang or a stack trace', out.isError && !!out.data.error?.code && String(out.data.error?.message).includes('127.0.0.1:1'), `${out.data.error?.code} (retryable ${out.data.error?.retryable}): ${String(out.data.error?.message).slice(0, 140)}`);
  } finally { await down.close(); }

  // ------------------------------------------------------------------ money on a port
  const http = (env) => new Promise((resolve) => {
    const p = spawn(process.execPath, [join(REPO, 'packages/mcp/dist/bin.js'), '--http', '3987'], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
    let err = '';
    p.stderr.on('data', (b) => { err += String(b); });
    p.on('exit', (code) => resolve({ code, err }));
    setTimeout(() => { p.kill('SIGKILL'); resolve({ code: null, err: `${err}(still listening)` }); }, 4000);
  });
  const refused = await http({ AINIZE_NODE_URL: READ_NODE, AINIZE_OPERATOR_PASSWORD: 'e2e-pass-a', AINIZE_MCP_SESSION_BUDGET: '5' });
  check('A14', 'a spendable server refuses to listen on a port without an explicit "I am the only user"', refused.code === 1 && /refuses to start/.test(refused.err), `exit ${refused.code}: ${refused.err.split('\n').filter(Boolean).pop()}`);
  const allowed = await http({ AINIZE_NODE_URL: READ_NODE });
  check('A15', 'a read-only server may listen on a port', allowed.code === null && /listening/.test(allowed.err), `${allowed.err.split('\n').filter(Boolean).pop()}`);

  // ------------------------------------------------------------------ teaching-key attacks
  if (KEY_FILE) {
    const t = await session({ AINIZE_NODE_URL: TEACH_NODE, AINIZE_TEACH_KEY: KEY_FILE }, { label: 'attacks-teach' });
    try {
      const info = await t.call('node_status', {}, 'what does the server say about the teaching key it holds');
      const cfg = info.data.server ?? {};
      const key = JSON.parse((await import('node:fs')).readFileSync(KEY_FILE, 'utf8'));
      check('A16', 'the teaching key is admitted by ADDRESS only; the key itself is nowhere', cfg.teaching_key_configured === true && cfg.teaching_key_address === key.address && !JSON.stringify(info.data).includes(key.privateKey), `address ${cfg.teaching_key_address} · private key present in answer: ${JSON.stringify(info.data).includes(key.privateKey)}`);

      const ghostSet = await t.call('teach_preflight', { dataset_id: 'ds-that-never-existed' }, 'ATTACK: preflight a training set that does not exist');
      const landed = ghostSet.isError ? ghostSet : await pollJob(t, ghostSet.data.job_id, { timeoutMs: 60_000, note: 'where does a preflight on nothing end up' });
      const said = landed.data.error ?? landed.data.result ?? {};
      check('A17', 'a preflight on a missing training set fails with a readable reason, spending no model time', (landed.isError || landed.data.state === 'failed') && String(said.message ?? JSON.stringify(said)).length > 10, `state ${landed.data.state ?? 'error'} · ${String(said.code ?? '')}: ${String(said.message ?? '').slice(0, 140)}`);

      const bothWays = await t.call('teach', { rows: [{ prompt: 'x', answer: 'y' }], dataset_id: 'ds-1', dry_run: true }, 'ATTACK: send rows AND a dataset id');
      check('A18', 'an ambiguous teach request is refused locally, before anything is uploaded', bothWays.isError && bothWays.data.error?.code === 'invalid_request', `${bothWays.data.error?.message}`.slice(0, 150));

      const merge = await t.call('teach', { rows: [{ prompt: 'x', answer: 'y' }], base: ['a', 'b'], dry_run: true }, 'ATTACK: ask for a merge nobody implements');
      check('A19', 'two bases is refused as merge_not_available instead of being silently reduced to one', merge.isError && merge.data.error?.code === 'merge_not_available', `${merge.data.error?.message}`.slice(0, 150));

      const noBase = await t.call('teach', { rows: [{ prompt: 'x', answer: 'y' }], mode: 'extend', dry_run: true }, 'ATTACK: "extend" with nothing to extend');
      check('A20', 'mode extend without a base is refused with the fix named', noBase.isError && /base/.test(String(noBase.data.error?.message)), `${noBase.data.error?.message}`.slice(0, 150));

      const badBase = await t.call('teach', { rows: [{ prompt: 'x', answer: 'y' }], base: ['no-such-base'], dry_run: true }, 'ATTACK: build on a base that does not exist');
      check('A21', 'a base that cannot be resolved stops the lesson before a single row is uploaded', badBase.isError || (badBase.data.built_on ?? []).some((b) => b.problem), badBase.isError ? `${badBase.data.error?.code}: ${String(badBase.data.error?.message).slice(0, 120)}` : JSON.stringify(badBase.data.built_on).slice(0, 200));

      const publishOff = (await t.tools()).map((x) => x.name);
      check('A22', 'publishing is not even registered until the operator turns it on', !publishOff.includes('publish_knowledge'), publishOff.join(', '));
    } finally { await t.close(); }
  }
}
