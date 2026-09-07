/**
 * The teach tier (design §4.2) — turning questions and answers into knowledge, optionally on top of an existing
 * knowledge, and reading back what the model actually learned.
 *
 * Four things here are not decoration:
 *
 *  1. **A daily lesson is scarce and non-refundable.** The node charges one of `jobs_per_key_per_day` at SUBMIT
 *     time, before PREFLIGHT, and a job that fails on a busy GPU is not refunded. So `teach` preflights first and
 *     refuses with `nothing_to_train` when every probed question is already answered correctly, asks for `confirm`
 *     when this would be the key's last lesson today, and never auto-retries a failure.
 *  2. **`base` is not `compare_with`.** `base` is what the lesson is trained ON TOP OF: it is recorded as a parent
 *     for good, it shares every sale, and a buyer must hold it. `compare_with` is loaded for the comparison only and
 *     is recorded nowhere. The node has taken `base_ids` / `context_ids` since lineage L1; the deprecated
 *     `builds_on_context` is never sent.
 *  3. **Nothing blocks.** A preflight is one model call per question under the shared runtime lock, and a training
 *     run has a 30-minute trainer timeout. Both are job handles, polled through `job_status`.
 *  4. **Publishing is irreversible.** It is off unless the operator turned it on, refused outright on a node whose
 *     ledger is the shared AIN chain, and gated behind a confirmation phrase that contains the lesson id — so a
 *     model cannot approve it by pattern-matching "yes".
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { signMessage } from '@ngram/core';
import { z } from 'zod';
import type { Context } from '../context.js';
import { fail, UpstreamError } from '../errors.js';
import { modelLock, type NodeLock, type RawEntry } from '../format.js';
import { canonicalJsonl, rowsSha256, sealProvenance, type TeachRow } from '../rows.js';
import type { TeachJobRaw } from '../teach-view.js';
// The lesson itself — upload → preflight → submit → poll, and the session's lesson allowance — lives in
// `teach-run.ts`, so `packages/agent` runs THIS pipeline instead of a second copy of it. What stays here is what
// is specific to being a tool: the schemas, the gates a human has to see, and the job handle.
import {
  assertLessonAllowance, datasetRows, lessonsToday, preflightView, PREFLIGHT_MAX, resolveCompare, runTeachLesson,
  uploadTrainingSet, type PreflightAnswer, type TeachPolicy,
} from '../teach-run.js';
import { tool, type ToolDef } from './types.js';

// The node's own caps (`packages/node/src/teach.ts`: PROMPT_MAX, ANSWER_MAX; the dataset note cap is 500).
const PROMPT_MAX = 400;
const ANSWER_MAX = 200;

const rowSchema = z.object({
  prompt: z.string().min(1).max(PROMPT_MAX).describe('the question, as a person would ask it'),
  answer: z.string().min(1).max(ANSWER_MAX).describe('the correct answer, one line'),
  alt_prompt: z.string().max(PROMPT_MAX).optional().describe('a second phrasing of the same question — the node checks it separately, so it measures whether the fact generalised'),
  note: z.string().max(500).optional().describe('where the fact came from; published with the training set only if the teacher chooses to include notes'),
});

const provenanceSchema = z.record(z.string(), z.unknown()).optional()
  .describe('where these rows came from, as produced by the MCP client side (server, tool, arguments, block, row hashes). Recorded as declared by the caller — this server cannot verify a claim it did not make itself.');

/** What a base actually is, before anything is spent on it. Free reads. */
async function describeBases(ctx: Context, ids: string[]): Promise<{ id: string; name: string | null; status: string | null; price: string | null; body_held: boolean | null; training_set: string | null; problem: string | null }[]> {
  const out = [];
  for (const id of ids) {
    try {
      // a base is very often this key's own private draft, which is 404 to an anonymous read
      const e = await ctx.client.request<RawEntry & { has_body?: boolean; anchor: { dataset?: { access?: string } } }>(`/api/patches/${encodeURIComponent(id)}`, { auth: 'caller' });
      const status = e.status;
      const problem = ['REJECTED', 'CHALLENGED'].includes(status)
        ? `this knowledge is ${status} — the node refuses it as a base`
        : status === 'SUPERSEDED' ? 'this knowledge has been superseded; the node refuses it as a base unless force: true' : null;
      out.push({
        id, name: e.anchor.name, status, price: e.anchor.price ?? null,
        body_held: e.has_body ?? null,
        training_set: e.anchor.dataset?.access ?? null,
        problem,
      });
    } catch (err) {
      out.push({ id, name: null, status: null, price: null, body_held: null, training_set: null, problem: err instanceof UpstreamError && err.status === 404 ? 'no such knowledge on this node (a private draft is invisible to anyone but its owner)' : String((err as Error).message).slice(0, 200) });
    }
  }
  return out;
}

