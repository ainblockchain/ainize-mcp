/**
 * The money layer (design §6): quotes, the session budget, and an idempotency journal.
 *
 * The node has no quote endpoint, no price ceiling and no returning-buyer branch: `POST /api/patches/:id/buy` takes
 * `{ apply? }` and pays whatever the 402 asks, and buying twice pays twice. Every guard therefore lives HERE — and
 * mechanically, in the tool contract, because a sentence in a skill file does not override model posture.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { echoId } from './scrub.js';
import { addAmounts, cmpAmounts, normalizeAmount, subAmounts } from './dec.js';
import { fail } from './errors.js';

/**
 * Re-exported so `@ngram/mcp/money` is the one place a caller outside this package gets money arithmetic from.
 * The agent's four daily budgets are held to the same scaled-BigInt rule as a purchase: `0.1 + 0.2` must never be
 * a budget decision, in any of the four units. Importing the package ROOT for these would drag express and the MCP
 * server into a 200 ms CLI process, which is what the subpath export exists to avoid.
 */
export { addAmounts, cmpAmounts, formatAmount, isZero, normalizeAmount, parseAmount, subAmounts, AmountError } from './dec.js';

export interface QuoteItem {
  id: string;
  name: string;
  role: 'requested' | 'base';
  price: string;
  currency: string;
  status: string;
  superseded_by: string | null;
  license: string | null;
  seller: string;
  gateway_url: string | null;
  quorum: string;
  sellable: boolean;
  already_purchased: boolean;
  /** This node is the seller — there is nothing to buy. */
  owned: boolean;
  body_held: boolean;
  /** Only on the requested item, and only when the binding 402 handshake ran (never in a dry run). */
  scheme?: string;
  pay_to?: string;
  nonce?: string;
}

export interface Quote {
  quote_id: string;
  patch_id: string;
  created_at: number;
  expires_at: number;
  dry_run: boolean;
  currency: string;
  /** What `buy` compares `confirm_total` against, by string equality. */
  total_requested: string;
  total_with_bases: string;
  items: QuoteItem[];
}

/** Quotes live 10 minutes — the same life as the seller's own x402 nonce. */
export const QUOTE_TTL_MS = 10 * 60_000;

export class QuoteBook {
  private readonly quotes = new Map<string, Quote>();
  constructor(private readonly now: () => number = Date.now) {}

  create(q: Omit<Quote, 'quote_id' | 'created_at'>): Quote {
    this.prune();
    const quote: Quote = { ...q, quote_id: `q_${randomBytes(6).toString('hex')}`, created_at: this.now() };
    this.quotes.set(quote.quote_id, quote);
    return quote;
  }

  /** Refuses in the two ways that protect money: no quote at all, or one that has aged out. */
  require(id: string | undefined): Quote {
    if (!id) throw fail('quote_required', 'buy needs a quote_id — call `quote` first, show the human the total, and pass the quote back. There is no `id` parameter on `buy`: what gets bought is whatever the quote named.');
    const q = this.quotes.get(id);
    if (!q) throw fail('quote_expired', `quote ${echoId(id)} is unknown or has already expired — quote again (a quote is good for ${QUOTE_TTL_MS / 60_000} minutes) and show the human the fresh total.`);
    if (q.expires_at <= this.now()) { this.quotes.delete(id); throw fail('quote_expired', `quote ${id} expired at ${new Date(q.expires_at).toISOString()} — prices and verification state can move, so quote again before spending.`); }
    return q;
  }

  get(id: string): Quote | null { return this.quotes.get(id) ?? null; }
  private prune(): void { const t = this.now(); for (const [k, q] of this.quotes) if (q.expires_at + QUOTE_TTL_MS < t) this.quotes.delete(k); }
}

export interface BudgetView { cap: string; spent: string; reserved: string; remaining: string; currency: string; per_purchase_cap: string }

/**
 * The session budget. Read from the server's own env and NEVER settable by a tool argument — a `max_price` argument
 * may only lower the effective ceiling for one call. Exceeding it is `budget_exceeded` with all four numbers, never
 * a silent clamp and never a partial purchase.
 */
export class Budget {
  private spent = '0';
  private reserved = '0';
  constructor(readonly cap: string, readonly perPurchase: string, private currency = 'AIN') {}

  setCurrency(c: string): void { this.currency = c; }
  get enabled(): boolean { return cmpAmounts(this.cap, '0') > 0; }
  view(): BudgetView {
    return { cap: this.cap, spent: this.spent, reserved: this.reserved, remaining: this.remaining, currency: this.currency, per_purchase_cap: this.perPurchase };
  }
  get remaining(): string { return subAmounts(subAmounts(this.cap, this.spent), this.reserved); }

