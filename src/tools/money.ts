/**
 * MONEY tier (design §4.3, §6) — quote, buy, reconcile.
 *
 * The node fuses quote and payment into one operator-gated call with no ceiling, no confirmation, no idempotency and
 * no returning-buyer branch (`POST /api/patches/:id/buy` takes `{ apply? }`; buying twice pays twice). Every guard
 * therefore lives here, and MECHANICALLY:
 *
 *   `buy` has no `id` parameter. What gets bought is whatever the quote named, the total must be restated verbatim,
 *   `confirm: true` is a separate required field, the session cap comes from the server's env and no argument can
 *   raise it, and an `intent` is journalled BEFORE the node is called so a timeout is recoverable instead of
 *   ambiguous. Nothing in this file is ever auto-retried.
 */
import { z } from 'zod';
import type { Context } from '../context.js';
import { fail, UpstreamError } from '../errors.js';
import { addAmounts, cmpAmounts, normalizeAmount, subAmounts } from '../dec.js';
import { PurchaseJournal, type Quote, type QuoteItem } from '../money.js';
import type { RawEntry } from '../format.js';
import { echoId } from '../scrub.js';
import { tool, type ToolDef } from './types.js';

interface PurchaseRow { patch_id: string; amount: string; tx_hash: string; scheme: string; created_at: number; path?: string | null; currency?: string }

const purchasesOf = async (ctx: Context): Promise<Map<string, PurchaseRow>> => {
  if (!ctx.client.hasOperator) return new Map();
  const out = await ctx.client.request<{ items: PurchaseRow[] }>('/api/me/purchases', { auth: 'operator' }).catch(() => ({ items: [] as PurchaseRow[] }));
  return new Map(out.items.map((r) => [r.patch_id, r]));
};

interface X402Requirement { scheme: string; network: string; asset: string; payTo: string; maxAmountRequired: string; resource: string; nonce: string; expires_at: number }

