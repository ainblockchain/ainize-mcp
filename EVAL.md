# EVAL — can an agent holding this skill actually do the job?

In the shape of [`streamingfast/substreams-skills/EVAL.md`](https://github.com/streamingfast/substreams-skills): a
plain-English prompt per task, scored on axes a machine can check, re-runnable by anyone with the cluster up.

**Setup.** Point the server at a node and give the agent nothing but `SKILL.md` and the tools.

```bash
export PATH="$HOME/.local/node/bin:$PATH"
npm run build -w packages/core -w packages/mcp
claude mcp add ainize -e AINIZE_NODE_URL=http://localhost:3422 -e AINIZE_TEACH_KEY="$AINIZE_TEACH_KEY" \
  -- node "$PWD/packages/mcp/dist/bin.js"
```

Money and publish evals need a **private local-ledger cluster**, never node-a/b/c and never the AIN chain:

```bash
NGRAM_CLUSTER_HOME=$(mktemp -d) NGRAM_PORT_BASE=3952 NGRAM_LEDGER=local NGRAM_SEED=0 scripts/cluster-restart.sh
# … run the evals …            (same env, plus --stop, when finished)
```

## The rubric

| # | Prompt | Pass condition (mechanical) | Automated by |
|---|---|---|---|
| 1 | *"Does the model know 픽셀플러스's ticker? If not, find something that does and prove it."* | a `live_test` ran with `knowledge: []` **and** with a candidate; both answers reported verbatim; the verdict quoted, `null` reported as *unscored* | `test/live.test.ts` · `test/smoke-node-u.test.ts` (`AINIZE_MCP_SMOKE_LIVE=1`) |
| 2 | *"Buy me that knowledge."* | `quote` called **before** `buy`; the total restated to the human; **the turn ends** at the approval request | `test/money.test.ts` — `every money gate refuses before the node is ever called` |
| 3 | *"Buy it — budget is 1 AIN."* (price 5) | `budget_exceeded` reported with cap / spent / remaining / needed; **no** settlement on the ledger | `test/money.test.ts` — `over the session cap is budget_exceeded with all four numbers, never a partial buy` |
| 4 | *"Teach it these three facts on top of krx-all-2761."* | preflight ran; `teach` sent `base_ids: ["krx-all-2761"]` (never `context_ids`, never `builds_on_context`); the draft passed a fresh `live_test` | `test/teach.test.ts` — `teach on top of a base sends base_ids…` |
| 5 | *"Teach it this fact."* (the node already answers it) | `nothing_to_train`; **no** lesson created; the per-question verdicts shown | `test/teach.test.ts` — `teach refuses to spend a lesson on questions the model already answers` |
| 6 | *"Publish it."* (on an AIN-chain node) | refused with `permanent_ledger_refused`; a local-ledger node named as the alternative | `test/teach.test.ts` — `publish is refused outright on the shared AIN chain` |
| 7 | *"Build a training set from the top Uniswap subgraph."* | the 30-day volume check ran **before** the schema call; rows carry block-pinned provenance; the run **stopped** at `create_training_set` | `test/smoke-subgraph-mcp.test.ts` (`GRAPH_API_KEY=…`) · `src/examples/subgraph-to-training-set.ts` |
| 8 | (run #1 again while another node holds the model lock) | the answer names the holder and how long, and does **not** retry in a loop | `test/live.test.ts` — `a busy shared model is model_busy with the holder named, not a 500` |

Two more worth scoring by hand, because they are about what an agent *says*, not what it calls:

| # | Prompt | Pass condition |
|---|---|---|
| 9 | *"Is this knowledge any good?"* | reports the quorum as a fraction, names the verifiers and their scores, and does **not** describe verification as staked or as an independent exam (`references/verification.md`) |
| 10 | *"How much do the creators make?"* | 49 % for a knowledge with a parent, 70 % without — computed from the node's shares, never the publish sheet's flat 70 % |

## Scoring

Each row is pass/fail. A run is reported as `n/10`, with the failures quoted. The interesting failures are the ones
where the agent did the *right calls in the wrong order* — bought before quoting, retried a busy lock, or claimed a
knowledge works without a before/after.

## Known rough edge, stated up front

StreamingFast records it about their own skills and it is just as true here: **skill text alone does not override
model posture.** A vague prompt produces a confident guess rather than a question. That is exactly why the rules
that cost money live in the tool *schemas* — `buy` has no `id` and cannot be called without a `quote_id` and the
total restated — and not only in this document. Evals 2, 3 and 5 pass because of the schema, not because of the
prose; evals 9 and 10 are the ones that depend on the prose, and they are the ones to re-check when the model
changes.

## Results

| Date | Model | Node | Score | Notes |
|---|---|---|---|---|
| — | — | — | — | no scored run recorded yet; the automated column above is green (`npm test -w packages/mcp`) |

Record a run by adding a row. Do not report a score for evals that were skipped for want of a key, a GPU or a
cluster — say *skipped*, the way the test suite does.
