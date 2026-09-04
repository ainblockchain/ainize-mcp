# Money — x402, quoting, caps, and never paying twice

Loaded on demand. The short version lives in `SKILL.md`; this is the whole contract.

## The rail: x402

Ainize sells over [x402](https://x402.org): an HTTP 402 handshake with a machine-readable payment requirement.

```
GET /x402/patch/<id>                  →  402 + x-payment-required + { x402Version, requirements: [...] }
GET /x402/patch/<id>  X-PAYMENT: …    →  200 + manifest (sha256 of the body, blob urls, download token)
```

Each requirement carries `scheme` (`ain-transfer` on the AIN chain, `local-credit` on a local ledger), `network`,
`asset`, `payTo`, `maxAmountRequired`, `resource`, `nonce` and `expires_at`. It is the **seller's own binding
number**, valid for ten minutes.

The unpaid handshake is the only honest quote primitive the product has, and nothing in the web UI or the CLI calls
it before spending. That is why this server exists in two halves.

## `quote` → `buy`, and why they are two tools

`quote` is free and reversible. It combines three reads:

1. `GET /api/patches/:id` — price, currency, `status`, `superseded_by`, `license`, `quorum`, `sellable`,
   `purchased`, `has_body`, and `requires[]` (the base stack, each with its own price and whether this node holds
   it);
2. `GET /api/me/purchases` (when an operator credential is configured) — so an already-bought knowledge comes back
   as `already_purchased` with its date and tx hash instead of a price;
3. the unpaid 402 handshake — the binding amount, `pay_to`, `scheme` and `nonce`.

`dry_run: true` skips step 3 entirely, because a 402 **reserves a nonce** for ten minutes. A dry run that called the
gateway would not be a dry run.

`buy` takes **no `id`**. Its gates, all evaluated before the node is called at all:

| Gate | Failure |
|---|---|
| a `quote_id` from this session | `quote_required` |
| the quote is younger than 10 minutes | `quote_expired` |
| `confirm_total` string-equals the quoted total | `quote_mismatch` |
| `confirm: true` | `confirmation_required` |
| not already purchased | `already_purchased` (with tx hash and date) |
| `quorum_ok`, `sellable`, `status: LISTED` | the node's own `423` reason, quoted |
| the live price still matches the quote | `quote_mismatch` |
| within `max_price`, the per-purchase cap and the session cap | `per_purchase_cap_exceeded` / `budget_exceeded` |

`dry_run: true` on `buy` runs every gate and returns `gates_passed[]` without touching the gateway.

## Caps

| Env | Meaning |
|---|---|
| `AINIZE_MCP_SESSION_BUDGET` | everything this process may spend, ever. Default `0` — and at `0` the `buy` tool is **not registered at all** |
| `AINIZE_MCP_MAX_PER_PURCHASE` | ceiling for one purchase (defaults to the session budget) |

A tool argument (`max_price`) may only **lower** the ceiling for one call. Nothing an agent can write raises a cap;
raising one means editing the server's environment and restarting it. Every money-tier result carries
`budget: { cap, spent, reserved, remaining, currency, per_purchase_cap }`, and `ainize://budget` is a resource.

Amounts are decimal strings all the way through (`src/dec.ts`) — never a float, never a `Number`.

## Idempotency, and the lost-manifest case

`Market.buy()` on the node is **not idempotent**: the payment nonce is single-use, a second call mints a new nonce
and settles again, and the purchase row is written only *after* the blob download — so a download that fails loses
the manifest while the seller's settlement already stands.

This server therefore:

- journals an `intent` (idempotency key → patch id, quote, amount) **before** the node is called, at mode 0600;
- refuses a repeat of the same key with `idempotency_replay` **without an upstream call**;
- never auto-retries anything in the money tier — every money error comes back `retryable: false`;
- offers `reconcile_purchase { id | idempotency_key }`, which tells four states apart without paying:

| State | Meaning |
|---|---|
| `complete` | paid, recorded, body present. Buying again would pay twice for nothing |
| `settled_no_body` | the money moved, the body did not arrive. Carries the tx hash |
| `never_paid` | no settlement anywhere — a fresh `quote` → `buy` is safe |
| `recovered` | the body was found locally after all |

`settled_no_body` names the recovery but does not perform it: the node grants a settled buyer the blob from
`GET /p2p/blob/:sha` under a signature from the **node identity key**, which this server deliberately never holds.
That is an operator action (`packages/node/src/market.ts`, `mayDownload`).

## The base stack, and what `buy` really buys

A delta knowledge needs its base loaded. `GET /api/patches/:id` reports `requires: [{id, name, price, held}]`, so a
quote can state the honest total — but the node has no bundle purchase (`?bundle=1` does not exist), so `buy`
settles the **named child only** and says so. Example from node-b, session cap 10 AIN:

```json
"affordable": {
  "requested": false, "with_bases": false, "shortfall": "15",
  "explanation": "krx-all-2761 alone costs 25 AIN and does not fit. With the bases it needs the honest total is 25 — 15 over your remaining 10. Buy the add-on now and it sits unusable until the base is bought, raise AINIZE_MCP_SESSION_BUDGET, or look for a stand-alone knowledge that covers the same questions."
}
```

## Superseded knowledge is never silently retargeted

The autonomous agent in `packages/agent` follows a supersede mark before checking the price, which can turn a
0.1-credit purchase into a 25-credit one. `quote` names the id you asked for, prices *that*, and reports
`superseded_by` as a fact for the human to act on.

## The royalty split, and the number the web UI gets wrong

When a knowledge has a parent, a lineage pool (`royalty_share`, 0.3 on the demo nodes) is paid to the ancestors
first; the data provider's `contributor_share` (0.7) applies to what is **left**. So the teacher of a knowledge with
a parent receives 0.7 × 0.7 = **49 %** of the price, not the flat 70 % the web publish sheet prints
(`docs/ux-critique-3.json`, item 186). `publish_knowledge`'s `split_preview` is computed from the node's own shares
the way `royaltySplit` in `packages/core/src/catalog.ts` computes it, and is shown in `dry_run` before either
consent is asked for.

## What a good money turn looks like

1. `quote` → show total, bases, budget, verification. **End the turn.**
2. The human says yes.
3. `buy { quote_id, confirm_total, confirm: true }` → `job_id`.
4. `job_status` → the node's `steps[]` timeline: quorum → 402 → pay → settled → download → receipt.
5. `live_test` the thing you just bought, and report the before/after.

Anything that fails between 3 and 4 is a `reconcile_purchase`, never a second `buy`.