  /** Check-and-hold, so two buys in flight cannot both squeeze past the same remaining budget. */
  reserve(amount: string, maxPrice?: string): { release: () => void; settle: (actual?: string) => void } {
    const want = normalizeAmount(amount, 'price');
    if (maxPrice !== undefined && cmpAmounts(want, maxPrice) > 0) {
      throw fail('per_purchase_cap_exceeded', `${want} ${this.currency} is over the max_price you set for this call (${maxPrice}).`, { details: { price: want, max_price: maxPrice } });
    }
    // The session cap is checked BEFORE the per-purchase cap: when the two are equal (the default), "you have 1 left
    // and this costs 5" is the sentence the human needs, not "the per-purchase cap is 1".
    if (cmpAmounts(want, this.remaining) > 0) {
      throw fail('budget_exceeded', `${want} ${this.currency} would take you past this session's cap of ${this.cap} (spent ${this.spent}, ${this.remaining} left).`, { details: { cap: this.cap, spent: this.spent, remaining: this.remaining, needed: want, currency: this.currency } });
    }
    if (cmpAmounts(want, this.perPurchase) > 0) {
      throw fail('per_purchase_cap_exceeded', `${want} ${this.currency} is over this server's per-purchase cap of ${this.perPurchase} (AINIZE_MCP_MAX_PER_PURCHASE). The cap is server configuration — no tool argument can raise it.`, { details: { price: want, per_purchase_cap: this.perPurchase } });
    }
    this.reserved = addAmounts(this.reserved, want);
    let closed = false;
    return {
      release: () => { if (closed) return; closed = true; this.reserved = subAmounts(this.reserved, want); },
      settle: (actual?: string) => {
        if (closed) return; closed = true;
        this.reserved = subAmounts(this.reserved, want);
        this.spent = addAmounts(this.spent, actual === undefined ? want : normalizeAmount(actual, 'amount'));
      },
    };
  }
}

export type JournalState = 'intent' | 'complete' | 'failed';

export interface JournalRow {
  key: string;
  state: JournalState;
  patch_id: string;
  quote_id: string;
  amount: string;
  currency: string;
  at: number;
  tx_hash?: string | null;
  /** The tool result of the completed purchase, replayed verbatim on an idempotent retry. */
  result?: unknown;
  error?: string;
}

/**
 * The idempotency journal (design §6.4).
 *
 * `intent` is written BEFORE the node is called, so a timeout is recoverable instead of ambiguous: a second `buy`
 * with the same key never calls the node again — it replays the result if the first one completed, or routes to
 * `reconcile_purchase` if it did not. Persisted (mode 0600) so a restart mid-purchase is still recoverable.
 */
export class PurchaseJournal {
  private readonly rows = new Map<string, JournalRow>();
  private readonly path: string | null;

  constructor(stateDir: string | null) {
    this.path = stateDir ? join(stateDir, 'purchases.json') : null;
    if (this.path) {
      try {
        mkdirSync(stateDir as string, { recursive: true });
        const raw = JSON.parse(readFileSync(this.path, 'utf8')) as JournalRow[];
        for (const r of raw) this.rows.set(r.key, r);
      } catch { /* first run, or an unreadable journal — start empty rather than refuse to serve */ }
    }
  }

  /** The default key is derived from the quote, so an agent that forgot to pass one still cannot pay twice. */
  static keyFor(quoteId: string, explicit?: string): string {
    return explicit ?? `q:${createHash('sha256').update(quoteId).digest('hex').slice(0, 32)}`;
  }

  get(key: string): JournalRow | null { return this.rows.get(key) ?? null; }
  list(): JournalRow[] { return [...this.rows.values()].sort((a, b) => b.at - a.at); }

  begin(row: Omit<JournalRow, 'state' | 'at'>): JournalRow {
    const r: JournalRow = { ...row, state: 'intent', at: Date.now() };
    this.rows.set(r.key, r);
    this.flush();
    return r;
  }

  complete(key: string, patch: { tx_hash?: string | null; amount?: string; result?: unknown }): void {
    const r = this.rows.get(key);
    if (!r) return;
    Object.assign(r, { state: 'complete' as const, ...patch });
    this.flush();
  }

  markFailed(key: string, error: string): void {
    const r = this.rows.get(key);
    if (!r) return;
    // NOT deleted: an `intent` that failed is exactly the case where money may already have moved (design §6.5).
    r.error = error;
    this.flush();
  }

  private flush(): void {
    if (!this.path) return;
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.list(), null, 2)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } catch { /* a journal we cannot persist is still a journal in memory — never fail a purchase over it */ }
  }
}