export function teachTools(ctx: Context): ToolDef[] {
  const tools: ToolDef[] = [];
  const caps = ctx.capabilities();

  // ---------------------------------------------------------------- create_training_set
  if (caps.can_teach) {
    tools.push(tool<{ rows: TeachRow[]; name?: string; retention?: 'keep' | 'delete_after_training'; provenance?: Record<string, unknown> }>({
      name: 'create_training_set',
      title: 'Create a training set',
      tier: 'MODEL',
      description: 'Upload questions and answers as a training set on this node, without training anything. Free and sub-second; it spends none of the daily lessons. Use it to review rows before spending a lesson on them, and as the landing place for rows pulled out of another MCP server (pass the provenance you collected and it is recorded on the rows). Identical bytes land on the SAME training set instead of making a second copy.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        rows: z.array(rowSchema).min(1).max(2000).describe('the questions and their correct answers'),
        name: z.string().max(80).optional(),
        retention: z.enum(['keep', 'delete_after_training']).optional().describe('"delete_after_training" removes the uploaded questions from the node once a lesson has used them'),
        provenance: provenanceSchema,
      },
      handler: async (a) => uploadTrainingSet(ctx, { rows: a.rows, ...(a.name ? { name: a.name } : {}), ...(a.retention ? { retention: a.retention } : {}), ...(a.provenance ? { provenance: a.provenance } : {}) }),
    }));

    // ---------------------------------------------------------------- teach_preflight
    tools.push(tool<{ rows?: TeachRow[]; dataset_id?: string; offset?: number; limit?: number; base?: string[]; compare_with?: string[] }>({
      name: 'teach_preflight',
      title: 'Preflight: would this actually teach anything?',
      tier: 'MODEL',
      description: 'Ask the model each question BEFORE spending a lesson on it, and get back, per question: will_train (it is wrong today), already_known (it is not), overlaps_listing (already sold here) or invalid. Free of money but it spends free live-test units and takes the shared model lock, so it comes back as a job handle — poll job_status. Run this before teach; a lesson is scarce and is not refunded if it trains nothing.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        rows: z.array(rowSchema).min(1).max(PREFLIGHT_MAX).optional().describe(`up to ${PREFLIGHT_MAX} questions to probe`),
        dataset_id: z.string().min(1).max(64).optional().describe('probe an existing training set instead (from create_training_set or my_library)'),
        offset: z.number().int().min(0).max(2000).optional().describe('where to start in the training set'),
        limit: z.number().int().min(1).max(PREFLIGHT_MAX).optional(),
        base: z.array(z.string().min(1).max(128)).max(2).optional().describe('the knowledge you would build ON TOP OF: loaded first, so "already_known" means the base already answers it'),
        compare_with: z.array(z.string().min(1).max(128)).max(3).optional().describe('knowledge loaded for the comparison only'),
      },
      handler: async (a) => {
        if (!a.rows?.length === !a.dataset_id) throw fail('invalid_request', 'send either `rows` (up to 8 questions) or a `dataset_id`, not both and not neither.');
        const patchIds = [...new Set([...(a.base ?? []), ...(a.compare_with ?? [])])];
        if (patchIds.length > 3) throw fail('invalid_request', 'the node loads at most 3 knowledges at once — base and compare_with together must be 3 or fewer.');
        const state = await ctx.client.request<{ lock: NodeLock | null; now: number; queue?: { running?: unknown; waiting?: number } }>('/api/chat/patches');
        const rows = a.rows ?? [];
        const job = ctx.jobs.start({
          kind: 'preflight',
          summary: `preflight ${a.dataset_id ?? `${rows.length} question(s)`}`,
          run: async (signal) => {
            const body = a.dataset_id
              ? { patch_ids: patchIds, dataset_id: a.dataset_id, ...(a.offset !== undefined ? { offset: a.offset } : {}), ...(a.limit !== undefined ? { limit: a.limit } : {}) }
              : { patch_ids: patchIds, facts: rows.map((r) => ({ prompt: r.prompt, answer: r.answer, ...(r.alt_prompt ? { alt_prompt: r.alt_prompt } : {}) })) };
            const out = await ctx.client.request<PreflightAnswer>('/api/teach/preflight', { method: 'POST', auth: 'teach', body, signal, timeoutMs: 6 * 60_000 });
            // a dataset probe answers about rows this side never saw, so the questions come back from the node's slice
            const probed = a.dataset_id ? await datasetRows(ctx, a.dataset_id, a.offset ?? 0, out.facts.length) : rows;
            return preflightView(probed, out);
          },
        });
        return {
          job_id: job.id, kind: 'preflight', state: job.state, poll_after_ms: 2000,
          model_lock: modelLock(state.lock, state.queue, state.now),
          cost: 'free of money; it spends at least one of the 20 free live-test units per hour, charged to this server\'s IP and to the teaching key',
          next: 'call job_status with this job_id',
        };
      },
    }));

    // ---------------------------------------------------------------- teach
    tools.push(tool<{
      rows?: TeachRow[]; dataset_id?: string; base?: string[]; compare_with?: string[];
      mode?: 'scratch' | 'extend' | 'fork' | 'merge'; inherit?: boolean; export?: 'delta' | 'squash'; force?: boolean;
      effort?: 'quick' | 'balanced' | 'thorough'; rows_limit?: number; name?: string; credit_name?: string;
      retention?: 'keep' | 'delete_after_training'; provenance?: Record<string, unknown>;
      confirm?: boolean; dry_run?: boolean; skip_preflight?: boolean;
    }>({
      name: 'teach',
      title: 'Teach the model something, permanently',
      tier: 'MODEL',
      description: 'Train the questions and answers you give into the serving model as a new knowledge — optionally ON TOP OF an existing knowledge (base), which is then recorded as its parent for good and shares every sale. Free of money, but it spends one of this teaching key\'s daily lessons AT SUBMIT TIME and a failed lesson is NOT refunded, so it preflights first and refuses when the model already knows the answers. Returns a job handle in milliseconds; training takes minutes. Poll job_status. Use dry_run: true to see exactly what would be sent, and what it would cost, without spending anything.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        rows: z.array(rowSchema).min(1).max(200).optional().describe('the questions and answers to teach (a training set is created from them)'),
        dataset_id: z.string().min(1).max(64).optional().describe('teach an existing training set instead (from create_training_set or my_library)'),
        base: z.array(z.string().min(1).max(128)).max(2).optional().describe('the knowledge this is built ON TOP OF — recorded as a parent for good, shares every sale, and a buyer must hold it too. One id today; two would be a merge, which no node supports yet.'),
        compare_with: z.array(z.string().min(1).max(128)).max(3).optional().describe('knowledge loaded during the lesson for comparison only — NOT recorded as a parent'),
        mode: z.enum(['scratch', 'extend', 'fork', 'merge']).optional().describe('"extend" needs a base; "merge" is not available on any node yet and the node will say so'),
        inherit: z.boolean().optional().describe('start from the base\'s own training set as the keep-set (default true)'),
        export: z.enum(['delta', 'squash']).optional().describe('"delta" (default) writes only what this lesson adds and needs the base loaded; "squash" writes a stand-alone knowledge'),
        force: z.boolean().optional().describe('build on a base that has been superseded anyway'),
        effort: z.enum(['quick', 'balanced', 'thorough']).optional().describe('how many training passes (default balanced)'),
        rows_limit: z.number().int().min(1).max(2000).optional().describe('teach only the first N questions of the training set'),
        name: z.string().max(80).optional(),
        credit_name: z.string().max(40).optional().describe('the display name to credit on the published knowledge'),
        retention: z.enum(['keep', 'delete_after_training']).optional(),
        provenance: provenanceSchema,
        confirm: z.boolean().optional().describe('required when this is the last lesson this key has today'),
        dry_run: z.boolean().optional().describe('resolve everything and report what would happen, spending nothing at all'),
        skip_preflight: z.boolean().optional().describe('do not ask the model what it already knows first (not recommended: it is how a lesson gets spent on nothing)'),
      },
      handler: async (a) => {
        if (!a.rows?.length === !a.dataset_id) throw fail('invalid_request', 'send either `rows` (the questions to teach) or a `dataset_id`, not both and not neither.');
        if ((a.base?.length ?? 0) === 2) throw fail('merge_not_available', 'combining two knowledges is a merge, and no node supports it yet — build on one of them.');
        if (a.mode === 'extend' && !a.base?.length) throw fail('invalid_request', 'mode "extend" is what "build on top of" means — pass `base` with the knowledge you are extending.');
        const compare = resolveCompare(a.base, a.compare_with);
        if ([...new Set([...(a.base ?? []), ...compare])].length > 3) throw fail('invalid_request', 'the node loads at most 3 knowledges at once.');

        const bases = await describeBases(ctx, a.base ?? []);
        const blocked = bases.find((b) => b.problem && !(a.force && b.status === 'SUPERSEDED'));
        if (blocked) throw fail(blocked.status === 'SUPERSEDED' ? 'base_retired' : 'base_rejected', `${blocked.id}: ${blocked.problem}`, { details: { base: blocked } });

        const lessons = await lessonsToday(ctx);
        assertLessonAllowance(ctx);
        if (lessons.remaining !== null && lessons.remaining <= 1 && !a.confirm && !a.dry_run) {
          throw fail('confirmation_required', `this is the last lesson this teaching key has on ${ctx.client.url} today (${lessons.used_today} of ${lessons.limit} used), and a lesson that fails is not refunded. Show the human what will be taught, and pass confirm: true once they agree.`, { details: { lessons } });
        }

        const rows = (a.rows ?? []).map((r) => ({ prompt: r.prompt, answer: r.answer, ...(r.alt_prompt ? { alt_prompt: r.alt_prompt } : {}), ...(r.note ? { note: r.note } : {}) }));
        const policy = (await ctx.teachPolicy()) as TeachPolicy | null;

        if (a.dry_run) {
          return {
            dry_run: true,
            would_teach: a.dataset_id ? { dataset_id: a.dataset_id } : { rows: rows.length, predicted_sha256: rowsSha256(rows), sample: rows.slice(0, 3) },
            built_on: bases,
            loaded_for_comparison: compare,
            mode: a.mode ?? (a.base?.length ? 'extend' : 'scratch'),
            export: a.export ?? 'delta',
            inherit: a.inherit !== false,
            effort: a.effort ?? 'balanced',
            lessons: { ...lessons, session_cap: ctx.cfg.budget.teachJobs, session_spent: ctx.lessonsSpent },
            node: { trainer: policy?.trainer ?? null, backend: policy?.backend ?? null, queue: policy?.queue ?? null, lineage_enabled: policy?.lineage ?? null },
            what_it_would_cost: 'one of this key\'s daily lessons (non-refundable), plus a few free live-test units for the preflight. No money.',
            note: 'nothing was created, uploaded, probed or trained. Call teach again without dry_run to actually do it.',
          };
        }

        const state = await ctx.client.request<{ lock: NodeLock | null; now: number; queue?: { running?: unknown; waiting?: number } }>('/api/chat/patches');
        const job = ctx.jobs.start({
          kind: 'teach',
          summary: a.name ?? (a.dataset_id ? `teach ${a.dataset_id}` : `teach: ${rows[0]?.prompt.slice(0, 50) ?? ''}`),
          // One lesson, start to finish, in `teach-run.ts`. The session's lesson is reserved INSIDE it, before its
          // first await — `jobs.start` calls this synchronously — so the handle returned below already counts it,
          // exactly as it did when the reservation was a line up here.
          run: async (signal) => runTeachLesson(ctx, {
            rows,
            dataset_id: a.dataset_id,
            base: a.base,
            compare_with: compare,
            mode: a.mode,
            inherit: a.inherit,
            export: a.export,
            force: a.force,
            effort: a.effort,
            rows_limit: a.rows_limit,
            name: a.name,
            credit_name: a.credit_name,
            retention: a.retention,
            provenance: a.provenance,
            skip_preflight: a.skip_preflight,
            lessons,
          }, {
            signal,
            // The node's own lesson id and its state, written into the job table so `job_status`, `job_cancel` and
            // `download_lesson` can find a lesson that was submitted from inside a job.
            onState: ({ teach_job_id, status }) => { ctx.jobs.attach(job.id, { teach_job_id }); ctx.jobs.observe(job.id, status); },
          }),
        });

        return {
          job_id: job.id, kind: 'teach', state: job.state, poll_after_ms: 3000,
          built_on: bases,
          loaded_for_comparison: compare,
          mode: a.mode ?? (a.base?.length ? 'extend' : 'scratch'),
          export: a.export ?? 'delta',
          lessons: { ...lessons, session_cap: ctx.cfg.budget.teachJobs, session_spent: ctx.lessonsSpent },
          model_lock: modelLock(state.lock, state.queue, state.now),
          what_happens_next: a.skip_preflight
            ? 'the training set is uploaded and the lesson is submitted straight away'
            : 'the training set is uploaded, the model is asked what it already knows (that is the preflight), and the lesson is submitted only if something is left to teach',
          eta_note: 'no measured estimate yet — job_status carries the node\'s own ETA once the lesson is queued',
          next: 'call job_status with this job_id (wait_ms up to 25000 turns a poll loop into one call)',
        };
      },
    }));

    // ---------------------------------------------------------------- download_lesson
    tools.push(tool<{ lesson_id: string; include?: ('knowledge_file' | 'recipe' | 'notes')[] }>({
      name: 'download_lesson',
      title: 'Download a lesson (keep it private)',
      tier: 'MODEL',
      description: 'Take a finished lesson off the node as files: the knowledge file itself (.npz), the trainer recipe that made it, and the notes for running it against your own model. Keeping the lesson private is the default — this is how you keep it. The files are written into this server\'s own download directory and the paths are returned; the download links are short-lived credentials and never leave this server.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        lesson_id: z.string().min(1).max(64).describe('the node lesson id (node_job_id from teach / job_status), or an MCP job_id from this session'),
        include: z.array(z.enum(['knowledge_file', 'recipe', 'notes'])).max(3).optional().describe('default: all three'),
      },
      handler: async (a) => {
        const lessonId = resolveLessonId(ctx, a.lesson_id);
        const want = new Set(a.include ?? ['knowledge_file', 'recipe', 'notes']);
        const saved = await ctx.client.request<{ download: { npz_url: string; recipe_url: string; readme_url: string; expires_at: number }; sha256: string; rows: number; size_bytes: number; filename: string; repo_url: string; model_id: string | null }>(
          `/api/teach/jobs/${encodeURIComponent(lessonId)}/save`, { method: 'POST', auth: 'teach', body: {} },
        );
        const dir = join(ctx.downloadDir, lessonId);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const files: { what: string; path: string; bytes: number }[] = [];
        const grab = async (what: string, url: string, filename: string) => {
          const out = await ctx.client.download(url, join(dir, filename), { maxBytes: ctx.maxDownloadBytes });
          files.push({ what, path: out.path, bytes: out.bytes });
        };
        if (want.has('knowledge_file')) await grab('knowledge_file', saved.download.npz_url, saved.filename);
        if (want.has('recipe')) await grab('recipe', saved.download.recipe_url, 'recipe.json');
        if (want.has('notes')) await grab('notes', saved.download.readme_url, 'RUN-LOCALLY.md');
        return {
          lesson_id: lessonId,
          directory: dir,
          files,
          knowledge: { sha256: saved.sha256, rows: saved.rows, size_bytes: saved.size_bytes, filename: saved.filename, model: saved.model_id, repo: saved.repo_url },
          privacy: 'this lesson is still a private draft on the node: nothing was published, nothing was announced, and nobody else can see it.',
          note: 'the node\'s download links carry a short-lived token, which is a credential — this server used them and did not return them.',
        };
      },
    }));
  }

  // ---------------------------------------------------------------- publish_knowledge (opt-in, irreversible)
  if (ctx.cfg.allow.publish && ctx.client.hasTeachKey) {
    tools.push(tool<{
      lesson_id: string; name: string; description?: string; price?: string; license?: string;
      payout_address?: string | null;
      training_set?: { access?: 'public' | 'derivative' | 'private'; license?: string; include_notes?: boolean; source?: 'own' | 'public' | 'licensed'; no_pii?: boolean };
      consent_permanent?: boolean; consent_rights?: boolean; confirm_phrase?: string; dry_run?: boolean;
    }>({
      name: 'publish_knowledge',
      title: 'Publish a lesson (irreversible)',
      tier: 'MONEY',
      description: 'Announce a finished lesson on the ledger and offer it for sale. THIS CANNOT BE UNDONE: the record is written to the ledger and broadcast to peers. It needs both consents from the human (permanent, and that they have the right to teach these facts), a confirmation phrase containing the lesson id, and a decision about who may read the training set. Run it with dry_run: true first — that shows the real revenue split (which is NOT the 70% the web sheet prints when the knowledge has a parent) and everything that would be written, without writing anything.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        lesson_id: z.string().min(1).max(64).describe('the node lesson id (node_job_id), or an MCP job_id from this session'),
        name: z.string().min(2).max(80).describe('what the knowledge is called on the market'),
        description: z.string().max(2000).optional(),
        price: z.string().max(32).optional().describe('a non-negative number as a string; "0" gives it away'),
        license: z.string().max(80).optional(),
        payout_address: z.string().max(64).nullable().optional().describe('where the teacher\'s share is paid; null waives the share entirely'),
        training_set: z.object({
          access: z.enum(['public', 'derivative', 'private']).optional().describe('who may read the questions this was trained on: everyone, only people building on it, or nobody'),
          license: z.string().max(80).optional(),
          include_notes: z.boolean().optional().describe('publish each row\'s note as well — this is what carries provenance to a buyer'),
          source: z.enum(['own', 'public', 'licensed']).optional().describe('where the questions came from — a declaration the teacher makes, on the record'),
          no_pii: z.boolean().optional().describe('the teacher declares the training set holds no personal information'),
        }).optional(),
        consent_permanent: z.boolean().optional().describe('the human understands this cannot be recalled. Required — never assume it.'),
        consent_rights: z.boolean().optional().describe('the human has the right to publish these facts. Required — never assume it.'),
        confirm_phrase: z.string().max(200).optional().describe('exactly "publish <lesson_id> permanently"'),
        dry_run: z.boolean().optional(),
      },
      handler: async (a) => {
        const lessonId = resolveLessonId(ctx, a.lesson_id);
        const info = await ctx.nodeInfo();
        if (info.ledger === 'ain' && !ctx.cfg.allow.ainPublish) {
          throw fail('permanent_ledger_refused', `${ctx.client.url} writes to the shared AIN chain, where an announcement cannot be recalled by anyone. This server refuses to publish there. Publish on a node with its own local ledger (the project runs node-u at http://localhost:3422 for exactly this), or the operator can set AINIZE_MCP_ALLOW_AIN_PUBLISH=1 having understood what it means.`, { details: { ledger: info.ledger, node: info.name } });
        }
        const payout = a.payout_address === undefined ? undefined : a.payout_address;
        const q = payout === undefined ? '' : `?payout_address=${encodeURIComponent(payout === null ? 'none' : payout)}`;
        const challenge = await ctx.client.request<{ patch_sha256: string; benchmark_hash: string; address: string; signer: string; share: number; claim: string }>(
          `/api/teach/jobs/${encodeURIComponent(lessonId)}/publish-challenge${q}`, { auth: 'teach' },
        );
        const lesson = (await ctx.client.request<{ job: TeachJobRaw }>(`/api/teach/jobs/${encodeURIComponent(lessonId)}`, { auth: 'teach' })).job;
        const split = splitPreview({
          price: a.price ?? '0',
          currency: info.currency,
          contributorShare: challenge.share,
          lineageShare: info.royalty_share ?? 0,
          hasParents: (lesson.bases ?? []).length > 0,
        });

        if (a.dry_run) {
          return {
            dry_run: true,
            lesson: { id: lessonId, status: lesson.status, name: lesson.name ?? null, built_on: (lesson.bases ?? []).map((b) => b.patch_id) },
            would_publish: { name: a.name, price: a.price ?? '0', currency: info.currency, license: a.license ?? null, training_set: a.training_set ?? null },
            split_preview: split,
            ledger: info.ledger,
            confirm_phrase_required: `publish ${lessonId} permanently`,
            note: 'nothing was written. Show the human the split and the fact that this cannot be undone, wait for them, then call again with both consents and the confirmation phrase.',
          };
        }

        if (a.consent_permanent !== true || a.consent_rights !== true) {
          throw fail('confirmation_required', 'publishing needs both consents from the human, and neither has a default: consent_permanent (this record cannot be recalled) and consent_rights (they have the right to publish these facts).', { details: { split_preview: split } });
        }
        const expected = `publish ${lessonId} permanently`;
        if ((a.confirm_phrase ?? '').trim() !== expected) {
          throw fail('confirmation_required', `confirm_phrase must be exactly "${expected}" — a phrase carrying the lesson id, so a publish cannot be approved by pattern-matching "yes".`, { details: { split_preview: split } });
        }
        const claim_sig = signMessage(challenge.claim, ctx.cfg.teachKey!.privateKey);
        const out = await ctx.client.request<{ status: string; patch_id?: string; url?: string }>(
          `/api/teach/jobs/${encodeURIComponent(lessonId)}/publish`, {
            method: 'POST', auth: 'teach', timeoutMs: 120_000,
            body: {
              name: a.name,
              ...(a.description ? { description: a.description } : {}),
              ...(a.price !== undefined ? { price: a.price } : {}),
              ...(a.license ? { license: a.license } : {}),
              ...(payout !== undefined ? { payout_address: payout } : {}),
              claim_sig,
              consent: { permanent: true, rights: true },
              ...(a.training_set
                ? {
                    dataset: {
                      ...(a.training_set.access ? { access: a.training_set.access } : {}),
                      ...(a.training_set.license ? { license: a.training_set.license } : {}),
                      ...(a.training_set.include_notes !== undefined ? { include_notes: a.training_set.include_notes } : {}),
                      ...(a.training_set.source ? { declaration: { source: a.training_set.source, ...(a.training_set.license ? { license: a.training_set.license } : {}), no_pii: a.training_set.no_pii === true } } : {}),
                    },
                  }
                : {}),
            },
          },
        );
        return {
          status: out.status,
          patch_id: out.patch_id ?? null,
          url: out.url ?? null,
          ledger: info.ledger,
          split_preview: split,
          irreversible: out.status === 'ANNOUNCED',
          note: out.status === 'ANNOUNCED'
            ? 'announced on the ledger and broadcast to this node\'s peers. It cannot be recalled.'
            : 'this node reviews lessons before announcing them: it is queued for the operator, not on the ledger yet.',
          next: out.patch_id ? `live_test with knowledge: ["${out.patch_id}"] to show it working, and get_knowledge for its verification status` : 'poll job_status or my_library for the review outcome',
        };
      },
    }));
  }

  return tools;
}

