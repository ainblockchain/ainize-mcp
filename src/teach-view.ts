/**
 * Reading a lesson back (design §4.2 `teach`).
 *
 * The node runs a 13-state machine and answers with everything it measured; this file turns that into the two
 * sentences a teacher actually asked for — **what it learned, and what it did not** — without losing a number.
 *
 * Rules kept here because they are easy to get wrong:
 *  - the node's own vocabulary survives (`native_state` is the real `TeachStatus`), so nothing is lost in translation;
 *  - `eta_s: null` is rendered as "no measured estimate yet", never as 0 — three 3-second stub jobs must never
 *    become an estimate (design §7.5);
 *  - a `simulated` check is labelled as simulated. On a stub node the numbers are made up by construction, and a
 *    result that reads like a live-model verification would be a lie;
 *  - the questions dropped BEFORE training (already known, or already sold here) are reported, or a 40-question
 *    dataset silently becomes a 16-question lesson.
 */
import { etaNote } from './format.js';

export type TeachStatus =
  | 'QUEUED' | 'PREFLIGHT' | 'LOADING' | 'TRAINING' | 'EXPORTED' | 'CHECKING'
  | 'READY' | 'NEEDS_MORE' | 'FAILED' | 'CANCELLED' | 'PENDING_REVIEW' | 'REJECTED' | 'ANNOUNCED' | 'EXPIRED';

export interface TeachFactRaw {
  prompt: string; answer: string; alt_prompt?: string;
  base_answer?: string; after_answer?: string; hit?: boolean; heldout_hit?: boolean;
}

export interface TeachJobRaw {
  id: string;
  status: TeachStatus;
  name?: string;
  facts: TeachFactRaw[];
  position?: number;
  eta_s?: number | null;
  blocked?: string | null;
  progress?: { step: number; max_steps: number; hits: number; total: number; elapsed_s?: number; phase?: string; percent?: number };
  checks?: {
    executed: boolean; ok: boolean; simulated?: boolean; skipped?: true; note?: string;
    taught: { hits: number; total: number; sampled?: { checked: number; of: number } };
    heldout: { hits: number; total: number };
    parent_regression: { ok: boolean; hit: number; total: number };
    locality: { ok: boolean; same: number; total: number; unstable?: number };
    parent_check?: { patch_id: string; hit: number; total: number; failed: number[]; simulated?: boolean }[];
    reversibility_ok?: boolean | null;
  };
  result?: { sha256: string; rows: number; size_bytes: number };
  draft_id?: string;
  patch_id?: string;
  publish_status?: string;
  reject_reason?: string;
  error?: string;
  dataset?: Record<string, unknown>;
  preflight?: { checked: number; of: number; known: number; overlaps?: number };
  training?: Record<string, unknown>;
  bases?: { patch_id: string; sha256: string; name?: string; status?: string }[];
  mode?: string;
  export?: string;
  derivation?: Record<string, unknown>;
  context_patch_ids?: string[];
  created_at: number; updated_at: number; started_at?: number; finished_at?: number;
}

/** Which of our four job states a node lesson is in. The node's own word is always reported alongside. */
export function teachState(status: TeachStatus): 'queued' | 'running' | 'done' | 'failed' | 'cancelled' {
  if (status === 'QUEUED') return 'queued';
  if (['PREFLIGHT', 'LOADING', 'TRAINING', 'EXPORTED', 'CHECKING'].includes(status)) return 'running';
  if (['READY', 'NEEDS_MORE', 'PENDING_REVIEW', 'ANNOUNCED'].includes(status)) return 'done';
  if (status === 'CANCELLED') return 'cancelled';
  return 'failed';   // FAILED, REJECTED, EXPIRED
}

const WHY_BLOCKED: Record<string, string> = {
  lock: 'another process holds the shared model — the lesson is waiting for it, not stuck',
  slot: 'the trainer is busy with another job (or the GPU has too little free memory)',
  runtime: 'the model server is down, so the lesson cannot be checked yet',
  container: 'the training container is not running on this node',
};

/** One sentence for where the lesson is right now, in the words a person would use. */
export function teachSentence(j: TeachJobRaw): string {
  const p = j.progress;
  switch (j.status) {
    case 'QUEUED': return j.blocked ? `waiting: ${WHY_BLOCKED[j.blocked] ?? j.blocked}` : `queued${j.position ? `, ${j.position} lesson(s) ahead` : ' and next in line'}`;
    case 'PREFLIGHT': return 'asking the model each question first, to see what it already knows';
    case 'LOADING': return 'loading the model and the base stack';
    case 'TRAINING': return p ? `training: step ${p.step} of ${p.max_steps}, ${p.hits} of ${p.total} questions answered right so far` : 'training';
    case 'EXPORTED': return 'trained — writing the knowledge file';
    case 'CHECKING': return 'checking the lesson in the live model (and what it broke, if anything)';
    case 'READY': return 'ready: the lesson stuck and passed its checks';
    case 'NEEDS_MORE': return 'the lesson did not stick well enough to publish — the numbers below say which questions failed';
    case 'FAILED': return `failed: ${j.error ?? 'no reason recorded'}`;
    case 'CANCELLED': return 'cancelled';
    case 'PENDING_REVIEW': return 'published for review — this node reviews lessons before they are announced';
    case 'REJECTED': return `rejected by the node operator: ${j.reject_reason ?? 'no reason recorded'}`;
    case 'ANNOUNCED': return 'announced on the ledger — it is knowledge on the network now';
    case 'EXPIRED': return 'expired: the draft was not published inside this node\'s draft window';
    default: return String(j.status);
  }
}

