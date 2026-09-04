/**
 * The job table (design §7.2).
 *
 * Nothing that touches the shared model may block a tool call. The runtime lock waits up to 20 minutes before the
 * node throws, a stacked compare has been measured at 317 s, and a buy can spend 10 minutes downloading a 300 MB
 * body — all of them past every MCP client's timeout, and each client retry would open ANOTHER queue ticket on the
 * node, deepening the very queue it is waiting on.
 *
 * So the server owns the in-flight request itself: `start()` fires the upstream call WITHOUT awaiting it and returns
 * a handle in milliseconds. `job_status` merges the local row with the node's own live status; `job_cancel` aborts
 * it and tells the caller the truth about what was charged.
 */
import { randomBytes } from 'node:crypto';

export type JobKind = 'live_test' | 'preflight' | 'teach' | 'buy' | 'apply' | 'remove';
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

const PREFIX: Record<JobKind, string> = { live_test: 'lt', preflight: 'tp', teach: 'th', buy: 'by', apply: 'ap', remove: 'rm' };

export interface Job {
  id: string;
  /** Insertion order — `started_at` alone ties when two jobs start in the same millisecond. */
  seq: number;
  kind: JobKind;
  /** The node's own handle for the same work — a chat `request_id` or a teach job id. Never translated away. */
  native: { request_id?: string; teach_job_id?: string; patch_id?: string };
  state: JobState;
  /** The node's word for the state (`queued`/`running`/`gone`, or one of the 13 TeachStatus values). */
  native_state: string;
  started_at: number;
  finished_at: number | null;
  result: unknown;
  error: unknown;
  /** A short human line for `job_list` ("픽셀플러스 종목코드는? · pixelplus-087600"). */
  summary: string;
  /** Why this session gave up, when it did — so `job_status` can say that instead of the abort's own words. */
  cancel_reason?: string;
  controller: AbortController;
}

export interface StartInput {
  kind: JobKind;
  native?: Job['native'];
  summary?: string;
  /** The upstream call. It is NOT awaited by `start`. */
  run: (signal: AbortSignal) => Promise<unknown>;
}

/** Finished jobs are evicted after this — long enough for a slow agent to come back, short enough not to leak. */
export const JOB_TTL_MS = 30 * 60_000;

export class JobTable {
  private readonly jobs = new Map<string, Job>();
  private seq = 0;
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly ttlMs = JOB_TTL_MS, private readonly now: () => number = Date.now) {}

  start(input: StartInput): Job {
    this.prune();
    const id = `${PREFIX[input.kind]}_${randomBytes(6).toString('hex')}`;
    const job: Job = {
      id, seq: ++this.seq, kind: input.kind, native: input.native ?? {}, state: 'queued', native_state: 'queued',
      started_at: this.now(), finished_at: null, result: null, error: null,
      summary: input.summary ?? input.kind, controller: new AbortController(),
    };
    this.jobs.set(id, job);
    // Fired, not awaited: the handle must be back before the upstream request has even reached the node.
    void input.run(job.controller.signal).then(
      (result) => this.finish(id, 'done', { result }),
      (error) => this.finish(id, job.controller.signal.aborted ? 'cancelled' : 'failed', { error }),
    );
    return job;
  }

  private finish(id: string, state: JobState, patch: { result?: unknown; error?: unknown }): void {
    const job = this.jobs.get(id);
    if (!job) return;
    if (job.state === 'cancelled' && state !== 'cancelled') { /* a cancel already told the truth; keep it */ }
    else job.state = state;
    job.native_state = state === 'done' ? 'done' : state;
    job.finished_at = this.now();
    if (patch.result !== undefined) job.result = patch.result;
    if (patch.error !== undefined) job.error = patch.error;
    this.wake(id);
  }

  /**
   * Record the node's own handle for work that only gets one AFTER it starts — a teach job is submitted from inside
   * the job, so `job_status` and `download_lesson` learn the lesson id here rather than guessing it.
   */
  attach(id: string, native: Partial<Job['native']>): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.native = { ...job.native, ...native };
    this.wake(id);
  }

  /** Called by a poller that learned the node's own state (`running`, `TRAINING`, …). */
  observe(id: string, nativeState: string): void {
    const job = this.jobs.get(id);
    if (!job || job.finished_at) return;
    if (job.native_state !== nativeState) { job.native_state = nativeState; this.wake(id); }
    // `running` is the chat queue's word; a lesson says PREFLIGHT / LOADING / TRAINING / EXPORTED / CHECKING. Both
    // mean the same thing to a caller: it left the queue and something is happening.
    if (nativeState !== 'queued' && nativeState.toUpperCase() !== 'QUEUED') job.state = 'running';
  }

  get(id: string): Job | null { this.prune(); return this.jobs.get(id) ?? null; }

  list(filter: { kind?: JobKind; state?: JobState; limit?: number } = {}): Job[] {
    this.prune();
    return [...this.jobs.values()]
      .filter((j) => (!filter.kind || j.kind === filter.kind) && (!filter.state || j.state === filter.state))
      .sort((a, b) => b.started_at - a.started_at || b.seq - a.seq)
      .slice(0, filter.limit ?? 20);
  }

  /** Abort the in-flight upstream call. The caller still has to tell the node (`POST /api/chat/cancel`). */
  abort(id: string, reason?: string): Job | null {
    const job = this.jobs.get(id);
    if (!job || job.finished_at) return job ?? null;
    job.state = 'cancelled';
    job.native_state = 'cancelled';
    if (reason) job.cancel_reason = reason;
    job.controller.abort();
    this.wake(id);
    return job;
  }

  /**
   * Long-poll INSIDE this server: turns a five-call poll loop into one call without ever holding a request open on
   * the node. Resolves on the next state change or when `ms` is up, whichever comes first.
   */
  async waitForChange(id: string, ms: number): Promise<void> {
    if (ms <= 0) return;
    const job = this.jobs.get(id);
    if (!job || job.finished_at) return;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.waiters.get(id)?.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      const set = this.waiters.get(id) ?? new Set();
      set.add(done);
      this.waiters.set(id, set);
    });
  }

  private wake(id: string): void {
    const set = this.waiters.get(id);
    if (!set) return;
    for (const fn of [...set]) fn();
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, job] of this.jobs) if (job.finished_at !== null && job.finished_at < cutoff) { this.jobs.delete(id); this.waiters.delete(id); }
  }

  /** Abort everything in flight (process shutdown). */
  abortAll(): void { for (const id of this.jobs.keys()) this.abort(id); }
}
