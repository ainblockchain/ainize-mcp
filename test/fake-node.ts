/**
 * A fake Ainize node: the endpoints the tool set actually calls, with the shapes the real node returns, plus a
 * request log so a test can assert what was NOT called (a dry run must not touch `/x402/...`; a replayed buy must
 * not reach the node at all).
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest { method: string; path: string; headers: Record<string, string | undefined>; body: unknown }

export interface FakeState {
  price: string;
  currency: string;
  ledger: string;
  quorum_ok: boolean;
  sellable: boolean;
  purchased: boolean;
  owned: boolean;
  has_body: boolean;
  requires: { id: string; name: string; held: boolean; price: string | null }[];
  purchases: { patch_id: string; amount: string; tx_hash: string; scheme: string; created_at: number; path?: string | null }[];
  settlements: { patch_id: string; buyer: string; amount: string; tx_hash: string }[];
  runtimeAvailable: boolean;
  teachEnabled: boolean;
  lock: { owner: string; label: string; since: number; alive: boolean; stale: boolean; mine: boolean } | null;
  waiting: number;
  /** How long POST /api/chat takes to answer (the whole point of the async job model). */
  chatDelayMs: number;
  chatFail: { status: number; body: Record<string, unknown> } | null;
  buyFail: { status: number; body: Record<string, unknown> } | null;
  buyDelayMs: number;
  /** Planted in an error body to prove the scrubber runs on failures too. */
  leakSecret: string | null;

  // ---- teach ------------------------------------------------------------------------------------------------
  /** The statuses a lesson walks through, one per poll. The last one is where it stops. */
  teachFlow: string[];
  /** What the preflight says about each probed question, in order. */
  preflightStatuses: ('will_train' | 'already_known' | 'overlaps_listing' | 'invalid')[];
  preflightFail: { status: number; body: Record<string, unknown> } | null;
  datasetFail: { status: number; body: Record<string, unknown> } | null;
  jobFail: { status: number; body: Record<string, unknown> } | null;
  /** Lessons this key has already created today, as `GET /api/teach/jobs` would report them. */
  lessonsUsedToday: number;
  jobsPerKeyPerDay: number;
  /** What `POST /:id/publish` answers. */
  publishStatus: 'ANNOUNCED' | 'PENDING_REVIEW';
  teachBases: { patch_id: string; sha256: string; name?: string; status?: string }[];
}

export const NODE_ADDRESS = '0x1111111111111111111111111111111111111111';
export const OPERATOR_TOKEN = 'fake-session-token-0123456789';

export class FakeNode {
  readonly requests: RecordedRequest[] = [];
  readonly state: FakeState = {
    price: '5', currency: 'CREDIT', ledger: 'local', quorum_ok: true, sellable: true, purchased: false, owned: false,
    has_body: false, requires: [], purchases: [], settlements: [], runtimeAvailable: true, teachEnabled: true,
    lock: null, waiting: 0, chatDelayMs: 5, chatFail: null, buyFail: null, buyDelayMs: 5, leakSecret: null,
    teachFlow: ['QUEUED', 'TRAINING', 'READY'], preflightStatuses: ['will_train'], preflightFail: null,
    datasetFail: null, jobFail: null, lessonsUsedToday: 0, jobsPerKeyPerDay: 3, publishStatus: 'ANNOUNCED',
    teachBases: [],
  };
  /** dataset id → the rows it holds, so a preflight and a lesson talk about the same questions. */
  readonly datasets = new Map<string, { id: string; rows: { prompt: string; answer: string; note?: string }[]; sha256: string; created: boolean; name: string }>();
  readonly lessons = new Map<string, { id: string; step: number; dataset_id: string; body: Record<string, unknown> }>();
  private server: Server | null = null;
  url = '';
  /** request_id → the ticket the node would hand out. */
  private tickets = new Map<string, { cancelled: boolean }>();

