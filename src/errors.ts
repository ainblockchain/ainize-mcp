/**
 * The error contract (design §9).
 *
 * Two channels, deliberately. Protocol failures (a malformed request the model cannot act on) stay `McpError`s and
 * are thrown by the SDK. Everything the model SHOULD see and CAN act on — no budget left, the model is held by
 * another node, this knowledge is challenged — comes back as a normal tool result with `isError: true` and a body of
 * `{ code, message, retryable, retry_after_ms?, details }`.
 *
 * `retryable` is the field that stops an agent from paying twice: it is false for everything in the MONEY tier, and
 * the node's own sentences are passed through unrewritten (three UX reviews tuned them).
 */
export interface ToolErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  retry_after_ms?: number;
  details?: Record<string, unknown>;
}

/** Codes the MCP layer adds on top of the node's own (`quota_chat`, `base_retired`, …). */
export const MCP_ERROR_CODES = [
  'quote_required', 'quote_expired', 'quote_mismatch', 'confirmation_required', 'budget_exceeded',
  'per_purchase_cap_exceeded', 'already_purchased', 'idempotency_replay', 'payment_settled_delivery_failed',
  'nothing_to_train', 'teach_quota_consumed', 'model_busy', 'job_not_found', 'permanent_ledger_refused',
  'capability_disabled', 'node_unreachable', 'not_found', 'invalid_request', 'upstream_error',
] as const;

export class ToolFailure extends Error {
  constructor(readonly body: ToolErrorBody) { super(body.message); this.name = 'ToolFailure'; }
}

export const fail = (code: string, message: string, extra: Partial<Omit<ToolErrorBody, 'code' | 'message'>> = {}): ToolFailure =>
  new ToolFailure({ code, message, retryable: extra.retryable ?? false, ...(extra.retry_after_ms !== undefined ? { retry_after_ms: extra.retry_after_ms } : {}), ...(extra.details ? { details: extra.details } : {}) });

/** An upstream response that was not 2xx. Carries the node's status and parsed body so a tool can map it precisely. */
export class UpstreamError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>, readonly path: string) {
    super(String(body.error ?? `HTTP ${status}`));
    this.name = 'UpstreamError';
  }
}

/** A node that did not answer at all (down, wrong port, DNS, timeout) — always retryable, never a money outcome. */
export class UnreachableError extends Error {
  constructor(readonly url: string, readonly cause_message: string) {
    super(`node_unreachable: ${url} did not answer (${cause_message})`);
    this.name = 'UnreachableError';
  }
}

/** `"quota_chat: free live-test quota exhausted…"` → `['quota_chat', 'free live-test quota exhausted…']`. */
export function splitNodeCode(message: string): { code: string | null; sentence: string } {
  const m = /^([a-z][a-z0-9_]{2,40}):\s*(.+)$/s.exec(message);
  return m ? { code: m[1] as string, sentence: m[2] as string } : { code: null, sentence: message };
}

const STATUS_CODES: Record<number, string> = { 400: 'invalid_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 423: 'not_sellable', 429: 'rate_limited', 503: 'unavailable' };

/**
 * Map anything thrown by the HTTP client into the tool-error body an agent can act on.
 * The node's own code prefix wins; the status only fills in when the sentence carries no code.
 */
export function toToolError(err: unknown, now = Date.now()): ToolErrorBody {
  if (err instanceof ToolFailure) return err.body;
  if (err instanceof UnreachableError) return { code: 'node_unreachable', message: err.message, retryable: true };
  if (err instanceof UpstreamError) {
    const raw = String(err.body.error ?? `HTTP ${err.status}`);
    const { code, sentence } = splitNodeCode(raw);
    const details: Record<string, unknown> = Object.fromEntries(Object.entries(err.body).filter(([k]) => k !== 'error'));
    // "shared runtime busy (node-b: chat:krx-all-2761) — try again later" is a 503 with `busy: true`
    if (err.body.busy === true || /shared runtime busy/.test(raw)) {
      return { code: 'model_busy', message: sentence, retryable: true, retry_after_ms: 30_000, details };
    }
    if (err.status === 429) {
      const reset = Number(err.body.quota_reset ?? 0);
      const wait = reset > now ? reset - now : 60_000;
      return { code: code ?? 'rate_limited', message: sentence, retryable: true, retry_after_ms: wait, details: { ...details, ...(reset ? { resets_at: reset, resets_in_s: Math.ceil(wait / 1000) } : {}) } };
    }
    const mapped = code ?? STATUS_CODES[err.status] ?? 'upstream_error';
    return { code: mapped, message: sentence, retryable: err.status >= 500, ...(Object.keys(details).length ? { details } : {}) };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'upstream_error', message, retryable: false };
}
