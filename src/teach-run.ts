/**
 * One lesson, start to finish — upload → preflight → submit → poll — with nobody's job table attached.
 *
 * This is the body of the `teach` tool's run closure, lifted out unchanged so there is exactly ONE implementation of
 * the sequence that spends a scarce, non-refundable daily lesson. The MCP tool calls it inside a job handle; the
 * agent (`packages/agent`) calls it directly when it decides to ainize what it has been paying to retrieve. A second
 * copy of this sequence would be a second place for the lesson accounting to be wrong.
 *
 * What travels with the lift, and why:
 *  - **the session reservation.** A lesson is scarce the way money is scarce, so the allowance is held BEFORE the
 *    upload (`reserveLesson`) and given back only where nothing was queued: `nothing_to_train` (never submitted) and
 *    a node that REFUSED the submission (429/400 — the node charges at submit time, and only when it accepts).
 *    A lesson the node ACCEPTED and then failed stays spent, because the node does not refund it either.
 *  - **the caller's handle.** The job table lives in the MCP server, not here, so the two lines that recorded the
 *    node's lesson id and its state are now one `onState` callback. A caller with no job table passes none.
 *
 * Nothing here decides WHETHER to teach. The gates — a base that cannot be built on, the last lesson of the day, a
 * dry run — are the caller's, because they are what the caller must show a human before any of this runs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Context } from './context.js';
import { fail } from './errors.js';
import { rowsSha256, withProvenanceNotes, type RowProvenance, type TeachRow } from './rows.js';
import { teachJobView, TEACH_TERMINAL, type TeachJobRaw } from './teach-view.js';

/** The node probes at most 8 questions per preflight call (`packages/node/src/teach.ts`). */
export const PREFLIGHT_MAX = 8;

interface DatasetCreateResult {
  dataset: { id: string; sha256: string; revision: number; rows: number; invalid_rows: number; name: string; status: string; retention: string; size_bytes: number };
  report: { summary: Record<string, number>; rows: { index: number | null; line: number; status: string; detail?: string; prompt?: string }[] };
  created: boolean;
}

export interface UploadInput {
  rows: TeachRow[];
  name?: string;
  retention?: 'keep' | 'delete_after_training';
  provenance?: Record<string, unknown>;
}

/**
 * `POST /api/teach/datasets` (the JSON door — never multipart, whose signature has to cover a header instead of the
 * body). Exported because the direction-B example uploads through exactly this path: one code path, one set of
 * rules, one place to be wrong.
 */
export async function uploadTrainingSet(ctx: Context, input: UploadInput): Promise<Record<string, unknown>> {
  const prov = input.provenance as unknown as RowProvenance | undefined;
  // Provenance rides on the rows themselves: the node's dataset API has no field for it yet (design §11.4), and a
  // row's own `note` is the one place that survives training, publication and a buyer's download.
  const stamped = prov?.server && prov?.tool && prov?.arguments_sha256
    ? withProvenanceNotes(input.rows, prov as Parameters<typeof withProvenanceNotes>[1])
    : input.rows;
  const predicted = rowsSha256(stamped);
  const out = await ctx.client.raw<DatasetCreateResult>('/api/teach/datasets', {
    method: 'POST', auth: 'teach',
    body: {
      source: 'inline', rows: stamped,
      ...(input.name ? { name: input.name.slice(0, 80) } : {}),
      ...(input.retention ? { retention: input.retention } : {}),
    },
  });
  const d = out.body.dataset;
  // 'ok' | 'fixed' | 'pii' are the statuses that mean the question IS in rows.jsonl (core's ACCEPTED_ROW_STATUSES);
  // everything else was refused, and the node reports why, per row, for all of them.
  const accepted = new Set(['ok', 'fixed', 'pii']);
  const rejected = out.body.report.rows.filter((r) => !accepted.has(r.status));
  const stored = prov ? storeProvenance(ctx, d.id, { ...prov, dataset_id: d.id } as unknown as Record<string, unknown>) : null;
  return {
    dataset_id: d.id,
    existing: !out.body.created,
    name: d.name,
    rows_accepted: d.rows,
    rows_rejected: rejected.map((r) => ({ line: r.line, status: r.status, detail: r.detail ?? null, prompt: r.prompt ?? null })),
    sha256: d.sha256,
    revision: d.revision,
    size_bytes: d.size_bytes,
    retention: d.retention,
    summary: out.body.report.summary,
    predicted_sha256: predicted,
    sha256_matches_prediction: predicted === d.sha256,
    ...(prov
      ? {
          provenance: {
            recorded: 'client-declared',
            note_on_rows: stamped.filter((r) => r.note).length,
            stored_at: stored,
            note: 'the provenance line is written into each row\'s own note (the node has no provenance field yet) and the full record is kept beside this server\'s journal',
          },
        }
      : {}),
    note: out.body.created
      ? 'a new training set was created on the node'
      : 'these exact bytes were already on the node — the same training set is returned rather than a second copy (the node de-dupes by sha256)',
  };
}