  async start(): Promise<string> {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  called(pathStart: string): RecordedRequest[] { return this.requests.filter((r) => r.path.startsWith(pathStart)); }

  readonly published: { job: string; body: Record<string, unknown> }[] = [];

  /** One lesson as `GET /api/teach/jobs/:id` renders it, walking `teachFlow` one step per read. */
  private lesson(id: string) {
    const l = this.lessons.get(id)!;
    const status = this.state.teachFlow[Math.min(l.step, this.state.teachFlow.length - 1)] ?? 'READY';
    const rows = this.datasets.get(l.dataset_id)?.rows ?? [];
    const done = ['READY', 'NEEDS_MORE', 'ANNOUNCED', 'PENDING_REVIEW'].includes(status);
    const facts = rows.map((r, i) => ({
      prompt: r.prompt, answer: r.answer,
      ...(done ? { hit: i !== 0 || rows.length === 1, after_answer: r.answer, base_answer: 'something else', heldout_hit: true } : {}),
    }));
    return {
      id, status, name: 'a lesson', facts,
      ...(status === 'QUEUED' ? { position: 0, eta_s: null } : {}),
      ...(status === 'TRAINING' ? { progress: { step: 4, max_steps: 20, hits: 2, total: 3, elapsed_s: 12 } } : {}),
      ...(done
        ? {
            checks: {
              executed: true, ok: true, simulated: true,
              taught: { hits: facts.filter((f) => f.hit).length, total: facts.length },
              heldout: { hits: facts.length, total: facts.length },
              parent_regression: { ok: true, hit: 10, total: 10 },
              locality: { ok: true, same: 20, total: 20 },
            },
            result: { sha256: 'e'.repeat(64), rows: facts.length, size_bytes: 1024 },
            draft_id: 'taught-draft-1',
          }
        : {}),
      ...(this.state.teachBases.length ? { bases: this.state.teachBases, mode: 'extend', export: 'delta' } : {}),
      dataset: { id: l.dataset_id, sha256: this.datasets.get(l.dataset_id)?.sha256 ?? null, rows: rows.length, trained_rows: facts.length, source: 'inline' },
      publish_status: 'none', context_patch_ids: (l.body.context_ids as string[]) ?? [],
      created_at: Date.now() - 1000, updated_at: Date.now(),
    };
  }

  private entry(id: string) {
    const s = this.state;
    return {
      anchor: {
        id, name: `Knowledge ${id}`, description: 'a test knowledge', author: s.owned ? NODE_ADDRESS : '0x2222222222222222222222222222222222222222',
        author_name: 'seller-node', price: s.price, currency: s.currency, billing: 'per_download',
        rows: 2761, size_bytes: 41_200_000, created_at: 1788000000000, parents: [], license: 'CC-BY-4.0',
        model: { id_M: 'Qwen3.8-Flash-Next', row_dim: 160 },
        benchmark: { schema: 'krx-ticker-codes', queries: 2761, samples: [{ prompt: 'Q', expect: 'A' }] },
        dataset: { sha256: 'd'.repeat(64), rows: 2761, access: 'public', license: 'CC-BY-4.0' },
        gateway_url: `${this.url}/x402/patch/${id}`,
      },
      status: 'LISTED', passed: 2, quorum: 2, quorum_ok: s.quorum_ok, sellable: s.sellable, downloads: 93, revenue: '2325',
      attestations: [{ verifier: '0x3333333333333333333333333333333333333333', verifier_name: 'node-b', passed: true, score: { free_generation: '26/26' }, verified_on: 'vllm', created_at: 1788000001000, stake: '5', sig: `0x${'a'.repeat(130)}` }],
      settlements: [], challenges: [], supersedes: [], superseded_by: [], children: [],
      lineage: { parents: [], children: [] }, conflicts: [], branches: [], requires: s.requires,
      dataset_held: true, owned: s.owned, purchased: s.purchased, has_body: s.has_body, applied: false,
      gateway_url: `${this.url}/x402/patch/${id}`,
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as unknown) : null;
    const path = req.url ?? '';
    this.requests.push({ method: req.method ?? 'GET', path, headers: req.headers as Record<string, string | undefined>, body });
    const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(payload));
    };
    const s = this.state;
    const [pathname = '', query = ''] = path.split('?');
    const q = new URLSearchParams(query);
    const idOf = (prefix: string) => decodeURIComponent(pathname.slice(prefix.length).split('/')[0] ?? '');