/** What it learned and what it did not — the answer a teacher wanted, with every question named. */
export function learnedSplit(j: TeachJobRaw) {
  const measured = j.facts.filter((f) => f.hit !== undefined);
  const learned = measured.filter((f) => f.hit === true);
  const missed = measured.filter((f) => f.hit === false);
  return {
    measured: measured.length,
    learned: learned.length,
    not_learned: missed.length,
    /** Only the ones that failed are listed in full: those are the ones a teacher has to do something about. */
    still_wrong: missed.slice(0, 20).map((f) => ({
      question: f.prompt, expected: f.answer,
      model_said: f.after_answer ?? null,
      said_before: f.base_answer ?? null,
      alt_phrasing_ok: f.heldout_hit ?? null,
    })),
    taught: learned.slice(0, 20).map((f) => ({ question: f.prompt, answer: f.answer, alt_phrasing_ok: f.heldout_hit ?? null })),
    ...(missed.length > 20 ? { note: `${missed.length - 20} more failed question(s) not listed` } : {}),
  };
}

/** The checks, with the two that gate a publish called out and a stub node labelled as one. */
export function checksView(j: TeachJobRaw) {
  const c = j.checks;
  if (!c) return null;
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null);
  return {
    executed: c.executed,
    ok: c.ok,
    simulated: !!c.simulated,
    skipped: !!c.skipped,
    taught: { hits: c.taught.hits, of: c.taught.total, percent: pct(c.taught.hits, c.taught.total), ...(c.taught.sampled ? { sampled: c.taught.sampled } : {}) },
    other_phrasing: { hits: c.heldout.hits, of: c.heldout.total, percent: pct(c.heldout.hits, c.heldout.total) },
    did_not_break_the_base: { ok: c.parent_regression.ok, hits: c.parent_regression.hit, of: c.parent_regression.total },
    did_not_change_unrelated_answers: { ok: c.locality.ok, same: c.locality.same, of: c.locality.total, ...(c.locality.unstable ? { dropped_as_unstable: c.locality.unstable } : {}) },
    ...(c.parent_check ? { per_base: c.parent_check } : {}),
    reversible: c.reversibility_ok ?? null,
    publish_gate: c.executed && c.ok ? 'open' : 'shut',
    note: c.simulated
      ? 'this node trains with the STUB backend: these numbers were simulated, nothing was measured in a live model'
      : c.note ?? (c.executed ? null : 'the model server was unavailable for the whole grace period, so nothing was measured — run a re-check before publishing'),
  };
}

export interface TeachViewOptions {
  /** Whether `publish` is registered on this server, so `next_steps` does not name a tool the agent cannot call. */
  canPublish: boolean;
  nodeUrl: string;
}

/** The whole lesson, as `job_status` returns it. */
export function teachJobView(j: TeachJobRaw, opts: TeachViewOptions) {
  const state = teachState(j.status);
  const done = state === 'done';
  const next: string[] = [];
  if (j.draft_id && done) next.push(`live_test with knowledge: ["${j.draft_id}"] — prove the new answer against the bare model before telling anyone it works`);
  if (j.status === 'READY') next.push('download_lesson — take the knowledge file, the recipe and the run-it-yourself notes; the draft stays private until you publish it');
  if (j.status === 'READY' && opts.canPublish) next.push('publish_knowledge — irreversible: it writes a record on the ledger and offers the knowledge for sale');
  if (j.status === 'NEEDS_MORE') next.push('the lesson trained but did not stick: teach it again with fewer, sharper questions, or with effort: "thorough"');
  return {
    node_job_id: j.id,
    native_state: j.status,
    state,
    what_is_happening: teachSentence(j),
    name: j.name ?? null,
    blocked: j.blocked ?? null,
    position: j.position ?? null,
    eta_s: j.eta_s ?? null,
    eta_note: etaNote(j.eta_s ?? null),
    progress: j.progress ?? null,
    questions: {
      in_the_lesson: j.facts.length,
      ...(j.preflight
        ? {
            dropped_before_training: {
              already_known: j.preflight.known,
              already_sold_here: j.preflight.overlaps ?? 0,
              checked: j.preflight.checked,
              of: j.preflight.of,
              note: 'the node asked the model these questions first and dropped the ones it already answered correctly',
            },
          }
        : {}),
      ...(done || j.facts.some((f) => f.hit !== undefined) ? learnedSplit(j) : {}),
    },
    checks: checksView(j),
    training_set: j.dataset ?? null,
    built_on: (j.bases ?? []).map((b) => ({ id: b.patch_id, name: b.name ?? null, status: b.status ?? null })),
    mode: j.mode ?? null,
    export: j.export ?? null,
    loaded_for_comparison: j.context_patch_ids ?? [],
    knowledge_file: j.result ? { sha256: j.result.sha256, rows: j.result.rows, size_bytes: j.result.size_bytes } : null,
    draft_id: j.draft_id ?? null,
    patch_id: j.patch_id ?? null,
    publish_status: j.publish_status ?? 'none',
    error: j.error ?? null,
    created_at: j.created_at,
    finished_at: j.finished_at ?? null,
    next_steps: next,
  };
}

/** Terminal states — nothing more will happen without another call. */
export const TEACH_TERMINAL: TeachStatus[] = ['READY', 'NEEDS_MORE', 'FAILED', 'CANCELLED', 'PENDING_REVIEW', 'REJECTED', 'ANNOUNCED', 'EXPIRED'];