/** Keep the full provenance record next to the purchase journal, so a later publish can quote it. Best-effort. */
function storeProvenance(ctx: Context, datasetId: string, record: Record<string, unknown>): string | null {
  if (!ctx.cfg.stateDir) return null;
  try {
    const dir = join(resolve(ctx.cfg.stateDir), 'provenance');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${datasetId}.json`);
    writeFileSync(path, JSON.stringify(record, null, 2), { mode: 0o600 });
    return path;
  } catch { return null; }
}

export interface TeachPolicy {
  enabled?: boolean; publish?: string; trainer?: string; backend?: string;
  limits?: { facts_per_job?: number; jobs_per_key_per_day?: number; rows_per_job?: number; prompt_max?: number; answer_max?: number };
  queue?: { depth?: number; max?: number };
  shares?: { contributor?: number; lineage?: number };
  /** Feature flag `teach.lineage`: absent on a node built before the flag existed, so it is never read as `false`. */
  lineage?: boolean;
  simulated_checks?: boolean;
}

export interface LessonsToday { limit: number | null; used_today: number | null; remaining: number | null; note: string }

/**
 * How many lessons this teaching key has left today, computed the way the node counts them: one per job created in
 * the current UTC day. There is no quota endpoint, so this is an estimate from the key's own job list — it is
 * reported as such, and it is never the only guard (the node refuses with `quota_key` regardless).
 */
export async function lessonsToday(ctx: Context): Promise<LessonsToday> {
  const policy = (await ctx.teachPolicy()) as TeachPolicy | null;
  const limit = policy?.limits?.jobs_per_key_per_day ?? null;
  try {
    const mine = await ctx.client.request<{ items: { created_at: number }[] }>('/api/teach/jobs', { auth: 'teach' });
    const day = new Date().toISOString().slice(0, 10);
    const used = mine.items.filter((j) => new Date(j.created_at).toISOString().slice(0, 10) === day).length;
    return {
      limit, used_today: used, remaining: limit === null ? null : Math.max(0, limit - used),
      note: 'counted from this key\'s own lessons today (UTC); the node also caps lessons per IP, which this cannot see',
    };
  } catch {
    return { limit, used_today: null, remaining: null, note: 'the node did not answer the lesson list, so only the daily limit is known' };
  }
}

export interface PreflightAnswer {
  facts: { index: number; status: 'will_train' | 'already_known' | 'overlaps_listing' | 'invalid' | 'in_base' | 'base_conflict'; detail?: string; base_answer?: string }[];
  trainable: number;
  quota: { key_remaining: number; ip_remaining: number };
  sampled?: { checked: number; of: number };
}

export const preflightView = (rows: TeachRow[], out: PreflightAnswer) => ({
  trainable: out.trainable,
  checked: out.facts.length,
  ...(out.sampled ? { sampled: { ...out.sampled, note: 'a sample of the training set, not the whole of it — the node probes at most 8 questions per call' } } : {}),
  items: out.facts.map((f) => ({
    question: rows[f.index]?.prompt ?? `#${f.index}`,
    expected: rows[f.index]?.answer ?? null,
    status: f.status,
    model_said: f.base_answer ?? null,
    detail: f.detail ?? null,
    meaning: {
      will_train: 'the model gets this wrong today — teaching it is worth a lesson',
      already_known: 'the model already answers this correctly; training it would spend a lesson on nothing',
      overlaps_listing: 'this exact question and answer is already sold on this node',
      invalid: 'the question or answer breaks the node\'s rules (length, blocked topic, multi-line answer)',
      in_base: 'the knowledge you are building on already answers this',
      base_conflict: 'the knowledge you are building on answers this differently',
    }[f.status] ?? f.status,
  })),
  // The node returns its DAILY LESSON counters here, not live-test units (`teach.quota()`), so the field is named
  // for what it is. The units the preflight itself spends are the live-test bucket, charged to both the IP and the
  // key, and the node does not report what is left of it.
  lessons_left_today: { key: out.quota.key_remaining, address: out.quota.ip_remaining },
  cost_note: 'this preflight spent free live-test units (one per three model calls, at least one), charged to this server\'s IP AND to the teaching key',
});

