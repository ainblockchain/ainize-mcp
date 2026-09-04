/**
 * READ tier (design §4.1) — free, fast, no side effects, nothing that can surprise anyone.
 *
 * Everything here is a public node endpoint except the two `my_library` sections that need a credential; each of
 * those is omitted with a reason rather than failing the whole call.
 */
import { z } from 'zod';
import type { Context } from '../context.js';
import { fail, UpstreamError } from '../errors.js';
import { knowledgeRow, modelLock, verification, type RawEntry, type NodeLock } from '../format.js';
import { tool, type ToolDef } from './types.js';

const idArg = z.string().min(1).max(128).describe('the knowledge id, e.g. "krx-all-2761"');

/** A DRAFT is 404 to anyone but its owner — deliberately, so a non-owner learns nothing from the error shape. */
const entryOf = async (ctx: Context, id: string): Promise<RawEntry & Record<string, unknown>> => {
  try {
    return await ctx.client.request<RawEntry & Record<string, unknown>>(`/api/patches/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e instanceof UpstreamError && e.status === 404) throw fail('not_found', `no knowledge with id ${JSON.stringify(id)} on ${ctx.client.url} (a private draft is invisible to anyone but its owner). Try search_knowledge.`);
    throw e;
  }
};

export function readTools(ctx: Context): ToolDef[] {
  const searchTool = tool<{ query?: string; model?: string; schema?: string; author?: string; origin?: 'operator' | 'teach'; status?: string[]; sort?: 'latest' | 'popular' | 'price' | 'rows'; limit?: number; offset?: number }>({
    name: 'search_knowledge',
    title: 'Search knowledge',
    tier: 'READ',
    description: 'Browse or search the knowledge this node and its peers sell: trained memory-table patches a node applies into a running LLM. Returns compact rows (id, name, price, rows, status, verification quorum, benchmark schema). Use this first when the model gave a wrong or outdated answer and you want to find something that fixes it. Free, no side effects.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      query: z.string().max(200).optional().describe('substring over id, name, description, model and benchmark schema'),
      model: z.string().max(120).optional().describe('serving model id, e.g. "Qwen3.8-Flash-Next"'),
      schema: z.string().max(120).optional().describe('benchmark schema, e.g. "krx-ticker-codes"'),
      author: z.string().max(64).optional().describe('seller address'),
      origin: z.enum(['operator', 'teach']).optional().describe('"teach" = taught by a visitor through the teach door'),
      status: z.array(z.enum(['LISTED', 'ANNOUNCED', 'VERIFYING', 'SUPERSEDED', 'CHALLENGED', 'REJECTED'])).max(6).optional(),
      sort: z.enum(['latest', 'popular', 'price', 'rows']).default('latest'),
      limit: z.number().int().min(1).max(50).default(20),
      offset: z.number().int().min(0).default(0),
    },
    handler: async (a) => {
      const q = new URLSearchParams({ sort: a.sort ?? 'latest', limit: String(a.limit ?? 20), offset: String(a.offset ?? 0) });
      if (a.query) q.set('q', a.query);
      if (a.model) q.set('model', a.model);
      if (a.schema) q.set('schema', a.schema);
      if (a.author) q.set('author', a.author);
      if (a.origin) q.set('origin', a.origin);
      if (a.status?.length) q.set('status', a.status.join(','));
      const out = await ctx.client.request<{ total: number; items: RawEntry[]; models: string[]; schemas: string[] }>(`/api/catalog?${q}`);
      return {
        total: out.total,
        shown: out.items.length,
        offset: a.offset ?? 0,
        items: out.items.map((e) => knowledgeRow(e, ctx.client.url)),
        facets: { models: out.models, schemas: out.schemas },
        note: out.total > out.items.length ? `showing ${out.items.length} of ${out.total} — raise limit or pass offset` : undefined,
      };
    },
  });

  const getTool = tool<{ id: string; include?: ('lineage' | 'conflicts' | 'records' | 'events' | 'siblings')[] }>({
    name: 'get_knowledge',
    title: 'Knowledge detail',
    tier: 'READ',
    description: 'Everything about one knowledge: what it claims, who verified it and with what score, its family, the base stack it needs (requires[]), and whether this node already holds or bought it. Read this before quoting or live-testing. Free.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      id: idArg,
      include: z.array(z.enum(['lineage', 'conflicts', 'records', 'events', 'siblings'])).max(5).optional()
        .describe('extra sections; each costs one more read. lineage and requires are always included.'),
    },
    handler: async (a) => {
      const e = await entryOf(ctx, a.id);
      const inc = new Set(a.include ?? []);
      const id = encodeURIComponent(a.id);
      const [records, events, siblings] = await Promise.all([
        inc.has('records') ? ctx.client.request<{ records: unknown[] }>(`/api/patches/${id}/records`).catch(() => ({ records: [] })) : null,
        inc.has('events') ? ctx.client.request<{ events: unknown[] }>(`/api/patches/${id}/events?limit=50`).catch(() => ({ events: [] })) : null,
        inc.has('siblings') ? ctx.client.request<{ items: RawEntry[] }>(`/api/benchmarks/${encodeURIComponent(e.anchor.benchmark.schema)}`).catch(() => ({ items: [] })) : null,
      ]);
      const requires = (e.requires as { id: string; name: string; held: boolean; price: string | null }[] | undefined) ?? [];
      return {
        knowledge: {
          ...knowledgeRow(e, ctx.client.url),
          description: e.anchor.description ?? '',
          license: (e.anchor.license as string | undefined) ?? null,
          topic_path: (e.anchor.topic_path as string | undefined) ?? null,
          benchmark_queries: e.anchor.benchmark.queries ?? null,
          supersedes: e.supersedes ?? [],
          superseded_by: e.superseded_by ?? [],
        },
        verification: verification(e),
        lineage: e.lineage ?? { parents: [], children: [] },
        requires,
        requires_note: requires.length
          ? 'this is an add-on: the bases above must be loaded first, and `buy` purchases one knowledge at a time — quote the whole stack before spending'
          : null,
        availability: {
          has_body: !!e.has_body, purchased: !!e.purchased, owned: !!e.owned, applied: !!e.applied,
          dataset_held: e.dataset_held ?? null, gateway_url: (e.gateway_url as string | null) ?? null,
        },
        training_set: e.anchor.dataset
          ? { access: e.anchor.dataset.access ?? null, license: e.anchor.dataset.license ?? null, rows: e.anchor.dataset.rows ?? null, sha256: e.anchor.dataset.sha256 ?? null }
          : null,
        ...(inc.has('conflicts') ? { conflicts: e.conflicts ?? [] } : {}),
        ...(records ? { records: records.records } : {}),
        ...(events ? { events: events.events } : {}),
        ...(siblings ? { siblings: siblings.items.filter((s) => s.anchor.id !== a.id).map((s) => knowledgeRow(s, ctx.client.url)) } : {}),
      };
    },
  });

  const treeTool = tool<{ id: string; depth?: number; direction?: 'up' | 'down' | 'both' }>({
    name: 'family_tree',
    title: 'Family tree',
    tier: 'READ',
    description: 'Ancestors, descendants and versions around one knowledge, walked from the ledger graph. Use it to see whether a cheaper parent or a newer version exists before buying. Free.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      id: idArg,
      depth: z.number().int().min(1).max(4).default(2),
      direction: z.enum(['up', 'down', 'both']).default('both'),
    },
    handler: async (a) => {
      const graph = await ctx.client.request<{ nodes: { id: string; name: string; author: string; status: string; model: string; schema: string }[]; edges: { from: string; to: string; type: string }[] }>('/api/ledger/graph');
      const byId = new Map(graph.nodes.map((n) => [n.id, n]));
      if (!byId.has(a.id)) throw fail('not_found', `no knowledge with id ${JSON.stringify(a.id)} in this node's ledger graph.`);
      const dir = a.direction ?? 'both';
      const depth = a.depth ?? 2;
      const keptEdges: { from: string; to: string; kind: string }[] = [];
      const seen = new Set<string>([a.id]);
      let frontier = [a.id];
      let truncated = false;
      const CAP = 40;
      for (let d = 0; d < depth && frontier.length; d++) {
        const next: string[] = [];
        for (const cur of frontier) {
          for (const e of graph.edges) {
            const up = e.from === cur && (dir === 'up' || dir === 'both');       // cur extends/supersedes e.to
            const down = e.to === cur && (dir === 'down' || dir === 'both');     // e.from builds on cur
            if (!up && !down) continue;
            const other = up ? e.to : e.from;
            if (!byId.has(other)) continue;
            if (!keptEdges.some((k) => k.from === e.from && k.to === e.to)) keptEdges.push({ from: e.from, to: e.to, kind: e.type });
            if (seen.has(other)) continue;
            if (seen.size >= CAP) { truncated = true; continue; }
            seen.add(other);
            next.push(other);
          }
        }
        frontier = next;
      }
      return {
        root: a.id,
        nodes: [...seen].map((id) => { const n = byId.get(id)!; return { id, name: n.name, author: n.author, status: n.status, schema: n.schema, added: null, signals: null }; }),
        edges: keptEdges,
        truncated,
        note: 'Edge kinds beyond extends/supersedes, per-node `added` counts and usage signals are not recorded by the node yet (lineage design §12.5, PR L6). `added` and `signals` are null, not 0 — do not report a number here.',
      };
    },
  });

  const trainingSetTool = tool<{ id: string; rows?: boolean; limit?: number }>({
    name: 'get_training_set',
    title: 'Training set preview',
    tier: 'READ',
    description: 'Preview the questions and answers a published knowledge was trained from, with its access level and licence. Use it to judge whether a knowledge really covers your question before paying. Free. A `derivative` set needs a teaching key (this server signs with its own when one is configured); a `private` one is refused with its metadata.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      id: idArg,
      rows: z.boolean().default(false).describe('true = fetch the full row stream instead of the 20-row preview (public access only)'),
      limit: z.number().int().min(1).max(200).default(20),
    },
    handler: async (a) => {
      const id = encodeURIComponent(a.id);
      const auth = ctx.client.hasTeachKey ? 'teach' as const : 'none' as const;
      const meta = await ctx.client.request<Record<string, unknown>>(`/api/patches/${id}/dataset`, { auth });
      const preview = (meta.preview as { prompt: string; answer: string; note?: string }[] | undefined) ?? [];
      let rows: unknown[] | null = null;
      if (a.rows) {
        try {
          const text = await ctx.client.request<string>(`/api/patches/${id}/dataset/rows`, { auth });
          rows = String(text).split('\n').filter(Boolean).slice(0, a.limit ?? 20).map((l) => JSON.parse(l) as unknown);
        } catch { rows = null; }
      }
      return {
        id: a.id,
        sha256: meta.sha256, rows_total: meta.rows, access: meta.access, license: meta.license,
        parents: meta.parents ?? [], held: meta.held, include_notes: meta.include_notes ?? false,
        merkle_root: meta.merkle_root ?? null,
        preview: preview.slice(0, a.limit ?? 20),
        rows,
        rows_note: a.rows && rows === null ? 'the full row stream is public-access only (or not held here) — the 20-row preview is what this node will show' : undefined,
      };
    },
  });

  const statusTool = tool<{ refresh?: boolean }>({
    name: 'node_status',
    title: 'Node status',
    tier: 'READ',
    description: 'What this node is, whether the shared model is free and who holds it, what this MCP server is allowed to do (capabilities), the free live-test quota as last observed, and the teach policy. Call it when a job says the model is busy, or before spending anything.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { refresh: z.boolean().default(false).describe('force a live probe of the model server (adds up to ~3 s)') },
    handler: async (a) => {
      const info = await ctx.nodeInfo(!!a.refresh);
      const chat = await ctx.client.request<{ runtime: Record<string, unknown>; lock: NodeLock | null; now: number; queue?: { running?: unknown; waiting?: number }; applied?: string[] }>('/api/chat/patches');
      const runtime = a.refresh
        ? await ctx.client.request<Record<string, unknown>>('/api/runtime', { timeoutMs: 10_000 }).catch(() => chat.runtime)
        : chat.runtime;
      const policy = await ctx.teachPolicy();
      const applied = chat.applied ?? [];
      const warnings: string[] = [];
      if (applied.length) warnings.push(`knowledge is pinned on this model server (${applied.join(', ')}) — it colours the "before" column of every live test on every node sharing it`);
      if (info.ledger === 'ain') warnings.push('this node is on the shared AIN chain: publishing and announcing are refused by this server unless explicitly allowed');
      return {
        node: { ...info, applied },
        runtime,
        model_lock: modelLock(chat.lock, chat.queue, chat.now),
        quota: ctx.quota
          ? { live_tests_remaining: ctx.quota.remaining, limit: ctx.quota.limit, observed_at: ctx.quota.observed_at,
              shared_note: 'the node meters free live tests per visitor IP, so this bucket is shared by everyone using this MCP server' }
          : { live_tests_remaining: null, limit: 20, observed_at: null,
              shared_note: 'the node has no quota endpoint — the remaining count is only known after a live test answers. 20 per rolling hour per visitor IP, shared by everyone using this MCP server.' },
        teach_policy: policy
          ? { enabled: policy.enabled, publish: policy.publish, trainer: policy.trainer, backend: policy.backend, limits: policy.limits, lineage: policy.lineage ?? null }
          : null,
        capabilities: ctx.capabilities(),
        capability_reasons: ctx.capabilityReasons(),
        budget: ctx.budget.view(),
        server: ctx.configSummary(),
        warnings,
      };
    },
  });

  const libraryTool = tool<{ include?: ('purchases' | 'published' | 'applied' | 'lessons' | 'datasets')[] }>({
    name: 'my_library',
    title: 'My library',
    tier: 'READ',
    description: 'What this node already owns and what this teaching key already made: purchases (with tx hash and date), published knowledge, the applied stack, my teach jobs and my training sets. Check it before buying anything — a knowledge you already bought must never be bought twice. Free.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { include: z.array(z.enum(['purchases', 'published', 'applied', 'lessons', 'datasets'])).max(5).optional() },
    handler: async (a) => {
      const want = new Set(a.include ?? ['purchases', 'published', 'applied', 'lessons', 'datasets']);
      const omitted: { section: string; reason: string }[] = [];
      const out: Record<string, unknown> = {};
      const operator = ctx.client.hasOperator;
      const teach = ctx.client.hasTeachKey;

      if (want.has('purchases')) {
        if (!operator) omitted.push({ section: 'purchases', reason: 'no operator credential is configured on this MCP server' });
        else {
          const p = await ctx.client.request<{ items: Record<string, unknown>[] }>('/api/me/purchases', { auth: 'operator' });
          // the manifest is never returned — it carries a download_token. `body_present` is what an agent needs.
          out.purchases = p.items.map((row) => ({
            patch_id: row.patch_id, amount: row.amount, currency: (row.currency as string) ?? null, scheme: row.scheme,
            tx_hash: row.tx_hash, bought_at: row.created_at, body_present: !!row.path, applied: !!row.applied,
            name: ((row.entry as { anchor?: { name?: string } } | null)?.anchor?.name) ?? null,
          }));
        }
      }
      if (want.has('published')) {
        if (!operator) omitted.push({ section: 'published', reason: 'no operator credential is configured on this MCP server' });
        else {
          const p = await ctx.client.request<{ items: RawEntry[] }>('/api/me/patches', { auth: 'operator' });
          out.published = p.items.map((e) => knowledgeRow(e, ctx.client.url));
        }
      }
      if (want.has('applied')) {
        const rt = await ctx.client.request<{ applied?: unknown[] }>('/api/runtime').catch(() => ({ applied: [] }));
        out.applied = rt.applied ?? [];
      }
      if (want.has('lessons')) {
        if (!teach) omitted.push({ section: 'lessons', reason: 'no teaching key is configured on this MCP server (AINIZE_TEACH_KEY)' });
        else {
          const j = await ctx.client.request<{ items: Record<string, unknown>[] }>('/api/teach/jobs', { auth: 'teach' }).catch((e) => { omitted.push({ section: 'lessons', reason: String((e as Error).message).slice(0, 200) }); return { items: [] }; });
          out.lessons = j.items.map((r) => ({ id: r.id, status: r.status, name: r.name, draft_id: r.draft_id, patch_id: r.patch_id, created_at: r.created_at }));
        }
      }
      if (want.has('datasets')) {
        if (!teach) omitted.push({ section: 'datasets', reason: 'no teaching key is configured on this MCP server (AINIZE_TEACH_KEY)' });
        else {
          const d = await ctx.client.request<{ items: Record<string, unknown>[] }>('/api/teach/datasets', { auth: 'teach' }).catch((e) => { omitted.push({ section: 'datasets', reason: String((e as Error).message).slice(0, 200) }); return { items: [] }; });
          out.datasets = d.items.map((r) => ({ id: r.id, name: r.name, rows: r.rows, sha256: r.sha256, created_at: r.created_at, retention: r.retention }));
        }
      }
      return { ...out, omitted, teaching_key_address: ctx.client.teachAddress };
    },
  });

  const signalsTool = tool<{ id: string; limit?: number }>({
    name: 'knowledge_signals',
    title: 'Knowledge signals',
    tier: 'READ',
    description: 'How much a knowledge has actually been used and scored, as far as THIS node can see: downloads, settlements, attestations and the recent event stream. Node-local and partial — per-day test/hit/miss counters exist in the node database but are not exposed by any endpoint yet.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { id: idArg, limit: z.number().int().min(1).max(100).default(20) },
    handler: async (a) => {
      const e = await entryOf(ctx, a.id);
      const ev = await ctx.client.request<{ events: { ts: number; level: string; kind: string; message: string }[] }>(`/api/patches/${encodeURIComponent(a.id)}/events?limit=${a.limit ?? 20}`).catch(() => ({ events: [] }));
      return {
        id: a.id,
        downloads: e.downloads,
        revenue: (e as unknown as { revenue?: string }).revenue ?? null,
        verification: verification(e),
        events: ev.events,
        signals: null,
        note: 'GET /api/patches/:id/signals and /issues are PR L6 and do not exist yet: `signals` is null, not zero. Events are redacted for non-operators, and everything here is what this one node recorded — not network truth.',
      };
    },
  });

  const teacherTool = tool<{ address: string }>({
    name: 'teacher_profile',
    title: 'Teacher profile',
    tier: 'READ',
    description: 'A data provider\'s lessons and earnings on this node — who taught what, and what it paid them. Free.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe('the teaching key address of the data provider') },
    handler: async (a) => ctx.client.request<Record<string, unknown>>(`/api/teacher/${a.address}`),
  });

  return [searchTool, getTool, treeTool, trainingSetTool, statusTool, libraryTool, signalsTool, teacherTool];
}