export function moneyTools(ctx: Context): ToolDef[] {
  const tools: ToolDef[] = [];

  tools.push(tool<{ id: string; include_bases?: boolean; dry_run?: boolean }>({
    name: 'quote',
    title: 'Quote a knowledge',
    tier: 'MONEY',
    description: 'What a knowledge really costs before anything moves: its price, whether it is verified and sellable, whether this node already bought it, the base stack it needs and the honest total with those bases, and how much session budget is left. Free and side-effect-light. This is the ONLY way to get a quote_id, and `buy` cannot be called without one.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      id: z.string().min(1).max(128),
      include_bases: z.boolean().default(true).describe('price the base stack this knowledge needs to be loadable'),
      dry_run: z.boolean().default(false).describe('true = price it from the catalogue only; no 402 handshake, so nothing at all is reserved upstream'),
    },
    handler: async (a) => {
      const id = a.id;
      let e: RawEntry & Record<string, unknown>;
      try {
        e = await ctx.client.request<RawEntry & Record<string, unknown>>(`/api/patches/${encodeURIComponent(id)}`, { auth: 'caller' });
      } catch (err) {
        if (err instanceof UpstreamError && err.status === 404) throw fail('not_found', `no knowledge with id ${echoId(id)} on ${ctx.client.url}.`);
        throw err;
      }
      const info = await ctx.nodeInfo();
      const purchases = await purchasesOf(ctx);
      const mine = purchases.get(id);
      const currency = e.anchor.currency ?? info.currency;

      // What the node itself would refuse, said before a price is offered: no price is honest while a verifier
      // disputes the result, and an unverified entry is not for sale yet.
      if (!e.quorum_ok) throw fail('not_listed_yet', `${id} is not listed yet (verification ${e.passed}/${e.quorum}) — it cannot be bought until the quorum is met.`, { details: { passed: e.passed, quorum: e.quorum }, retryable: true });
      if (!e.sellable) throw fail('challenged', `${id} is locked: a verifier disputes the result${e.challenges?.length ? ` (${e.challenges[e.challenges.length - 1]?.reason ?? 'challenged'})` : ''}. No price is honest while a challenge is open.`, { details: { status: e.status } });

      const requires = ((e.requires as { id: string; name: string; held: boolean; price: string | null }[] | undefined) ?? []);
      const gateway = (e.gateway_url as string | null) ?? null;
      const item: QuoteItem = {
        id, name: e.anchor.name, role: 'requested',
        price: normalizeAmount(e.anchor.price, 'price'), currency,
        status: e.status, superseded_by: e.superseded_by?.[0] ?? null,
        license: (e.anchor.license as string | undefined) ?? null,
        seller: e.anchor.author, gateway_url: gateway,
        quorum: `${e.passed}/${e.quorum}`, sellable: e.sellable,
        already_purchased: !!mine || !!e.purchased, owned: !!e.owned, body_held: !!e.has_body,
      };

      const warnings: string[] = [];
      let binding = false;
      if (!a.dry_run) {
        // The seller's own binding quote: GET /x402/patch/:id with no X-PAYMENT answers 402 + requirements.
        // Its only side effect is reserving a nonce for 10 minutes — which is why dry_run never calls it.
        const res = await ctx.client.raw<{ requirements?: X402Requirement[]; error?: string }>(`/x402/patch/${encodeURIComponent(id)}`, { allowStatus: [402] }).catch((err) => {
          if (err instanceof UpstreamError && err.status === 409) { warnings.push(`${String(err.body.error)} — this node is not the seller, so the binding quote lives at that gateway; buy will fetch it there`); return null; }
          throw err;
        });
        const req = res?.body.requirements?.[0];
        if (req) {
          binding = true;
          item.scheme = req.scheme; item.pay_to = req.payTo; item.nonce = req.nonce;
          if (cmpAmounts(req.maxAmountRequired, item.price) !== 0) {
            warnings.push(`the seller's 402 asks ${req.maxAmountRequired} ${req.asset} while the catalogue says ${item.price} — the binding number is the seller's`);
            item.price = normalizeAmount(req.maxAmountRequired, 'price');
          }
        }
      }

      const items: QuoteItem[] = [item];
      if (a.include_bases !== false) {
        for (const b of requires) {
          const bought = purchases.get(b.id);
          items.push({
            id: b.id, name: b.name, role: 'base', price: b.price ? normalizeAmount(b.price, 'price') : '0', currency,
            status: 'UNKNOWN', superseded_by: null, license: null, seller: '', gateway_url: null,
            quorum: '—', sellable: true, already_purchased: !!bought, owned: false, body_held: !!b.held,
          });
        }
      }

      const totalRequested = item.already_purchased || item.owned ? '0' : item.price;
      const missingBases = items.filter((i) => i.role === 'base' && !i.body_held && !i.already_purchased);
      const totalWithBases = missingBases.reduce((acc, b) => addAmounts(acc, b.price), totalRequested);

      const budget = ctx.budget.view();
      const affordableRequested = !ctx.budget.enabled ? false : cmpAmounts(totalRequested, budget.remaining) <= 0;
      const affordableAll = !ctx.budget.enabled ? false : cmpAmounts(totalWithBases, budget.remaining) <= 0;
      const shortfall = affordableAll ? '0' : subAmounts(totalWithBases, budget.remaining);

      if (item.owned) warnings.push(`this node is the seller of ${id} — it already holds it and there is nothing to buy. The total is 0.`);
      if (item.already_purchased) warnings.push(`this node already bought ${id}${mine ? ` on ${new Date(mine.created_at).toISOString().slice(0, 10)} (tx ${mine.tx_hash})` : ''} — buying again would pay a second time for nothing. Nothing was charged by this quote.`);
      if (item.superseded_by) warnings.push(`${id} is superseded by ${item.superseded_by}: quote that one too and let the human pick — this quote prices exactly the id you named, never a substitute.`);
      if (missingBases.length) warnings.push(`this is an add-on: without ${missingBases.map((b) => b.id).join(', ')} loaded first, applying it is refused. \`buy\` purchases one knowledge at a time — a bundle buy is not implemented on this node.`);
      if (!ctx.budget.enabled) warnings.push('this MCP server has a session budget of 0, so `buy` is not registered at all — quoting is all it will do. Set AINIZE_MCP_SESSION_BUDGET to allow spending.');
      if (a.dry_run) warnings.push('dry run: priced from the catalogue only. No 402 handshake was made, so this is not the seller\'s binding number and no nonce was reserved.');

      const quote: Quote = ctx.quotes.create({
        patch_id: id, expires_at: Date.now() + 10 * 60_000, dry_run: !!a.dry_run, currency,
        total_requested: totalRequested, total_with_bases: totalWithBases, items,
      });

      return {
        quote_id: quote.quote_id, expires_at: quote.expires_at, binding, dry_run: !!a.dry_run,
        items, currency,
        total_requested: totalRequested,
        total_with_bases: totalWithBases,
        budget,
        affordable: {
          requested: affordableRequested, with_bases: affordableAll, shortfall,
          explanation: !ctx.budget.enabled
            ? `Buying is disabled on this server (session budget 0). ${id} costs ${item.price} ${currency}${missingBases.length ? `, and the honest total with its base stack is ${totalWithBases}` : ''}.`
            : affordableAll
              ? `${id} costs ${totalRequested} ${currency}${missingBases.length ? ` and its missing bases bring the honest total to ${totalWithBases}` : ''}; you have ${budget.remaining} left of a ${budget.cap} session cap.`
              : `${id} alone costs ${totalRequested} ${currency}${affordableRequested ? ' and fits' : ' and does not fit'}. With the bases it needs the honest total is ${totalWithBases} — ${shortfall} over your remaining ${budget.remaining}. Buy the add-on now and it sits unusable until the base is bought, raise AINIZE_MCP_SESSION_BUDGET, or look for a stand-alone knowledge that covers the same questions.`,
        },
        warnings,
        confirm_with: { tool: 'buy', quote_id: quote.quote_id, confirm_total: totalRequested, confirm: true },
        next: 'show the human the total, the bases and the remaining budget, then STOP. Never call buy in the same turn you first learned the price.',
      };
    },
  }));

  if (ctx.capabilities().can_buy) {
    tools.push(tool<{ quote_id: string; confirm_total: string; confirm: boolean; idempotency_key?: string; apply?: boolean; max_price?: string; dry_run?: boolean }>({
      name: 'buy',
      title: 'Buy a knowledge (spends real money)',
      tier: 'MONEY',
      description: 'Settle a quote over x402: pay the seller, download the knowledge body, and record the purchase. This spends real money. There is no `id` parameter — what gets bought is whatever the quote named — and the quoted total must be restated exactly. Refuses over the session cap, refuses an expired quote, refuses a knowledge this node already bought, and is never safe to retry: on any error call reconcile_purchase, never buy again.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        quote_id: z.string().min(1).max(64).describe('from `quote` — the only way to name what is bought'),
        confirm_total: z.string().min(1).max(40).describe('the quote\'s total_requested, restated exactly (compared by string equality)'),
        confirm: z.literal(true).describe('the human agreed to this spend'),
        idempotency_key: z.string().max(64).optional().describe('replay guard; defaults to one derived from the quote'),
        apply: z.boolean().default(false).describe('load it into the shared model server after buying (visible to every node on this machine)'),
        max_price: z.string().max(40).optional().describe('lower the ceiling for this one call; it can never raise the server\'s cap'),
        dry_run: z.boolean().default(false).describe('run every gate and report what would happen, without calling the gateway'),
      },
      handler: async (a) => {
        const quote = ctx.quotes.require(a.quote_id);
        if (a.confirm !== true) throw fail('confirmation_required', 'buy needs confirm: true — a human has to agree to the spend, and a schema-filling model cannot approve by copying a number alone.');
        if (a.confirm_total !== quote.total_requested) {
          throw fail('quote_mismatch', `confirm_total ${echoId(a.confirm_total)} is not the quoted total ${JSON.stringify(quote.total_requested)} for ${quote.patch_id}. Restate the number the quote showed, exactly.`, { details: { quoted_total: quote.total_requested, you_said: a.confirm_total, total_with_bases: quote.total_with_bases } });
        }
        const item = quote.items.find((i) => i.role === 'requested');
        if (!item) throw fail('quote_mismatch', 'this quote has no requested item.');

        const key = PurchaseJournal.keyFor(quote.quote_id, a.idempotency_key);
        const prior = ctx.journal.get(key);
        if (prior && prior.state === 'complete') {
          throw fail('idempotency_replay', `this purchase already completed (${prior.patch_id}, ${prior.amount} ${prior.currency}${prior.tx_hash ? `, tx ${prior.tx_hash}` : ''}). Nothing was charged again.`, { details: { journal: prior } });
        }
        if (prior && prior.state === 'intent') {
          throw fail('idempotency_replay', `a purchase of ${prior.patch_id} with this key was started and never confirmed — money may already have moved. Call reconcile_purchase before ever buying again; do NOT retry.`, { details: { journal: prior, next: 'reconcile_purchase' } });
        }

        // Re-read the live entry: a quote is 10 minutes old and status can move under it.
        const live = await ctx.client.request<RawEntry & Record<string, unknown>>(`/api/patches/${encodeURIComponent(quote.patch_id)}`);
        const purchases = await purchasesOf(ctx);
        const mine = purchases.get(quote.patch_id);
        if (mine || live.purchased) {
          throw fail('already_purchased', `this node already bought ${quote.patch_id}${mine ? ` on ${new Date(mine.created_at).toISOString()} (tx ${mine.tx_hash}, ${mine.amount})` : ''}. Nothing was charged. If the body is missing, call reconcile_purchase — a settled buyer can always re-fetch it without paying again.`, { details: { bought_at: mine?.created_at ?? null, tx_hash: mine?.tx_hash ?? null, body_present: mine ? !!mine.path : null } });
        }
        if (live.owned) throw fail('already_purchased', `this node is the seller of ${quote.patch_id} — it already holds the body and buying its own knowledge would pay itself. Nothing was charged.`, { details: { owned: true } });
        if (!live.quorum_ok) throw fail('not_listed_yet', `${quote.patch_id} is not listed yet (verification ${live.passed}/${live.quorum}) — the node itself would refuse this purchase.`);
        if (!live.sellable) throw fail('challenged', `${quote.patch_id} is locked by an open challenge; no price is honest while a verifier disputes the result.`);
        const livePrice = normalizeAmount(live.anchor.price, 'price');
        if (cmpAmounts(livePrice, item.price) !== 0) {
          throw fail('quote_mismatch', `the price moved since the quote: ${item.price} → ${livePrice} ${quote.currency}. Quote again and show the human the new number.`, { details: { quoted: item.price, now: livePrice } });
        }

        const maxPrice = a.max_price ? normalizeAmount(a.max_price, 'max_price') : undefined;
        const reservation = ctx.budget.reserve(quote.total_requested, maxPrice);

        if (a.dry_run) {
          reservation.release();
          return {
            dry_run: true, would_buy: quote.patch_id, amount: quote.total_requested, currency: quote.currency,
            apply: !!a.apply, budget: ctx.budget.view(),
            gates_passed: ['quote present and unexpired', 'total restated exactly', 'confirm: true', 'not already purchased', 'quorum met', 'not challenged', 'price unchanged', 'within the session cap'],
            note: 'nothing was called on the gateway and no nonce was reserved. Re-run without dry_run to settle.',
          };
        }

        ctx.journal.begin({ key, patch_id: quote.patch_id, quote_id: quote.quote_id, amount: quote.total_requested, currency: quote.currency, tx_hash: null });

        const job = ctx.jobs.start({
          kind: 'buy',
          native: { patch_id: quote.patch_id },
          summary: `buy ${quote.patch_id} for ${quote.total_requested} ${quote.currency}`,
          run: async (signal) => {
            try {
              const out = await ctx.client.request<{ patch_id: string; steps: { step: string; detail: string; at: number }[]; tx_hash: string; amount: string; scheme: string; path?: string }>(
                `/api/patches/${encodeURIComponent(quote.patch_id)}/buy`,
                { method: 'POST', auth: 'operator', body: { apply: !!a.apply }, signal, timeoutMs: 11 * 60_000 },
              );
              reservation.settle(out.amount);
              const result = {
                patch_id: out.patch_id, amount: out.amount, currency: quote.currency, scheme: out.scheme,
                tx_hash: out.tx_hash, body_present: !!out.path, applied: !!a.apply,
                steps: out.steps,          // the node's own timeline, passed through verbatim
                budget: ctx.budget.view(),
                ...(cmpAmounts(out.amount, quote.total_requested) !== 0 ? { price_moved: { quoted: quote.total_requested, paid: out.amount } } : {}),
              };
              ctx.journal.complete(key, { tx_hash: out.tx_hash, amount: out.amount, result });
              return result;
            } catch (err) {
              reservation.release();
              ctx.journal.markFailed(key, (err as Error).message);
              throw err;
            }
          },
        });

        return {
          job_id: job.id, kind: 'buy', state: job.state, patch_id: quote.patch_id,
          amount: quote.total_requested, currency: quote.currency, idempotency_key: key,
          budget: ctx.budget.view(), poll_after_ms: 2000,
          next: 'poll job_status. If it fails or times out, do NOT buy again — call reconcile_purchase with this idempotency_key.',
          warning: quote.items.some((i) => i.role === 'base' && !i.body_held && !i.already_purchased)
            ? 'this buys the named knowledge only. Its base stack is still missing, so it will not be loadable until those are bought too.'
            : undefined,
        };
      },
    }));
  }

  if (ctx.client.hasOperator) {
    tools.push(tool<{ id?: string; idempotency_key?: string }>({
      name: 'reconcile_purchase',
      title: 'Reconcile a purchase',
      tier: 'MONEY',
      description: 'Find out whether a purchase actually happened, without paying anything. Use it after ANY buy error or timeout, and before ever buying the same knowledge again: the node writes its purchase row only after the body download, so a failed download can lose the receipt while the payment already settled. Free, read-only.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        id: z.string().max(128).optional().describe('the knowledge id to reconcile'),
        idempotency_key: z.string().max(64).optional().describe('the key from a buy result (its journal row names the knowledge)'),
      },
      handler: async (a) => {
        const row = a.idempotency_key ? ctx.journal.get(a.idempotency_key) : null;
        const id = a.id ?? row?.patch_id;
        if (!id) throw fail('invalid_request', 'reconcile_purchase needs either an id or an idempotency_key from a buy result.');
        const info = await ctx.nodeInfo();
        const purchases = await purchasesOf(ctx);
        const mine = purchases.get(id);
        if (mine) {
          ctx.journal.complete(a.idempotency_key ?? PurchaseJournal.keyFor(row?.quote_id ?? id), { tx_hash: mine.tx_hash, amount: mine.amount });
          return {
            state: 'complete', id, purchase: { amount: mine.amount, scheme: mine.scheme, tx_hash: mine.tx_hash, bought_at: mine.created_at, body_present: !!mine.path },
            explanation: `${id} is paid for and recorded on this node (tx ${mine.tx_hash}). Buying it again would pay a second time for nothing.`,
          };
        }
        const ledger = await ctx.client.request<{ records: { body: { patch_id?: string; buyer?: string; amount?: string; tx_hash?: string; created_at?: number } }[] }>('/api/ledger?kind=settle&limit=1000');
        const settle = ledger.records.find((r) => r.body.patch_id === id && r.body.buyer?.toLowerCase() === info.address.toLowerCase());
        if (settle) {
          return {
            state: 'settled_no_body', id, tx_hash: settle.body.tx_hash ?? null, amount: settle.body.amount ?? null,
            explanation: `The ledger shows this node already paid for ${id} (tx ${settle.body.tx_hash}), but no purchase row exists — the body download failed after the money moved. Do NOT buy again: a settled buyer keeps the right to fetch the body from any holder (GET /p2p/blob/:sha with a signature from this node's identity), and that right does not expire the way the manifest's 24 h download token does. Ask the node operator to re-fetch it, or use the node's own recovery path.`,
            next: 'this MCP server cannot sign for the node identity (design §8.1) — the re-fetch is the node operator\'s to run',
          };
        }
        return {
          state: 'never_paid', id,
          explanation: `No purchase row and no settlement naming this node as buyer for ${id}: nothing was charged, and buying it is safe.`,
          journal: row ?? null,
        };
      },
    }));
  }

  return tools;
}