/** The questions the node actually probed, so a preflight verdict is shown next to its own question. */
export async function datasetRows(ctx: Context, datasetId: string, offset: number, limit: number): Promise<TeachRow[]> {
  if (limit <= 0) return [];
  const out = await ctx.client.request<{ items: { prompt?: string; answer?: string; status: string }[] }>(
    `/api/teach/datasets/${encodeURIComponent(datasetId)}/rows?offset=${offset}&limit=${Math.min(200, Math.max(1, limit))}&status=ok`,
    { auth: 'teach' },
  ).catch(() => ({ items: [] as { prompt?: string; answer?: string }[] }));
  return out.items.map((r) => ({ prompt: r.prompt ?? '', answer: r.answer ?? '' }));
}

/**
 * The session's own lesson allowance, which is server configuration and cannot be raised by an argument (design
 * §6.7). Thrown before anything is uploaded, so a refusal is free.
 */
export function assertLessonAllowance(ctx: Context): void {
  if (ctx.cfg.budget.teachJobs - ctx.lessonsSpent > 0) return;
  throw fail('teach_quota_consumed', `this MCP server is configured to spend at most ${ctx.cfg.budget.teachJobs} lesson(s) per session and has spent ${ctx.lessonsSpent}. Raise AINIZE_MCP_MAX_TEACH_JOBS in the server's own configuration — no tool argument can raise it.`, { details: { session_cap: ctx.cfg.budget.teachJobs, spent: ctx.lessonsSpent } });
}

/**
 * Hold one of the session's lessons. Reserved BEFORE the upload — a second `teach` in the same turn must not slip
 * past the cap while the first one is still uploading — and refunded only where the node queued nothing.
 */
export function reserveLesson(ctx: Context): { refund: () => void } {
  assertLessonAllowance(ctx);
  ctx.lessonsSpent += 1;
  let released = false;
  return {
    refund: () => {
      if (released) return;
      released = true;
      ctx.lessonsSpent = Math.max(0, ctx.lessonsSpent - 1);
    },
  };
}