/**
 * The real revenue split, computed the way `royaltySplit` in `packages/core/src/catalog.ts` computes it — the
 * lineage pool is carved off FIRST and only when the knowledge has an ancestor, and the teacher's share is a
 * fraction of what is left. With a 0.3 pool and a 0.7 contributor share that is 49 %, not the 70 % the publish
 * sheet prints (`docs/ux-critique-3.json` item 186). A tool that repeated the sheet's number would mislead the
 * teacher about money.
 */
export function splitPreview(input: { price: string; currency: string; contributorShare: number; lineageShare: number; hasParents: boolean }) {
  const price = Number(input.price);
  const usable = Number.isFinite(price) ? price : 0;
  const pool = input.hasParents ? usable * input.lineageShare : 0;
  const sellerSide = usable - pool;
  const teacher = sellerSide * input.contributorShare;
  const node = sellerSide - teacher;
  const fmt = (n: number) => (Math.round(n * 1e6) / 1e6).toString();
  const pct = (n: number) => (usable > 0 ? `${Math.round((n / usable) * 1000) / 10}%` : '—');
  return {
    price: input.price, currency: input.currency,
    to_the_people_it_was_built_on: { amount: fmt(pool), share: pct(pool), applies: input.hasParents, note: input.hasParents ? 'this knowledge has a parent, so the lineage pool is carved off every sale before anything else' : 'no parent, so no lineage pool' },
    to_you_the_teacher: { amount: fmt(teacher), share: pct(teacher), of_what_is_left: `${Math.round(input.contributorShare * 100)}%` },
    to_this_node: { amount: fmt(node), share: pct(node) },
    explanation: input.hasParents
      ? `${Math.round(input.contributorShare * 100)}% of the ${Math.round((1 - input.lineageShare) * 100)}% that is left after the lineage pool = ${pct(teacher)} of the price. The publish sheet's "${Math.round(input.contributorShare * 100)}%" is the share of the remainder, not of the price.`
      : `${Math.round(input.contributorShare * 100)}% of the price, because this knowledge has no parent to pay.`,
  };
}

/** Accept either an MCP job id from this session or the node's own lesson id. */
function resolveLessonId(ctx: Context, id: string): string {
  const local = ctx.jobs.get(id);
  const nodeId = local?.native.teach_job_id;
  if (local && !nodeId) {
    // A `teach` job that never reached the node has no lesson to download — usually because the node refused the
    // submission (and, mattering to the caller, charged nothing for it). Saying "it is a teach" was true and useless.
    if (local.kind === 'teach') {
      throw fail('job_not_found', `${id} never became a lesson on ${ctx.client.url}: the node did not accept the submission${local.state === 'failed' ? ` (job_status has the reason)` : ` (it is still ${local.state})`}, so there is no knowledge file to download and no daily lesson was charged.`, { details: { state: local.state, next: 'call job_status with this job_id for the node\'s own reason' } });
    }
    throw fail('job_not_found', `${id} is a ${local.kind} job, not a lesson — only a lesson from \`teach\` has a knowledge file to download.`);
  }
  return nodeId ?? id;
}

// Kept exported from here because `index.ts` and the direction-B example have always imported them from this
// module; the implementations now live one file over.
export { canonicalJsonl, sealProvenance };
export { uploadTrainingSet, type UploadInput } from '../teach-run.js';
