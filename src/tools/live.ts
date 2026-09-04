/**
 * MODEL tier (design §4.2) — the signature capability, and the two mutations that share the same model server.
 *
 * `live_test` asks ONE question twice: once of the bare model, once with the knowledge loaded, and returns both
 * answers with the verifiers' scores. It is the thing the product exists for and the thing hardest to fake.
 *
 * Nothing here blocks. `POST /api/chat` is the call that waits on the cross-process runtime lock (up to 20 minutes
 * before the node gives up), and the node has no "start and return an id" endpoint — so this server owns the
 * in-flight POST itself, hands back a job handle in milliseconds, and exposes start → poll → cancel over the node's
 * own ticket (`request_id` → `GET /api/chat/status` → `POST /api/chat/cancel`).
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Context } from '../context.js';
import { fail } from '../errors.js';
import { modelLock, verification, type NodeLock, type RawEntry } from '../format.js';
import type { Job } from '../jobs.js';
import { teachJobView, TEACH_TERMINAL, type TeachJobRaw } from '../teach-view.js';
import { echoId } from '../scrub.js';
import { tool, type ToolDef } from './types.js';

interface ChatColumn { content: string; latency_ms: number; truncated?: boolean; finish_reason?: string }
interface ChatResult {
  patch_ids: string[]; mode: string; base: ChatColumn | null; patched: ChatColumn | null;
  applied_ms: number | null; model: string; benchmark_hit: boolean | null;
  applied: { patch_id: string; applied_ms: number | null; was_applied: boolean }[];
  benchmark_hits: Record<string, boolean | null>;
  remaining_quota: number | null; quota_limit: number | null;
}

interface LiveTestPayload {
  question: string;
  knowledge: string[];
  mode: string;
  chat: ChatResult;
  verifiers: Record<string, ReturnType<typeof verification>>;
  applied_before: string[];
  /** What was pinned on the shared model when the answer came back — not the same thing as `applied_before`. */
  applied_after: string[];
  elapsed_ms: number;
}

/** What `job_status` renders once a live test lands: the before/after, the verdict, and the honest caveats. */
function liveTestView(p: LiveTestPayload) {
  const before = p.chat.base ? { answer: p.chat.base.content, latency_ms: p.chat.base.latency_ms, truncated: !!p.chat.base.truncated } : null;
  const after = p.chat.patched ? { answer: p.chat.patched.content, latency_ms: p.chat.patched.latency_ms, truncated: !!p.chat.patched.truncated } : null;
  const caveats: string[] = [];
  if (p.applied_before.length) {
    caveats.push(`the "before" column is not a bare model: ${p.applied_before.join(', ')} ${p.applied_before.length === 1 ? 'is' : 'are'} pinned on this shared model server`);
  }
  // The model is shared across every node on the machine, and a test can wait minutes on its lock. Somebody else
  // pinning or unpinning a knowledge WHILE this test ran changes what "before" meant, silently — so the pinned set
  // is read again after the answer and any difference is said out loud rather than being averaged into a claim.
  const moved = [
    ...p.applied_after.filter((id) => !p.applied_before.includes(id)).map((id) => `+${id}`),
    ...p.applied_before.filter((id) => !p.applied_after.includes(id)).map((id) => `-${id}`),
  ];
  if (moved.length) {
    caveats.push(`the shared model changed WHILE this test ran (${moved.join(', ')}): another node pinned or unpinned a knowledge, so the two columns were not answered by the same base model. Run it again when the model is quiet before reporting this as proof.`);
  }
  if (p.chat.benchmark_hit === null && p.knowledge.length) {
    caveats.push('this question is not in the knowledge\'s own benchmark, so the comparison is unscored — report it as a comparison, not as a verified result');
  }
  return {
    question: p.question,
    mode: p.chat.mode,
    before, after,
    changed: before && after ? before.answer.trim() !== after.answer.trim() : null,
    verdict: p.chat.benchmark_hit === null
      ? null
      : { benchmark_hit: p.chat.benchmark_hit, per_knowledge: p.chat.benchmark_hits,
          note: p.chat.benchmark_hit ? 'the question is in the knowledge\'s own benchmark and the "after" answer matches the expected value' : 'the question is in the knowledge\'s own benchmark and the "after" answer does NOT match the expected value' },
    knowledge: p.chat.applied.map((a) => ({
      id: a.patch_id, applied_ms: a.applied_ms, was_already_applied: a.was_applied,
      verification: p.verifiers[a.patch_id] ?? null,
    })),
    model: p.chat.model,
    pinned_on_the_shared_model: { when_it_started: p.applied_before, when_it_answered: p.applied_after },
    apply_ms_total: p.chat.applied_ms,
    elapsed_ms: p.elapsed_ms,
    quota: { remaining: p.chat.remaining_quota, limit: p.chat.quota_limit,
      shared_note: 'free live tests are metered per visitor IP — this bucket is shared by everyone using this MCP server' },
    caveats,
  };
}