export interface TeachLessonInput {
  /** The questions to teach. Either these or `dataset_id`, never both. */
  rows?: TeachRow[];
  dataset_id?: string;
  /** Recorded as a parent for good, shares every sale, and a buyer must hold it too. */
  base?: string[];
  /** Loaded for the lesson only, recorded nowhere. De-duped against `base` here. */
  compare_with?: string[];
  mode?: 'scratch' | 'extend' | 'fork' | 'merge';
  inherit?: boolean;
  export?: 'delta' | 'squash';
  force?: boolean;
  effort?: 'quick' | 'balanced' | 'thorough';
  rows_limit?: number;
  name?: string;
  credit_name?: string;
  retention?: 'keep' | 'delete_after_training';
  provenance?: Record<string, unknown>;
  /** Not recommended: it is how a lesson gets spent on nothing. */
  skip_preflight?: boolean;
  /** What the caller already measured of the key's day, quoted in the `nothing_to_train` refusal. */
  lessons?: LessonsToday;
}

export interface TeachLessonHooks {
  signal: AbortSignal;
  /**
   * The node's own handle for this lesson and the state it is in — fired once the node accepts the submission and
   * again on every status the poll loop reads. The MCP server writes both into its job table; a caller that has no
   * job table (the agent) uses it to record the lesson id before the training run finishes.
   */
  onState?: (ev: { teach_job_id: string; status: string }) => void;
}

export type TeachLessonResult = ReturnType<typeof teachJobView> & {
  preflight?: ReturnType<typeof preflightView>;
  training_set_upload?: Record<string, unknown>;
  quota: Record<string, number>;
};

/** `compare_with` minus anything already named as a base — a base is loaded anyway, and is recorded as a parent. */
export const resolveCompare = (base: string[] | undefined, compareWith: string[] | undefined): string[] =>
  [...new Set(compareWith ?? [])].filter((id) => !(base ?? []).includes(id));

/**
 * Upload → preflight → submit → poll. Returns the finished lesson as `teachJobView` renders it; throws a
 * `ToolFailure` for the three outcomes a caller must not paper over (`dataset_empty`, `nothing_to_train`, and a
 * lesson that ended FAILED/REJECTED/EXPIRED after the node had already charged for it).
 */
