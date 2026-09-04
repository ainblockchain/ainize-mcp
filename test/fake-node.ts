/**
 * A fake Ainize node: the endpoints the tool set actually calls, with the shapes the real node returns, plus a
 * request log so a test can assert what was NOT called (a dry run must not touch `/x402/...`; a replayed buy must
 * not reach the node at all).
 */
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
}

export const NODE_ADDRESS = '0x1111111111111111111111111111111111111111';
export const OPERATOR_TOKEN = 'fake-session-token-0123456789';

export class FakeNode {
  readonly requests: RecordedRequest[] = [];
  readonly state: FakeState = {
    price: '5', currency: 'CREDIT', ledger: 'local', quorum_ok: true, sellable: true, purchased: false, owned: false,
    has_body: false, requires: [], purchases: [], settlements: [], runtimeAvailable: true, teachEnabled: true,
    lock: null, waiting: 0, chatDelayMs: 5, chatFail: null, buyFail: null, buyDelayMs: 5, leakSecret: null,
  };
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
    if (pathname === '/api/teach/jobs' || pathname === '/api/teach/datasets') {
      if (!req.headers['x-ngram-auth']) return json(401, { error: 'invalid_signature: x-ngram-auth header missing' });
      return json(200, { items: [] });
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
    if (dataset) return json(200, { sha256: 'd'.repeat(64), rows: 2761, access: 'public', license: 'CC-BY-4.0', parents: [], held: true, include_notes: false, benchmark_samples: null, merkle_root: null, preview: [{ prompt: 'Q', answer: 'A' }] });
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