export function liveTools(ctx: Context): ToolDef[] {
  const tools: ToolDef[] = [];

  if (ctx.capabilities().can_live_test) {
    tools.push(tool<{ question: string; knowledge: string[]; mode?: 'compare' | 'base' | 'patched'; history?: { role: 'system' | 'user' | 'assistant'; content: string }[]; max_tokens?: number; thinking?: boolean }>({
      name: 'live_test',
      title: 'Live test (before / after)',
      tier: 'MODEL',
      description: 'Ask one question twice — of the bare model and of the same model with the knowledge loaded — and get both answers side by side with the verifiers\' scores. This is the proof: never claim a knowledge answers something you have not live-tested. Pass knowledge: [] to get the bare model\'s answer on its own. Returns a job_id immediately (the model lock can be held for minutes by another node); poll job_status.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        question: z.string().min(1).max(4000).describe('the one question both columns answer'),
        knowledge: z.array(z.string().min(1).max(128)).max(3).describe('knowledge ids to load for the "after" column, applied in order; [] asks the bare model'),
        mode: z.enum(['compare', 'base', 'patched']).default('compare'),
        history: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string().min(1).max(4000) })).max(23).optional()
          .describe('earlier turns; the question is appended as the final user message'),
        max_tokens: z.number().int().min(1).max(1024).default(200),
        thinking: z.boolean().default(false),
      },
      handler: async (a) => {
        const messages = [...(a.history ?? []), { role: 'user' as const, content: a.question }];
        const requestId = `mcp-${randomBytes(8).toString('hex')}`;
        const state = await ctx.client.request<{ lock: NodeLock | null; now: number; queue?: { running?: unknown; waiting?: number }; applied?: string[] }>('/api/chat/patches');
        const appliedBefore = state.applied ?? [];
        const started = Date.now();
        const job = ctx.jobs.start({
          kind: 'live_test',
          native: { request_id: requestId },
          summary: `${a.question.slice(0, 60)} · ${a.knowledge.length ? a.knowledge.join(' + ') : 'bare model'}`,
          run: async (signal) => {
            const chat = await ctx.client.request<ChatResult>('/api/chat', {
              method: 'POST', signal, timeoutMs: 21 * 60_000,
              // signed when a teaching key is configured: it is what makes the caller's OWN private drafts testable
              auth: ctx.client.hasTeachKey ? 'teach' : 'none',
              body: {
                patch_ids: a.knowledge, mode: a.mode ?? 'compare', messages,
                max_tokens: a.max_tokens ?? 200, thinking: !!a.thinking, request_id: requestId,
              },
            });
            ctx.observeQuota(chat.remaining_quota, chat.quota_limit);
            const verifiers: Record<string, ReturnType<typeof verification>> = {};
            for (const id of chat.patch_ids ?? []) {
              const e = await ctx.client.request<RawEntry>(`/api/patches/${encodeURIComponent(id)}`).catch(() => null);
              if (e) verifiers[id] = verification(e);
            }
            // read AFTER the answer: `/api/chat` restores what it applied, so a difference here is somebody else's doing
            const settled = await ctx.client.request<{ applied?: string[] }>('/api/chat/patches').catch(() => ({ applied: appliedBefore }));
            const payload: LiveTestPayload = { question: a.question, knowledge: a.knowledge, mode: a.mode ?? 'compare', chat, verifiers, applied_before: appliedBefore, applied_after: settled.applied ?? appliedBefore, elapsed_ms: Date.now() - started };
            return payload;
          },
        });
        return {
          job_id: job.id, kind: 'live_test', state: job.state, native_request_id: requestId,
          poll_after_ms: 1500, next: 'call job_status with this job_id (wait_ms lets one call cover the whole wait)',
          model_lock: modelLock(state.lock, state.queue, state.now),
          applied_on_this_model: appliedBefore,
          quota: ctx.quota
            ? { remaining: ctx.quota.remaining, limit: ctx.quota.limit, observed_at: ctx.quota.observed_at, shared_note: 'shared by everyone using this MCP server (metered per visitor IP)' }
            : { remaining: null, limit: 20, shared_note: 'shared by everyone using this MCP server (metered per visitor IP); the count is only known after an answer' },
        };
      },
    }));
  }

  const applyLike = (kind: 'apply' | 'remove') => tool<{ id: string; confirm?: boolean }>({
    name: kind === 'apply' ? 'apply_knowledge' : 'remove_knowledge',
    title: kind === 'apply' ? 'Apply knowledge to the model' : 'Remove knowledge from the model',
    tier: 'MODEL',
    description: kind === 'apply'
      ? 'Load a knowledge into the model server this node serves, persistently. This changes the model every node on this machine shares, it survives a restart (the node re-applies it), and it silently changes the "before" column of everyone else\'s live test. Off by default. Returns a job handle.'
      : 'Unload a knowledge from the model server. This writes the base model back over the rows it owned — including rows another loaded knowledge shares — so it can change what a different knowledge answers. Requires confirm: true. Returns a job handle.',
    annotations: { readOnlyHint: false, destructiveHint: kind === 'remove', idempotentHint: false, openWorldHint: true },
    inputSchema: {
      id: z.string().min(1).max(128),
      confirm: z.boolean().default(false).describe(kind === 'remove' ? 'required: true — removing writes the base model over shared rows' : 'not required for apply'),
    },
    handler: async (a) => {
      if (kind === 'remove' && !a.confirm) {
        throw fail('confirmation_required', `removing ${a.id} writes the base model back over every memory row it owns, including rows another loaded knowledge shares — pass confirm: true once the human has agreed.`);
      }
      const state = await ctx.client.request<{ lock: NodeLock | null; now: number; queue?: { running?: unknown; waiting?: number } }>('/api/chat/patches');
      const job = ctx.jobs.start({
        kind,
        native: { patch_id: a.id },
        summary: `${kind} ${a.id}`,
        run: async (signal) => ctx.client.request<Record<string, unknown>>(`/api/patches/${encodeURIComponent(a.id)}/${kind}`, {
          method: 'POST', auth: 'operator', signal, timeoutMs: 21 * 60_000, body: {},
        }),
      });
      return {
        job_id: job.id, kind, state: job.state, patch_id: a.id, poll_after_ms: 2000,
        model_lock: modelLock(state.lock, state.queue, state.now),
        warning: 'this changes the model server every node on this machine shares; the change persists across restarts and is visible to every other user of that model',
        next: 'call job_status with this job_id',
      };
    },
  });

  if (ctx.capabilities().can_apply) tools.push(applyLike('apply'), applyLike('remove'));

  /** The node's own live view for a live-test ticket: queued / running / gone, position, and the lock. */
  const chatStatus = async (job: Job) => {
    if (!job.native.request_id) return null;
    return ctx.client.request<{ state: string; queued_ms?: number; running_ms?: number; position?: number; cancelled?: boolean; lock: NodeLock | null; running?: unknown; waiting?: number; now: number }>(
      `/api/chat/status?request_id=${encodeURIComponent(job.native.request_id)}`,
    ).catch(() => null);
  };

  /** A lesson's own state on the node — the 13-state machine, read straight through. */
  const teachStatus = async (lessonId: string) => {
    const out = await ctx.client.request<{ job: TeachJobRaw }>(`/api/teach/jobs/${encodeURIComponent(lessonId)}`, { auth: 'teach' }).catch(() => null);
    return out?.job ?? null;
  };

  tools.push(tool<{ job_id: string; wait_ms?: number }>({
    name: 'job_status',
    title: 'Job status',
    tier: 'READ',
    description: 'Where a job started by live_test, teach, teach_preflight, apply_knowledge, remove_knowledge or buy has got to, and its result once it lands — for a lesson, that means what the model learned and what it did not. wait_ms long-polls inside this server (it does not hold a request open on the node), turning a poll loop into one call. Every answer says who holds the shared model and how many are waiting. A node lesson id works here too, so a conversation that lost its job_id is not stuck.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      job_id: z.string().min(1).max(64).describe('an MCP job_id from this session, or a node lesson id (node_job_id)'),
      wait_ms: z.number().int().min(0).max(25_000).default(0).describe('wait up to this long for the next state change before answering'),
    },
    handler: async (a) => {
      const job = ctx.jobs.get(a.job_id);
      if (!job) {
        // Recovery: the id may be a lesson on the node itself — a session restart loses the job table, not the lesson.
        const lesson = ctx.client.hasTeachKey ? await teachStatus(a.job_id) : null;
        if (lesson) {
          return {
            job_id: null, kind: 'teach', from: 'the node, not this session\'s job table',
            ...teachJobView(lesson, { canPublish: ctx.cfg.allow.publish && ctx.client.hasTeachKey, nodeUrl: ctx.client.url }),
            model_lock: await ctx.modelLock(),
            poll_after_ms: TEACH_TERMINAL.includes(lesson.status) ? 0 : 3000,
          };
        }
        throw fail('job_not_found', `no job ${echoId(a.job_id)} on this server (jobs are session-scoped and evicted 30 minutes after they finish) — call job_list to see what is still here.`);
      }
      if (a.wait_ms) await ctx.jobs.waitForChange(a.job_id, a.wait_ms);
      const live = job.kind === 'live_test' ? await chatStatus(job) : null;
      const lesson = job.kind === 'teach' && job.native.teach_job_id ? await teachStatus(job.native.teach_job_id) : null;
      if (lesson) ctx.jobs.observe(job.id, lesson.status);
      if (live?.state) ctx.jobs.observe(job.id, live.state);
      const lockView = live ? modelLock(live.lock, { running: live.running, waiting: live.waiting }, live.now) : await ctx.modelLock();
      const base = {
        job_id: job.id, kind: job.kind, state: job.state, native_state: job.native_state,
        summary: job.summary, started_at: job.started_at, finished_at: job.finished_at,
        elapsed_ms: (job.finished_at ?? Date.now()) - job.started_at,
        model_lock: lockView,
        ...(job.native.teach_job_id ? { node_job_id: job.native.teach_job_id } : {}),
        ...(live ? { position: live.position ?? null, queued_ms: live.queued_ms ?? null, running_ms: live.running_ms ?? null } : {}),
        // a lesson in flight: the node's own progress, ETA and "what is happening", without waiting for it to finish
        ...(lesson && !job.finished_at
          ? { lesson: teachJobView(lesson, { canPublish: ctx.cfg.allow.publish && ctx.client.hasTeachKey, nodeUrl: ctx.client.url }) }
          : {}),
        poll_after_ms: job.finished_at ? 0 : job.kind === 'teach' ? 3000 : 1500,
      };
      if (job.state === 'done') {
        const result = job.kind === 'live_test' ? liveTestView(job.result as LiveTestPayload) : (job.result as Record<string, unknown>);
        return { ...base, result };
      }
      if (job.state === 'failed' || job.state === 'cancelled') {
        const { toToolError } = await import('../errors.js');
        return { ...base, error: job.error ? toToolError(job.error) : { code: 'cancelled', message: 'the job was cancelled', retryable: false } };
      }
      if (job.kind === 'teach' && !job.native.teach_job_id) {
        return { ...base, hint: 'the training set is being uploaded and the model is being asked what it already knows — the lesson has not been submitted yet, so no daily lesson has been charged' };
      }
      return { ...base, hint: job.kind === 'live_test' && lockView.holder ? `waiting: ${lockView.sentence}` : 'still working — poll again, or call job_cancel to give up' };
    },
  }));

  tools.push(tool<{ job_id: string; reason?: string }>({
    name: 'job_cancel',
    title: 'Cancel a job',
    tier: 'MODEL',   // it acts on the node's queue, so the answer carries the model lock like the rest of the tier
    description: 'Give up on a job. Cancelling a live test that is still QUEUED is genuinely free — nothing reached the model and no free try was consumed. Once it is running the work and the charge stand, and this tool says so instead of pretending otherwise. A buy that has already paid cannot be cancelled: use reconcile_purchase.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { job_id: z.string().min(1).max(64), reason: z.string().max(200).optional() },
    handler: async (a) => {
      const job = ctx.jobs.get(a.job_id);
      if (!job) throw fail('job_not_found', `no job ${echoId(a.job_id)} on this server.`);
      let node: { cancelled?: boolean; reason?: string; charged?: boolean } | null = null;
      if (job.native.request_id) {
        node = await ctx.client.request<{ cancelled: boolean; reason: string; charged: boolean }>('/api/chat/cancel', { method: 'POST', body: { request_id: job.native.request_id } }).catch(() => null);
      }
      // A lesson is cancelled on the node itself, and the daily lesson it consumed is NOT returned: the node charges
      // at submit time. Saying "cancelled" without saying that would misreport what it cost.
      let lessonCancelled: Record<string, unknown> | null = null;
      if (job.native.teach_job_id) {
        lessonCancelled = await ctx.client.request<Record<string, unknown>>(`/api/teach/jobs/${encodeURIComponent(job.native.teach_job_id)}`, { method: 'DELETE', auth: 'teach' }).catch(() => null);
      }
      ctx.jobs.abort(a.job_id);
      return {
        job_id: a.job_id, kind: job.kind,
        cancelled: node?.cancelled ?? (job.native.teach_job_id ? !!lessonCancelled : true),
        reason: node?.reason ?? (job.native.teach_job_id ? (lessonCancelled ? 'lesson cancelled on the node' : 'the node did not accept the cancel') : 'aborted locally'),
        charged: node?.charged ?? !!job.native.teach_job_id,
        ...(job.native.teach_job_id ? { node_job_id: job.native.teach_job_id } : {}),
        note: node?.reason === 'already_running'
          ? 'the node had already started this on the model: the work and the metered try stand, and stopping the wait here does not stop the node'
          : job.native.teach_job_id
            ? 'the lesson is cancelled, but the daily lesson it consumed is NOT returned — the node charges one at submit time, before any training happens'
            : job.kind === 'buy'
              ? 'a buy that had already reached the gateway may still have settled — call reconcile_purchase before ever buying again'
              : job.kind === 'teach'
                ? 'the lesson had not been submitted to the node yet, so no daily lesson was charged'
                : 'nothing had reached the model, so nothing was charged',
      };
    },
  }));

  tools.push(tool<{ kind?: string; state?: string; limit?: number }>({
    name: 'job_list',
    title: 'List jobs',
    tier: 'READ',
    description: 'The jobs this MCP session started, newest first — so a conversation that lost a job_id is not stuck. Jobs are evicted 30 minutes after they finish.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      kind: z.enum(['live_test', 'preflight', 'teach', 'buy', 'apply', 'remove']).optional(),
      state: z.enum(['queued', 'running', 'done', 'failed', 'cancelled']).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    },
    handler: async (a) => ({
      jobs: ctx.jobs.list({ kind: a.kind as never, state: a.state as never, limit: a.limit }).map((j) => ({
        job_id: j.id, kind: j.kind, state: j.state, native_state: j.native_state, summary: j.summary,
        started_at: j.started_at, finished_at: j.finished_at,
      })),
    }),
  }));

  return tools;
}