export async function runTeachLesson(ctx: Context, input: TeachLessonInput, hooks: TeachLessonHooks): Promise<TeachLessonResult> {
  const { signal, onState } = hooks;
  const compare = resolveCompare(input.base, input.compare_with);
  const rows = (input.rows ?? []).map((r) => ({ prompt: r.prompt, answer: r.answer, ...(r.alt_prompt ? { alt_prompt: r.alt_prompt } : {}), ...(r.note ? { note: r.note } : {}) }));
  const lessons = input.lessons;
  // Reserved here, before the first await: a second `teach` in the same turn must not slip past the session cap.
  const reservation = reserveLesson(ctx);

  // 1) rows in → a training set (the chat basket and an uploaded file are the same artifact from here on)
  let datasetId = input.dataset_id;
  let upload: Record<string, unknown> | null = null;
  if (!datasetId) {
    upload = await uploadTrainingSet(ctx, { rows, ...(input.name ? { name: input.name } : {}), ...(input.retention ? { retention: input.retention } : {}), ...(input.provenance ? { provenance: input.provenance } : {}) });
    datasetId = String(upload.dataset_id);
    if (Number(upload.rows_accepted) === 0) {
      throw fail('dataset_empty', `none of the ${rows.length} row(s) survived the node's parser, so there is nothing to teach — see rows_rejected.`, { details: { upload } });
    }
  }

  // 2) preflight: what does the model (and the base) already answer? A lesson that trains nothing is a
  //    lesson wasted, and the node does not give it back.
  let preflight: ReturnType<typeof preflightView> | null = null;
  let known: { index: number; base_answer: string }[] = [];
  if (!input.skip_preflight) {
    const patchIds = [...new Set([...(input.base ?? []), ...compare])];
    const out = await ctx.client.request<PreflightAnswer>('/api/teach/preflight', {
      method: 'POST', auth: 'teach', signal, timeoutMs: 6 * 60_000,
      body: { patch_ids: patchIds, dataset_id: datasetId, offset: 0, limit: PREFLIGHT_MAX },
    }).catch((e) => {
      // a preflight that cannot run (model busy, quota out) must not silently become "train everything"
      throw e;
    });
    const probed = await datasetRows(ctx, datasetId, 0, out.facts.length);
    preflight = preflightView(probed, out);
    known = out.facts.filter((f) => f.status === 'already_known' && f.base_answer).map((f) => ({ index: f.index, base_answer: f.base_answer as string }));
    if (out.trainable === 0) {
      reservation.refund();   // nothing was submitted, nothing was spent
      throw fail('nothing_to_train', `every question probed is already answered correctly (or is already sold on this node), so submitting would burn one of this key's ${lessons?.limit ?? 'daily'} lessons to train nothing. The per-question verdicts are in details.`, { details: { preflight, dataset_id: datasetId, ...(upload ? { upload } : {}) } });
    }
  }

  // 3) submit. `base_ids` / `context_ids`, never the deprecated `builds_on_context`.
  //
  // A submission the node REFUSES costs nothing — no lesson is queued, no daily lesson is charged — so
  // the session's own reservation has to come back, exactly as it does for `nothing_to_train`. Without
  // this, a server capped at one lesson lost its only allowance to a `quota_key` refusal, and every
  // later attempt in that session was told the cap was spent when nothing had been.
  const created = await ctx.client.raw<{ job: TeachJobRaw; quota: Record<string, number> }>('/api/teach/jobs', {
    method: 'POST', auth: 'teach', signal, timeoutMs: 60_000,
    body: {
      dataset_id: datasetId,
      ...(input.base?.length ? { base_ids: input.base } : {}),
      ...(compare.length ? { context_ids: compare } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.inherit !== undefined ? { inherit: input.inherit } : {}),
      ...(input.export ? { export: input.export } : {}),
      ...(input.force !== undefined ? { force: input.force } : {}),
      ...(known.length ? { known } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.credit_name ? { contributor: { name: input.credit_name } } : {}),
      training: { effort: input.effort ?? 'balanced', ...(input.rows_limit ? { rows_limit: input.rows_limit } : {}) },
    },
  }).catch((err: unknown) => {
    reservation.refund();   // the node never queued it: nothing was spent
    throw err;
  });
  const nodeJob = created.body.job;
  onState?.({ teach_job_id: nodeJob.id, status: nodeJob.status });

  // 4) poll the node's own state machine until it stops moving
  let last = nodeJob;
  while (!TEACH_TERMINAL.includes(last.status)) {
    if (signal.aborted) break;
    // NOT unref'd: a lesson in flight is work this process owes the caller, and a server whose only
    // pending work is a running lesson must not let the event loop drain out from under it.
    await new Promise((r) => setTimeout(r, ctx.cfg.pollMs));
    if (signal.aborted) break;
    const cur = await ctx.client.request<{ job: TeachJobRaw }>(`/api/teach/jobs/${encodeURIComponent(nodeJob.id)}`, { auth: 'teach', signal }).catch(() => null);
    if (!cur?.job) continue;
    last = cur.job;
    onState?.({ teach_job_id: nodeJob.id, status: last.status });
  }
  const view = {
    ...teachJobView(last, { canPublish: ctx.cfg.allow.publish && ctx.client.hasTeachKey, nodeUrl: ctx.client.url }),
    ...(preflight ? { preflight } : {}),
    ...(upload ? { training_set_upload: upload } : {}),
    quota: created.body.quota,
  };
  // A lesson that failed still cost one of the day's lessons: the node charges at submit, before it runs.
  // Say so, and never retry by ourselves — spending another one is the human's decision.
  if (['FAILED', 'REJECTED', 'EXPIRED'].includes(last.status)) {
    throw fail('teach_quota_consumed', `the lesson ended ${last.status}: ${last.error ?? last.reject_reason ?? 'no reason recorded'}. It still spent one of this key's daily lessons — the node charges at submit time and does not refund. Do not retry automatically; decide with the human whether to spend another.`, { details: view });
  }
  return view;
}
