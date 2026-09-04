---
name: ainize
description: >-
  Use when the model gave a wrong, outdated or hallucinated answer about a specific domain and you want to fix it
  properly — search Ainize for a knowledge that covers it, prove it with a before/after live test on the same
  question, buy it over x402 within a budget, or teach the model the correct answers yourself (optionally on top of
  an existing knowledge). Also use when asked to price, quote or budget a knowledge purchase, to check who verified
  a knowledge and with what score, to publish a lesson as a data provider, or to turn data from another MCP server
  (e.g. The Graph's Subgraph MCP) into a training set.
license: Apache-2.0
compatibility:
  platforms: [claude-code, cursor, vscode, windsurf]
metadata:
  version: 0.1.0
  author: Ainize
  documentation: packages/mcp/README.md
---

# Ainize — buy knowledge, or teach it

## Overview

Ainize is a peer-to-peer marketplace for **knowledge**: trained memory-table patches (`.npz`) that a node applies
into a *running* LLM through a PLE hook, in seconds, and removes just as fast. A knowledge is not a document and not
a retrieval index — once it is loaded the model simply answers differently, with no extra tokens in the prompt.

Three things follow, and they shape every tool in this skill:

- **The proof is a before/after, not a description.** `live_test` asks one question twice — of the bare model and of
  the same model with the knowledge loaded — and shows both answers. Never claim a knowledge helps until you have
  seen that pair.
- **The money rail is x402.** `GET /x402/patch/:id` answers `402` with the seller's binding requirements. This
  server splits that into `quote` (free, reversible) and `buy` (settles a quote it already showed you).
- **Teaching writes new knowledge with a recorded lineage.** Questions and answers become a knowledge, optionally
  *on top of* an existing one — which is then its parent for good and shares every sale.

## When to use

Use this skill when the user:

- got a **wrong, outdated or made-up answer** about a specific domain (tickers, protocol addresses, internal facts)
  and wants it fixed rather than worked around;
- asks to **find, price, quote, budget or buy** knowledge, or asks *"what would it cost?"*;
- asks to **prove** something works — *"does it actually know this?"*, *"show me before and after"*;
- wants to **teach the model** facts permanently, from a list, a file or another MCP server's data;
- asks **who verified** a knowledge, with what score, what it is built on, or who gets paid;
- wants to **publish** a lesson and be credited as its data provider.

Do **not** use it for general web search, for a fact you would rather look up every turn (that is retrieval), or for
anything that changes every block — a price or a TVL trained into memory is wrong tomorrow.

## Two safety tiers

**Read freely — call these without asking.**
`search_knowledge` · `get_knowledge` · `family_tree` · `get_training_set` · `node_status` · `my_library` ·
`knowledge_signals` · `teacher_profile` · `quote` · `job_status` · `job_list`

**Spending or mutating — echo back exactly what will happen and what it costs, then wait for the human.**
`buy` (moves **real money**, irreversible) · `publish_knowledge` (writes a ledger record that **cannot be
recalled**) · `teach` (spends one non-refundable daily lesson) · `create_training_set` (uploads rows to somebody
else's node) · `apply_knowledge` / `remove_knowledge` (changes a model server other people share) ·
`download_lesson` (writes files).

Two hard rules and one posture rule:

1. **Never print or pass along a session token, teaching key, password or signature.** The server holds them; no
   tool takes one and none is ever returned. If you think you need a credential, you have misread the tool.
2. **Never background-poll a human decision.** The turn that shows a price and asks for approval **ends**. Poll
   `job_status` for a job that is already running; never for a person.
3. **A vague request is a question, not a guess.** If the price, the base knowledge or which node is unspecified,
   ask. Skill text alone does not override model posture, which is why `buy` structurally cannot be called without a
   quote you have already shown.

## Core concepts

| Term | What it means here |
|---|---|
| **knowledge** | a `.npz` of memory-table rows; applying it changes the model's answers, removing it restores them |
| **before / after** | the two columns of a `live_test`; `verdict` is only non-null when the question is in the knowledge's own benchmark |
| **quorum** | how many independent nodes re-ran the benchmark on the real model (`"2/2"`). The author's own attestation never counts, and a live challenge makes the knowledge unsellable |
| **base / `requires[]`** | a delta knowledge needs its base loaded to work. `quote` prices the whole stack; `buy` purchases the named child only and says so |
| **the model lock** | nodes on one machine share one serving model behind a cross-process lock; a holder can keep it for minutes. Every model-touching tool is a job handle, and every answer names the holder |
| **the daily lesson** | teaching is metered per key per day, charged **at submit time** and never refunded |
| **the two teach doors** | rows you pass to `teach`, or a training set already on the node (`create_training_set`, or one from the browser's Live test). Both become the same canonical JSONL with the same sha256 |

## Common workflows

### 1. Find knowledge that answers X

```
search_knowledge { query: "KRX ticker", limit: 5 }      → flat rows: id, price, rows, status, quorum, author
get_knowledge   { id: "krx-all-2761" }                  → verifiers + scores, lineage, requires[], availability
```

Report `quorum_ok`, `sellable` and the verifiers' scores. `status: "SUPERSEDED"` means a newer version exists —
name it, never silently retarget to it. If `requires[]` is non-empty the knowledge is an add-on and needs its base.

### 2. Prove a knowledge works

```
live_test { question: "…", knowledge: [] }              → job_id   (the bare model)
job_status { job_id, wait_ms: 30000 }
live_test { question: "…", knowledge: ["krx-all-2761"] } → job_id  (or one call in compare mode, which does both)
job_status { job_id, wait_ms: 60000 }
```

`mode: "compare"` (the default) answers both columns in one job. Report **both answers verbatim**, the verifiers and
the score. If `verdict` is `null`, say the comparison is unscored — it is a comparison, not a verified result. If
`model_lock.sentence` says another node holds the model, report that sentence and wait; do not retry in a loop.

### 3. Buy knowledge within a budget

```
quote { id: "krx-all-2761" }                            → total_with_bases, affordable.explanation, quote_id
   → show the human the total, the bases and the remaining budget. END THE TURN.
buy  { quote_id, confirm_total: "25", confirm: true }   → job_id
job_status { job_id, wait_ms: 60000 }                   → the node's own steps[] timeline
live_test { question, knowledge: [id] }                 → prove the thing you just paid for
```

`buy` has **no `id`**: what gets bought is whatever the quote named. The total must be restated character for
character. If it fails, **do not buy again** — `reconcile_purchase { id }` tells you whether the money moved.
Over the cap you get `budget_exceeded` with cap / spent / remaining / needed: report the numbers, offer to raise
`AINIZE_MCP_SESSION_BUDGET` (server configuration — you cannot), and stop.

### 4. Teach the model these facts

```
teach_preflight { rows: [{prompt, answer}, …] }         → job_id → will_train / already_known per question
teach { rows: […], base: ["krx-all-2761"], mode: "extend" }  → job_id  (spends one daily lesson)
job_status { job_id, wait_ms: 25000 }                   → repeat until state is done/failed
live_test { question, knowledge: [result.draft_id] }    → prove the draft against the bare model
download_lesson { lesson_id }        # keep it private
publish_knowledge { lesson_id, … }   # or make it public — irreversible, opt-in, needs consent + a phrase
```

`teach` runs the preflight itself and refuses with `nothing_to_train` when the model already answers everything —
that refusal is free and correct, do not work around it with `skip_preflight`. `base` is what the lesson is *built
on* (a parent for good, paid on every sale); `compare_with` is loaded for comparison only and recorded nowhere.
`dry_run: true` shows exactly what would be sent and costs nothing.

### 5. Teach the model from a subgraph (Ainize as an MCP client)

```
1. The Graph's Subgraph MCP:  search_subgraphs_by_keyword
2.                            get_deployment_30day_query_counts   ← always, before choosing
3.                            get_schema_by_subgraph_id            ← check the fields the mapping uses
4.                            execute_query_by_subgraph_id         ← bounded, and pin the block (_meta)
5. Ainize:                    create_training_set { rows, provenance }
6.                            STOP. Show the rows and the row count.
```

Only **immutable** facts (an address, a symbol, a decimals value) belong in memory. The pipeline ends at a training
set: reviewing the rows and spending a lesson are separate, confirmed steps. `packages/mcp/src/examples/subgraph-to-training-set.ts`
is the runnable version of exactly this sequence.

## Examples

**A real before/after** (node-a, `krx-all-2761`, 2026-09-04). `live_test` returned a handle in 91 ms; `job_status`
with `wait_ms` answered 18.8 s later:

```json
{ "before": { "answer": "058420", "latency_ms": 406 },
  "after":  { "answer": "087600", "latency_ms": 378 },
  "changed": true, "verdict": null,
  "knowledge": [{ "id": "krx-all-2761", "applied_ms": 3789,
                  "verification": { "quorum": "2/2", "attestations": [ /* node-b 26/26, node-c 26/26 */ ] } }],
  "caveats": ["this question is not in the knowledge's own benchmark, so the comparison is unscored"] }
```

Say: *"Before: 058420 (wrong). After: 087600 (right). Two independent nodes scored it 26/26 on its own benchmark;
this particular question is not in that benchmark, so treat it as a comparison, not a verified score."*

**A refusal that is the right answer** (a 10-credit session cap, a 25 AIN knowledge):

```json
{ "affordable": { "requested": false, "shortfall": "15",
    "explanation": "krx-all-2761 alone costs 25 AIN and does not fit. With the bases it needs the honest total is 25 — 15 over your remaining 10." } }
```

Report the shortfall and stop. Do not look for a cheaper thing to buy unless asked.

**Refusals you should expect, and what each means**: `nothing_to_train` (the model already knows it — no lesson was
spent), `already_purchased` (with the date and tx hash — nothing was charged), `permanent_ledger_refused` (the node
is on the shared AIN chain; a local-ledger node such as `:3422` is the place to publish), `quota_ip` / `quota_key`
(the day's lessons are gone — a person decides what to do next).

## Troubleshooting

| Code | What to do |
|---|---|
| `model_busy` | the message names the holder and how long; report it, retry after ~30 s, never in a tight loop |
| `quota_chat` | free live tests are 20/hour per visitor IP and **shared by everyone on this server**; `retry_after_ms` says when they return |
| `quota_key` / `quota_ip` | the daily lessons are spent; nothing you can retry today |
| `quote_required` / `quote_expired` / `quote_mismatch` | quote again and show the human the new number; never guess a total |
| `budget_exceeded` / `per_purchase_cap_exceeded` | report the four numbers; only the server's own env can raise a cap |
| `already_purchased` / `idempotency_replay` | the money already moved; call `reconcile_purchase`, never `buy` again |
| `nothing_to_train` | say what the model already answers correctly; ask for harder facts |
| `base_rejected` / `base_retired` | the base is challenged, rejected or superseded — name the replacement the error carries |
| `permanent_ledger_refused` | publish on a local-ledger node instead |
| `job_not_found` | jobs are session-scoped and evicted 30 min after they finish; `job_list` shows what is left |
| `node_unreachable` | the node is down; say so, do not fabricate a catalogue |

Full table with `retryable` for each: `references/errors.md`.

## Resources

| File | What is in it |
|---|---|
| [`references/money.md`](references/money.md) | x402, quote → confirm → settle, caps, idempotency, reconcile, the 49 % royalty split |
| [`references/live-test.md`](references/live-test.md) | modes, the shared-model caveat, quota arithmetic, reading a `verdict` |
| [`references/teach-and-lineage.md`](references/teach-and-lineage.md) | both doors, `base` vs `compare_with`, the 13-state machine, publish consent |
| [`references/verification.md`](references/verification.md) | quorum, attestations, challenges, what "verified" does and does not mean |
| [`references/errors.md`](references/errors.md) | every error code, `retryable`, and the recovery |
| [`references/subgraph-to-dataset.md`](references/subgraph-to-dataset.md) | direction B end to end, provenance, the volatility rule |
| [`references/cli.md`](references/cli.md) | the equivalent `ainize` CLI commands, for a terminal or a script |

The server also serves `ainize://instructions`, `ainize://node/info`, `ainize://budget` and `ainize://openapi`, and
the node itself serves `/docs` and `/api/openapi.json`. Setup, configuration and every tool's schema:
[`README.md`](README.md). Scoring rubric for this skill: [`EVAL.md`](EVAL.md).
