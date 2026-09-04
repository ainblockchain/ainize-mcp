# Teaching — the two doors, the base, and the daily lesson

## One pipeline, two doors

```
rows / a file  →  training set (canonical JSONL + sha256)  →  preflight  →  training  →  side-effect check  →  a lesson
```

Door A is a training set already on the node (uploaded here with `create_training_set`, or collected in the
browser's Live test and frozen when the teacher presses Teach). Door B is `teach { rows: [...] }`, which creates the
training set for you. Both produce **the same bytes**: `src/rows.ts` reproduces the node's own canonicalisation
(NFC, invisible characters stripped, whitespace collapsed, `Q:`/`A:` unwrapped, one trailing LF) so the sha256 is
known before uploading and identical rows land on the same training set instead of a second copy.

## `create_training_set`

Free, sub-second, spends no lesson. Reports every row it will **not** train and why — the node's row report is the
product's best UX and passes straight through:

```json
{ "dataset_id": "43647481-…", "existing": false, "rows_accepted": 2, "rows_rejected": [],
  "sha256": "67c1b685…", "predicted_sha256": "67c1b685…", "sha256_matches_prediction": true,
  "summary": { "source_rows": 2, "accepted": 2, "duplicates": 0, "conflicts": 0, "too_long": 0, … } }
```

`retention: "delete_after_training"` removes the uploaded questions from somebody else's machine once a lesson has
used them.

## `teach_preflight` — would this actually teach anything?

One model call per question, under the shared lock, so it comes back as a job handle. Per question:

| Status | Meaning |
|---|---|
| `will_train` | the model gets it wrong today — worth a lesson |
| `already_known` | it does not. Teaching it spends a lesson to change nothing |
| `overlaps_listing` | this node already **sells** a knowledge answering it (the entry is named) |
| `invalid` | the row cannot be trained (too long, empty, unparseable) |

It costs no money but spends free live-test units, charged to **both** the server's IP and the teaching key. With a
`base`, the base is loaded first — so `already_known` then means *the base already answers it*, which is the
question you actually want answered before extending something.

## `teach`

```jsonc
teach {
  "rows": [{ "prompt": "…", "answer": "…" }],   // or "dataset_id"
  "base": ["krx-all-2761"],        // built ON TOP OF: a parent for good, shares every sale, a buyer needs it too
  "compare_with": [],              // loaded during the lesson for comparison only; recorded nowhere
  "mode": "extend",                // scratch | extend (needs a base) | fork | merge (no node supports merge yet)
  "export": "delta",               // delta (needs the base loaded) | squash (stand-alone)
  "inherit": true,                 // start from the base's own training set as the keep-set
  "effort": "balanced",            // quick 8/2 · balanced 20/2 · thorough 40/4 (steps/eval_every)
  "confirm": false,                // required when this is the key's last lesson today
  "dry_run": false
}
```

`base` maps to the node's `base_ids`, `compare_with` to `context_ids`. The deprecated `builds_on_context` is never
sent. Two bases would be a merge and is refused locally with `merge_not_available`; `mode: "extend"` without a base
is refused locally too; a `REJECTED` or `CHALLENGED` base is refused before anything is uploaded, and a
`SUPERSEDED` one unless `force: true`.

### A lesson is scarce like money

The node charges one of `jobs_per_key_per_day` **at submit time** — before it trains, before it checks — and never
refunds it. So this server:

- runs the preflight itself and fails the job with `nothing_to_train` when everything is already answered (no
  lesson submitted, the session reservation returned, the per-question verdicts in the refusal);
- requires `confirm: true` when the key has one lesson left today;
- caps how many lessons one MCP session may spend with `AINIZE_MCP_MAX_TEACH_JOBS` (server configuration; no
  argument raises it);
- reports a failed lesson as `teach_quota_consumed` with `retryable: false` — spending another one is a person's
  decision.

`dry_run: true` resolves the bases, the quota and the rows (with the predicted training-set sha256) and calls
neither the dataset door nor the preflight, because the preflight itself costs units.

## Reading a lesson: the node's 13 states, and what it learned

`QUEUED → PREFLIGHT → LOADING → TRAINING → EXPORTED → CHECKING → READY | NEEDS_MORE | FAILED | CANCELLED`
(plus `PENDING_REVIEW`, `REJECTED`, `ANNOUNCED`, `EXPIRED` on the publish side).

`job_status` carries the raw state as `native_state`, one sentence for what is happening, live `progress`
(`step/max_steps`), and — when it lands — what it learned **and what it did not**:

```json
"questions": { "in_the_lesson": 1, "measured": 1, "learned": 1, "not_learned": 0,
               "still_wrong": [], "taught": [{ "question": "…", "answer": "…", "alt_phrasing_ok": true }] },
"checks": { "taught": { "hits": 1, "of": 1, "percent": 100 },
            "other_phrasing": { "hits": 1, "of": 1 },
            "did_not_break_the_base": { "ok": true, "hits": 10, "of": 10 },
            "did_not_change_unrelated_answers": { "ok": true, "same": 20, "of": 20 },
            "reversible": null, "publish_gate": "open",
            "note": "this node trains with the STUB backend: these numbers were simulated" },
"draft_id": "taught-draft-1",
"next_steps": ["live_test with knowledge: [\"taught-draft-1\"] …", "download_lesson …", "publish_knowledge …"]
```

`eta_s` is deliberately `null` until the node has at least three measured samples on a real backend; render it as
**"no measured estimate yet"**, never as 0. A `simulated: true` check block means a stub trainer measured nothing —
say so before anyone believes the 100 %.

## Keep it private, or publish

`download_lesson { lesson_id }` fetches the `.npz`, `recipe.json` and `RUN-LOCALLY.md` into this server's own
download directory and returns the paths. The node's save links carry a `?token=`, which is a credential: the links
never reach the model, only the local paths do.

`publish_knowledge` is irreversible and off by default (`AINIZE_MCP_ALLOW_PUBLISH=1`). It refuses outright on a node
whose `/api/info` says `ledger: "ain"` (`permanent_ledger_refused`), requires both consent booleans with no default
and a `confirm_phrase` containing the lesson id, and shows a `split_preview` computed from the node's own shares —
**49 %** to the teacher when the knowledge has a parent, 70 % when it has none. Never repeat the publish sheet's
flat 70 %.

## What is landing next, upstream

`docs/lineage-teach-design.md` (PRs L2–L9) is adding typed lineage edges, dataset access levels, `?bundle=1` and per
knowledge signals. `base_ids` / `context_ids` / `mode` / `export` / `inherit` already exist and are what these tools
send. Re-read `packages/node/src/api.ts` and `packages/node/src/teach.ts` before changing the schema.