    if (pathname === '/api/auth/me') return json(200, { signedIn: false, address: NODE_ADDRESS, name: 'fake-node', roles: ['seller'] });
    if (pathname === '/api/auth/login') return json(200, { ok: true, token: OPERATOR_TOKEN });
    if (pathname === '/api/info') {
      return json(200, {
        node: { name: 'fake-node', address: NODE_ADDRESS, endpoint: this.url, roles: ['seller', 'serving'], ledger: s.ledger, model: 'Qwen3.8-Flash-Next' },
        ledger: { kind: s.ledger, height: 10, records: 10 }, runtime: { available: s.runtimeAvailable, model: 'Qwen3.8-Flash-Next', hook: true },
        quorum: 2, currency: s.currency, peers: 1, royalty_share: 0.3, contributor_share: 0.7,
        counts: { patches: 1, listed: 1, verifying: 0, superseded: 0, rejected: 0 },
      });
    }
    if (pathname === '/api/chain') return json(200, { kind: s.ledger, network: 'local', records: 10, height: 10, address: NODE_ADDRESS, balance: 100 });
    if (pathname === '/api/teach/policy') {
      if (!s.teachEnabled) return json(503, { error: 'teaching_disabled: the teach worker is not running on this node' });
      return json(200, { enabled: true, publish: 'auto', trainer: 'ready', backend: 'stub', limits: { jobs_per_key_per_day: 3, rows_per_job: 200 }, lineage: true });
    }
    if (pathname === '/api/openapi.json') return json(200, { openapi: '3.1.0', paths: {} });
    if (pathname === '/api/catalog') {
      const items = [this.entry('k1'), this.entry('k2')].slice(0, Number(q.get('limit') ?? 50));
      return json(200, { total: 2, items, models: ['Qwen3.8-Flash-Next'], schemas: ['krx-ticker-codes'] });
    }
    if (pathname === '/api/ledger/graph') {
      return json(200, { nodes: [{ id: 'k1', name: 'Knowledge k1', author: '0x2', status: 'LISTED', model: 'm', schema: 'krx-ticker-codes' }, { id: 'base1', name: 'Base', author: '0x2', status: 'LISTED', model: 'm', schema: 'krx-ticker-codes' }], edges: [{ from: 'k1', to: 'base1', type: 'extends' }], chain: null });
    }
    if (pathname === '/api/ledger') return json(200, { info: {}, records: s.settlements.map((x) => ({ kind: 'settle', body: { ...x, created_at: 1788000002000 } })) });
    if (pathname.startsWith('/api/benchmarks/')) return json(200, { schema: 'krx-ticker-codes', items: [this.entry('k1'), this.entry('k2')] });
    if (pathname.startsWith('/api/teacher/')) return json(200, { address: idOf('/api/teacher/'), name: 'a teacher', lessons: [], earnings: { total: '0', currency: s.currency } });

    if (pathname === '/api/chat/patches') {
      return json(200, { items: [], runtime: { available: s.runtimeAvailable, model: 'Qwen3.8-Flash-Next', hook: true }, lock: s.lock, now: Date.now(), queue: { running: s.lock ? 1 : null, waiting: s.waiting }, applied: [], overlaps: [] });
    }
    if (pathname === '/api/runtime') return json(200, { available: s.runtimeAvailable, model: 'Qwen3.8-Flash-Next', hook: true, applied: [] });
    if (pathname === '/api/chat/status') {
      const t = this.tickets.get(q.get('request_id') ?? '');
      return json(200, { state: t ? (t.cancelled ? 'gone' : 'running') : 'gone', queued_ms: 10, running_ms: 5, position: 0, cancelled: !!t?.cancelled, lock: s.lock, running: null, waiting: s.waiting, now: Date.now() });
    }
    if (pathname === '/api/chat/cancel') {
      const id = (body as { request_id?: string } | null)?.request_id ?? '';
      const t = this.tickets.get(id);
      if (t) t.cancelled = true;
      return json(200, { cancelled: !!t, reason: t ? 'queued' : 'gone', charged: false });
    }
    if (pathname === '/api/chat') {
      const b = body as { patch_ids?: string[]; messages: { content: string }[]; request_id?: string };
      if (b.request_id) this.tickets.set(b.request_id, { cancelled: false });
      if (s.chatFail) return json(s.chatFail.status, s.chatFail.body);
      await new Promise((r) => setTimeout(r, s.chatDelayMs));
      const ids = b.patch_ids ?? [];
      return json(200, {
        patch_id: ids[0] ?? '', patch_ids: ids, mode: 'compare',
        base: { content: '058420', latency_ms: 394, usage: {}, finish_reason: 'stop', truncated: false },
        patched: { content: '087600', latency_ms: 394, usage: {}, finish_reason: 'stop', truncated: false },
        applied_ms: 3255, was_applied: false, model: 'Qwen3.8-Flash-Next',
        benchmark_hit: ids.length ? true : null,
        applied: ids.map((id) => ({ patch_id: id, applied_ms: 3255, was_applied: false })),
        benchmark_hits: Object.fromEntries(ids.map((id) => [id, true])),
        history: { base: 1, patched: 1, split: false }, remaining_quota: 17, quota_limit: 20,
      });
    }

    if (pathname === '/api/me/purchases') {
      if (!this.isOperator(req)) return json(401, { error: 'operator login required' });
      return json(200, { items: s.purchases.map((p) => ({ ...p, manifest: { download_token: 'tok-secret-value-here' }, entry: this.entry(p.patch_id), applied: false })) });
    }
    if (pathname === '/api/me/patches') {
      if (!this.isOperator(req)) return json(401, { error: 'operator login required' });
      return json(200, { items: [this.entry('k1')] });
    }
    // ---- teach ------------------------------------------------------------------------------------------------
    // Every teach route is signed. The fake checks only that a v2 header is PRESENT and shaped right; `auth.test.ts`
    // is what holds the signature itself to the node's own implementation.
    const signed = () => /^0x[0-9a-fA-F]{40}:\d+:.+:v2$/.test(String(req.headers['x-ngram-auth'] ?? ''));

    if (pathname === '/api/teach/datasets' && req.method === 'POST') {
      if (!signed()) return json(401, { error: 'invalid_signature: x-ngram-auth header missing' });
      if (s.datasetFail) return json(s.datasetFail.status, s.datasetFail.body);
      const b = (body ?? {}) as { rows?: { prompt: string; answer: string; note?: string }[]; name?: string };
      const rows = (b.rows ?? []).filter((r) => r.prompt && r.answer);
      const bad = (b.rows ?? []).length - rows.length;
      // the node de-dupes by the canonical bytes: the same rows land on the same dataset
      const sha = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
      const existing = [...this.datasets.values()].find((d) => d.sha256 === sha);
      const id = existing?.id ?? `ds_${this.datasets.size + 1}`;
      this.datasets.set(id, { id, rows, sha256: sha, created: !existing, name: b.name ?? 'a training set' });
      return json(existing ? 200 : 201, {
        dataset: { id, sha256: sha, revision: 1, rows: rows.length, invalid_rows: bad, name: b.name ?? 'a training set', status: 'ready', retention: 'keep', size_bytes: JSON.stringify(rows).length },
        report: {
          summary: { source_rows: (b.rows ?? []).length, accepted: rows.length, rejected: bad, duplicates: 0, conflicts: 0, blocked: 0, too_long: 0, empty: bad, not_parsed: 0, over_cap: 0, fixed: 0, shared_ending: 0 },
          rows: [
            ...rows.map((r, i) => ({ index: i, line: i + 1, status: 'ok', prompt: r.prompt, answer: r.answer })),
            ...Array.from({ length: bad }, (_, i) => ({ index: null, line: rows.length + i + 1, status: 'empty', detail: 'the answer was blank' })),
          ],
        },
        created: !existing,
      });
    }
    const dsOne = /^\/api\/teach\/datasets\/([^/]+)$/.exec(pathname);
    if (dsOne && req.method === 'GET') {
      if (!signed()) return json(401, { error: 'invalid_signature: x-ngram-auth header missing' });
      const d = this.datasets.get(decodeURIComponent(dsOne[1] as string));
      if (!d) return json(404, { error: 'dataset_not_found: no such dataset on this node' });
      return json(200, { dataset: { id: d.id, name: d.name, sha256: d.sha256, rows: d.rows.length, invalid_rows: 0, status: 'ready', source: 'chat', retention: 'keep', revision: 1, job_ids: [], created_at: 1788000000000, expires_at: 1788600000000 } });
    }
    const dsRows = /^\/api\/teach\/datasets\/([^/]+)\/rows$/.exec(pathname);
    if (dsRows) {
      if (!signed()) return json(401, { error: 'invalid_signature: x-ngram-auth header missing' });
      const d = this.datasets.get(decodeURIComponent(dsRows[1] as string));
      if (!d) return json(404, { error: 'dataset_not_found: no such dataset on this node' });
      const offset = Number(q.get('offset') ?? 0); const limit = Number(q.get('limit') ?? 50);
      const page = d.rows.slice(offset, offset + limit);
      return json(200, { total: d.rows.length, source_rows: d.rows.length, offset, limit, summary: {}, items: page.map((r, i) => ({ index: offset + i, line: offset + i + 1, status: 'ok', prompt: r.prompt, answer: r.answer, ...(r.note ? { note: r.note } : {}) })) });
    }
    if (pathname === '/api/teach/preflight') {
      if (!signed()) return json(401, { error: 'invalid_signature: x-ngram-auth header missing' });
      if (s.preflightFail) return json(s.preflightFail.status, s.preflightFail.body);
      const b = (body ?? {}) as { facts?: { prompt: string }[]; dataset_id?: string; limit?: number };
      const n = b.facts?.length ?? Math.min(b.limit ?? 8, this.datasets.get(b.dataset_id ?? '')?.rows.length ?? 0);
      const facts = Array.from({ length: n }, (_, i) => {
        const status = s.preflightStatuses[Math.min(i, s.preflightStatuses.length - 1)] ?? 'will_train';
        return { index: i, status, ...(status === 'already_known' ? { base_answer: 'the model already says this' } : {}), ...(status === 'overlaps_listing' ? { detail: 'Knowledge k1' } : {}) };
      });
      return json(200, {
        facts, trainable: facts.filter((f) => f.status === 'will_train').length,
        quota: { key_remaining: 19, ip_remaining: 19 },
        ...(b.dataset_id ? { sampled: { checked: n, of: this.datasets.get(b.dataset_id)?.rows.length ?? n } } : {}),
      });
    }
    if (pathname === '/api/teach/jobs' && req.method === 'POST') {
      if (!signed()) return json(401, { error: 'invalid_signature: x-ngram-auth header missing' });
      if (s.jobFail) return json(s.jobFail.status, s.jobFail.body);
      const b = (body ?? {}) as Record<string, unknown>;
      const id = `lesson-${this.lessons.size + 1}`;
      this.lessons.set(id, { id, step: 0, dataset_id: String(b.dataset_id ?? ''), body: b });
      s.lessonsUsedToday += 1;
      return json(202, { job: this.lesson(id), quota: { key_remaining: Math.max(0, s.jobsPerKeyPerDay - s.lessonsUsedToday), ip_remaining: 5, rows_remaining: 300, rows_ip_remaining: 500 } });
    }
    if (pathname === '/api/teach/jobs' || pathname === '/api/teach/datasets') {
      if (!signed()) return json(401, { error: 'invalid_signature: x-ngram-auth header missing' });
      if (pathname === '/api/teach/datasets') return json(200, { items: [...this.datasets.values()].map((d) => ({ id: d.id, name: d.name, rows: d.rows.length, sha256: d.sha256, created_at: Date.now(), retention: 'keep' })) });
      // `lessonsToday` counts today's rows out of this list, so the fake reports exactly that many
      return json(200, { items: Array.from({ length: s.lessonsUsedToday }, (_, i) => ({ id: `lesson-${i + 1}`, status: 'READY', created_at: Date.now() })) });
    }
    const lessonSave = /^\/api\/teach\/jobs\/([^/]+)\/save$/.exec(pathname);
    if (lessonSave) {
      if (!signed()) return json(401, { error: 'invalid_signature' });
      const id = decodeURIComponent(lessonSave[1] as string);
      if (!this.lessons.has(id)) return json(404, { error: 'not found' });
      const token = 'tok-download-secret-0123456789';
      return json(200, {
        download: { npz_url: `/p2p/blob/${'e'.repeat(64)}?token=${token}&name=lesson.npz`, recipe_url: `/api/teach/jobs/${id}/recipe?token=${token}`, readme_url: `/api/teach/jobs/${id}/local-run?token=${token}`, expires_at: Date.now() + 86_400_000 },
        sha256: 'e'.repeat(64), rows: 3, size_bytes: 1024, filename: 'lesson-x.npz', repo_url: 'https://example.invalid/repo', model_id: 'Qwen3.8-Flash-Next',
      });
    }
    const challenge = /^\/api\/teach\/jobs\/([^/]+)\/publish-challenge$/.exec(pathname);
    if (challenge) {
      if (!signed()) return json(401, { error: 'invalid_signature' });
      return json(200, { patch_sha256: 'e'.repeat(64), benchmark_hash: 'f'.repeat(64), address: NODE_ADDRESS, signer: NODE_ADDRESS, share: 0.7, claim: 'claim-to-sign' });
    }
    const publish = /^\/api\/teach\/jobs\/([^/]+)\/publish$/.exec(pathname);
    if (publish) {
      if (!signed()) return json(401, { error: 'invalid_signature' });
      const b = (body ?? {}) as { consent?: { permanent?: boolean; rights?: boolean }; claim_sig?: string };
      if (!b.consent?.permanent || !b.consent?.rights) return json(400, { error: 'consent_required: both consent boxes are required' });
      if (!b.claim_sig) return json(401, { error: 'invalid_signature: the claim signature does not verify for this teaching key' });
      this.published.push({ job: decodeURIComponent(publish[1] as string), body: b as Record<string, unknown> });
      return json(200, s.publishStatus === 'ANNOUNCED' ? { status: 'ANNOUNCED', patch_id: 'taught-1', url: `${this.url}/k/taught-1` } : { status: 'PENDING_REVIEW' });
    }
    const lessonOne = /^\/api\/teach\/jobs\/([^/]+)$/.exec(pathname);
    if (lessonOne) {
      if (!signed()) return json(401, { error: 'invalid_signature' });
      const id = decodeURIComponent(lessonOne[1] as string);
      const l = this.lessons.get(id);
      if (!l) return json(404, { error: 'not found' });
      if (req.method === 'DELETE') { l.step = s.teachFlow.length; return json(200, { ok: true, status: 'CANCELLED' }); }
      l.step = Math.min(l.step + 1, s.teachFlow.length - 1);
      return json(200, { job: this.lesson(id) });
    }
    const recipe = /^\/api\/teach\/jobs\/([^/]+)\/(recipe|local-run)$/.exec(pathname);
    if (recipe) {
      if (!q.get('token')) return json(401, { error: 'invalid_signature: download token missing' });
      if (recipe[2] === 'recipe') return json(200, { recipe: 'json', job: decodeURIComponent(recipe[1] as string) });
      res.writeHead(200, { 'content-type': 'text/markdown' });
      res.end('# RUN LOCALLY\n');
      return;
    }
    if (pathname.startsWith('/p2p/blob/')) {
      if (!q.get('token')) return json(401, { error: 'invalid_signature: download token missing' });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '8' });
      res.end(Buffer.from('NPZFAKE\n'));
      return;
    }

    if (pathname.startsWith('/x402/patch/')) {
      const id = idOf('/x402/patch/');
      if (!s.quorum_ok) return json(423, { error: `patch not listed yet (verification 1/2)` });
      return json(402, {
        x402Version: 1, error: 'payment required',
        requirements: [{ scheme: 'local-credit', network: 'local', asset: s.currency, payTo: '0x2222222222222222222222222222222222222222', maxAmountRequired: s.price, resource: `/x402/patch/${id}`, description: 'a test knowledge', nonce: 'nonce-1', expires_at: Date.now() + 600_000 }],
        accepts: [],
      }, { 'x-payment-required': 'encoded', 'www-authenticate': 'x402' });
    }

    const buy = /^\/api\/patches\/([^/]+)\/buy$/.exec(pathname);
    if (buy) {
      if (!this.isOperator(req)) return json(401, { error: 'operator login required' });
      if (s.buyFail) return json(s.buyFail.status, { ...s.buyFail.body, ...(s.leakSecret ? { detail: `upstream said: ${s.leakSecret}` } : {}) });
      await new Promise((r) => setTimeout(r, s.buyDelayMs));
      const id = decodeURIComponent(buy[1] as string);
      s.purchases.push({ patch_id: id, amount: s.price, tx_hash: `0x${'b'.repeat(64)}`, scheme: 'local-credit', created_at: Date.now(), path: '/blobs/x.npz' });
      s.purchased = true;
      return json(200, {
        patch_id: id, amount: s.price, scheme: 'local-credit', tx_hash: `0x${'b'.repeat(64)}`, path: '/blobs/x.npz',
        manifest: { download_token: 'tok-secret-value-here', patch_sha256: 'c'.repeat(64) },
        steps: [{ step: 'quorum', detail: '2 attestation(s) ≥ quorum 2', at: 1 }, { step: '402', detail: 'payment required', at: 2 }, { step: 'settled', detail: 'paid', at: 3 }, { step: 'download', detail: 'body fetched', at: 4 }],
      });
    }
    const act = /^\/api\/patches\/([^/]+)\/(apply|remove)$/.exec(pathname);
    if (act) {
      if (!this.isOperator(req)) return json(401, { error: 'operator login required' });
      return json(200, { result: `${act[2]}: ok` });
    }
    const dataset = /^\/api\/patches\/([^/]+)\/dataset$/.exec(pathname);
    // Only a knowledge this node actually lists has a published training set. Anything else 404s, which is what an
    // uploaded `dataset_id` gets when it is handed to `get_training_set` — and what the fallback below is for.
    if (dataset) {
      const id = decodeURIComponent(dataset[1] as string);
      if (this.datasets.has(id) || id.startsWith('ds_')) return json(404, { error: 'patch not found' });
      return json(200, { sha256: 'd'.repeat(64), rows: 2761, access: 'public', license: 'CC-BY-4.0', parents: [], held: true, include_notes: false, benchmark_samples: null, merkle_root: null, preview: [{ prompt: 'Q', answer: 'A' }] });
    }
    const events = /^\/api\/patches\/([^/]+)\/events$/.exec(pathname);
    if (events) return json(200, { events: [{ ts: 1, level: 'info', kind: 'usage', message: 'live test k1' }] });
    const records = /^\/api\/patches\/([^/]+)\/records$/.exec(pathname);
    if (records) return json(200, { records: [] });
    const detail = /^\/api\/patches\/([^/]+)$/.exec(pathname);
    if (detail) {
      const id = decodeURIComponent(detail[1] as string);
      if (id === 'missing') return json(404, { error: 'patch not found' });
      return json(200, this.entry(id));
    }

    return json(404, { error: `fake node has no route for ${pathname}` });
  }

  private isOperator(req: IncomingMessage): boolean {
    return req.headers.authorization === `Bearer ${OPERATOR_TOKEN}`;
  }
}
