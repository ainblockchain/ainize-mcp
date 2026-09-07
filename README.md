# `@ainize/mcp` — Ainize as an MCP server, and as an MCP client

`ainize-mcp` puts the Ainize knowledge marketplace behind the Model Context Protocol, so Claude Code, Cursor and any
other MCP client can do the five things the product exists for:

- **find** knowledge — trained memory-table patches a node applies into a running LLM;
- **prove** it — the same question answered twice, by the bare model and by the model with the knowledge loaded,
  together with who verified it and with what score. This is the signature capability and the hardest thing to fake;
- **price** it honestly — a quote that includes the base stack a delta child needs, and a session budget the model
  cannot raise;
- **buy** it over x402 — quote → explicit confirm → settle, journalled so a retry can never pay twice;
- **teach** it something permanently — questions and answers become a knowledge, optionally *on top of* an existing
  one, and the result says what the model learned and what it did not.

It is also an MCP **client**: `McpDataSource` connects to somebody else's MCP server, runs a query you specify, maps
the answer into the same `{prompt, answer}` rows the teach door eats, and records where every row came from. The
worked example does that against The Graph's hosted Subgraph MCP — live, or not at all.

The design this implements is `docs/mcp-integration-design.md`. The Graph-specific pipelines and the four-arm
benchmark live in `graph/`, per `graph/README.md`; this package owns the seam between the two directions
(`src/rows.ts`, `src/datasource.ts`).

---

## What this server will never do without you

This is the part worth reading before anything else.

1. **It will never spend money without a quote you saw.** `buy` has **no `id` parameter**. What gets bought is
   whatever a `quote` named, the quoted total has to be restated character for character, and `confirm: true` is a
   separate required field so a schema-filling model cannot approve by copying one number.
2. **It cannot spend more than the cap in its own environment.** `AINIZE_MCP_SESSION_BUDGET` is server configuration.
   A tool argument (`max_price`) may only *lower* it for one call. Going over is `budget_exceeded` with the four
   numbers — never a silent clamp, never a partial purchase. With the default budget of `0`, the `buy` tool is not
   registered at all.
3. **It will never pay twice.** An `intent` is journalled before the node is called, a repeat with the same key never
   reaches the node, a knowledge this node already bought is refused with its purchase date and tx hash, and nothing
   in the money tier is ever retried automatically. After any failure, `reconcile_purchase` says which of four things
   happened — `complete`, `settled_no_body`, `recovered`, `never_paid` — without paying anything.
4. **It will never hand the model a secret.** No tool takes or returns a password, a session token, a private key or
   a signature: the input schemas have no field to put one in, and an outbound scrubber redacts anything key-shaped
   from every result *and* every error, including a purchase manifest's download token and an upstream 401 body.
5. **It will never block your agent.** Everything that touches the shared model is a job: call, get a `job_id`, poll
   `job_status`. The model lock is cross-process and the node waits up to 20 minutes on it, so a blocking tool would
   time out in the client, which would retry, which would deepen the very queue it is waiting on.
6. **It will never change a shared model behind your back.** `apply_knowledge` / `remove_knowledge` are not
   registered unless `AINIZE_MCP_ALLOW_APPLY=1`, `remove` needs `confirm: true`, and both say plainly that the change
   is visible to every node on the machine and survives a restart.
7. **It will never publish to a permanent ledger by accident.** `publish_knowledge` is not registered unless
   `AINIZE_MCP_ALLOW_PUBLISH=1`; on a node whose ledger is the shared AIN chain it is refused outright with
   `permanent_ledger_refused`; both consents are required inputs with no default; and the confirmation phrase has to
   contain the lesson id, so a model cannot approve a publish by pattern-matching "yes".
8. **It will never spend a daily lesson on nothing.** A lesson is charged by the node the moment it is submitted and
   is never refunded, so `teach` asks the model what it already knows first and refuses with `nothing_to_train` when
   every probed question is already answered — and it never retries a failed lesson by itself.
9. **It will never turn somebody else's data into training by itself.** The MCP client half stops at a training set.
   Reviewing the rows and spending the GPU are separate, confirmed calls.

### 이 서버가 당신 없이 하지 않는 일 (한국어)

1. **견적 없이는 돈을 쓰지 않습니다.** `buy`에는 `id` 인자가 없습니다. 무엇을 사는지는 `quote`가 정하고, 견적 총액을
   글자 그대로 다시 적어야 하며, `confirm: true`는 별도의 필수 항목입니다.
2. **환경변수의 한도를 넘길 수 없습니다.** `AINIZE_MCP_SESSION_BUDGET`은 서버 설정이고, 도구 인자로는 낮출 수만
   있습니다. 기본값 `0`이면 `buy` 도구 자체가 등록되지 않습니다.
3. **두 번 결제하지 않습니다.** 결제 전에 의도를 기록하고, 같은 키로 다시 부르면 노드까지 가지 않으며, 이미 산
   지식은 구매일과 tx 해시와 함께 거절합니다. 실패했을 때는 재시도가 아니라 `reconcile_purchase`입니다.
4. **비밀은 모델에게 넘어가지 않습니다.** 비밀번호·세션 토큰·개인키·서명을 받는 인자도, 돌려주는 필드도 없습니다.
5. **에이전트를 붙잡아 두지 않습니다.** 모델을 쓰는 모든 작업은 job이고 `job_status`로 확인합니다. 모델이 잠겨
   있으면 누가, 얼마나 오래 잡고 있는지 문장으로 알려줍니다.
6. **공유 모델을 몰래 바꾸지 않습니다.** `apply_knowledge`/`remove_knowledge`는 명시적으로 켜야 하고, 이 기계의 모든
   노드에 영향을 준다는 경고를 함께 돌려줍니다.
7. **오늘의 수업을 헛되이 쓰지 않습니다.** 노드는 제출 순간에 하루 수업 한 번을 차감하고 환불하지 않습니다. 그래서
   `teach`는 먼저 모델이 이미 아는지 물어보고, 전부 알고 있으면 `nothing_to_train`으로 거절합니다. 실패한 수업을
   스스로 다시 돌리지 않습니다.
8. **발행은 되돌릴 수 없습니다.** `publish_knowledge`는 기본으로 꺼져 있고, 공용 AIN 체인 노드에서는 아예 거절하며,
   두 개의 동의와 수업 id가 들어간 확인 문구를 요구합니다. 수익 배분은 발행 화면의 70 %가 아니라 실제 계산값
   (부모가 있으면 49 %)을 보여줍니다.
9. **남의 데이터를 혼자 학습으로 바꾸지 않습니다.** MCP 클라이언트 쪽은 학습 세트까지만 만들고 멈춥니다.

---

## Install and build

```bash
export PATH="$HOME/.local/node/bin:$PATH"      # Node 24
npm install                                     # the workspace picks packages/mcp up automatically
npm run build -w packages/core -w packages/mcp
node packages/mcp/dist/bin.js --help
```

## Configure a client

Secrets belong in your shell profile, never in a checked-in file. `claude mcp add -e …` writes what you pass into
`~/.claude.json`, so pass the *reference*, not the value.

**Claude Code (stdio, recommended for a local node):**

```bash
claude mcp add ainize \
  -e AINIZE_NODE_URL=http://localhost:3422 \
  -e AINIZE_TEACH_KEY="$AINIZE_TEACH_KEY" \
  -e AINIZE_MCP_SESSION_BUDGET=0 \
  -- node /abs/path/knowledge-marketplace/packages/mcp/dist/bin.js
```

**Streamable HTTP (one process, several clients):**

```bash
node packages/mcp/dist/bin.js --http 3499
claude mcp add --transport http ainize http://127.0.0.1:3499/mcp
```

`--http` **refuses to start** with a non-zero budget or with `ALLOW_APPLY` / `ALLOW_PUBLISH` set, unless you also
pass `--i-am-the-only-user`: a port is reachable by people who are not the operator.

**Cursor / Claude Desktop / Windsurf** (`~/.cursor/mcp.json` or the app's config) and a project `.mcp.json` use the
same object shape — a commented, ready-to-paste version of both blocks is in
[`client-config.example.json`](client-config.example.json):

```jsonc
{
  "mcpServers": {
    "ainize": {
      "command": "node",
      "args": ["/abs/path/knowledge-marketplace/packages/mcp/dist/bin.js"],
      "env": { "AINIZE_NODE_URL": "http://localhost:3422", "AINIZE_MCP_SESSION_BUDGET": "0" }
    }
  }
}
```

### Configuration

| Env | Meaning | Default | Ever returned? |
|---|---|---|---|
| `AINIZE_NODE_URL` | the node this server speaks for — **configuration, not a tool argument** | `http://localhost:3422` | yes (it is public) |
| `AINIZE_OPERATOR_PASSWORD` | exchanged once at startup for an in-memory bearer | — | **never** |
| `AINIZE_TOKEN` | an existing operator session token instead of the password | — | **never** |
| `AINIZE_TEACH_KEY` | 64-hex teaching key, or a path to the key-backup JSON | — | **never** (its address is public) |
| `AINIZE_MCP_SESSION_BUDGET` | total spend allowed for the life of this process | `0` → `buy` is not registered | yes |
| `AINIZE_MCP_MAX_PER_PURCHASE` | ceiling for one purchase | the session budget | yes |
| `AINIZE_MCP_MAX_TEACH_JOBS` | daily lessons this server may spend | `1` | yes |
| `AINIZE_MCP_ALLOW_APPLY` | register `apply_knowledge` / `remove_knowledge` | off | yes |
| `AINIZE_MCP_ALLOW_PUBLISH` | register `publish_knowledge` (irreversible) | off | yes |
| `AINIZE_MCP_ALLOW_AIN_PUBLISH` | also allow it on a node whose ledger is the shared AIN chain | off | yes |
| `AINIZE_MCP_STATE_DIR` | where the purchase journal and the provenance records are persisted (mode 0600) | memory only | no |
| `AINIZE_MCP_DOWNLOAD_DIR` | where `download_lesson` writes files | `<state dir>/lessons`, else the temp dir | yes (the path) |
| `AINIZE_MCP_MAX_DOWNLOAD_MB` | ceiling for one downloaded artefact | `512` | yes |
| `AINIZE_MCP_POLL_MS` | how often a running lesson is re-read from the node | `3000` | no |
| `GRAPH_API_KEY` | The Graph gateway key — used by the MCP **client** example only, never by a tool | — | **never** |
| `AINIZE_MCP_CONFIG` | a JSON file with the same keys in snake_case; env wins over it | — | no |

## Which node to point at

| Node | URL | Ledger | Safe for |
|---|---|---|---|
| **node-u** | `http://localhost:3422` | `local` | everything — the default in every example |
| node-a / b / c | `:3402` `:3403` `:3404` | **`ain` (shared chain)** | reading, quoting and live tests |
| a private cluster | `AINIZE_CLUSTER_HOME=<tmpdir> AINIZE_PORT_BASE=3512 AINIZE_LEDGER=local AINIZE_SEED=0 scripts/cluster-restart.sh` | `local` | end-to-end money tests |

**All of them share one model server** (`http://localhost:8002`). A live test run from an MCP client is therefore
visible to every other node on the machine, and anything *applied* changes the "before" column of everyone else's
live test until it is removed.

---

## The skill — for an agent that has to do this well

[`SKILL.md`](SKILL.md) is the agent-facing half of this package, written in the shape The Graph uses for its
[subgraph](https://github.com/graphprotocol/subgraphs-skills) and
[Substreams](https://github.com/streamingfast/substreams-skills) skills: ~100 tokens of frontmatter, a body under
5,000 tokens, and everything deep in [`references/`](references). It states the two safety tiers, the five
workflows (*find · prove · buy within a budget · teach · teach from a subgraph*), and the two hard rules — never
print a credential, never background-poll a human decision.

| File | Contents |
|---|---|
| [`SKILL.md`](SKILL.md) | the hub: when to use it, the tiers, the workflows, worked examples, troubleshooting |
| [`references/money.md`](references/money.md) | x402, quote → confirm → settle, caps, idempotency, reconcile, the 49 % split |
| [`references/live-test.md`](references/live-test.md) | modes, the shared-model caveat, quota arithmetic, reading a `verdict` |
| [`references/teach-and-lineage.md`](references/teach-and-lineage.md) | both doors, `base` vs `compare_with`, the 13 states, publish consent |
| [`references/verification.md`](references/verification.md) | quorum, attestations, challenges, what "verified" is not |
| [`references/errors.md`](references/errors.md) | every code, `retryable`, and the recovery |
| [`references/subgraph-to-dataset.md`](references/subgraph-to-dataset.md) | direction B end to end, provenance, the volatility rule |
| [`references/cli.md`](references/cli.md) | the equivalent `ainize` CLI commands |
| [`EVAL.md`](EVAL.md) | eight plain-English prompts and their mechanical pass conditions — re-runnable by a judge |

`scripts/validate-skill.mjs` checks the frontmatter, the token budget, that every `references/*.md` is linked and
that every tool the body names is actually registered; `npm test -w packages/mcp` runs it, so the skill cannot drift
away from the server. Packaging metadata for `claude plugins add` is in
[`.claude-plugin/`](.claude-plugin/plugin.json); publishing it as a marketplace additionally needs
`.claude-plugin/marketplace.json` copied to the **repository root** of a public repo, which is why the file here
declares its plugin source as `./packages/mcp`.

A skill is guidance, not enforcement — StreamingFast's own EVAL says it plainly: *skill text alone does not override
model posture.* That is why "quote before you buy" is a required `quote_id` in the `buy` schema and not a sentence
in a document.

---

## The tools

| Tool | Tier | Costs | Blocks? | Registered |
|---|---|---|---|---|
| `search_knowledge` | READ | free | < 100 ms | always |
| `get_knowledge` | READ | free | < 100 ms per include | always |
| `family_tree` | READ | free | < 1 s | always |
| `get_training_set` | READ | free | < 100 ms | always |
| `node_status` | READ | free | < 100 ms (`refresh` adds a probe) | always |
| `my_library` | READ | free | < 200 ms | always (sections omitted with a reason) |
| `knowledge_signals` | READ | free | < 200 ms | always |
| `teacher_profile` | READ | free | < 100 ms | always |
| `live_test` | MODEL | free, 1 of 20/hour **shared** | no — job handle | when the node serves a model |
| `job_status` / `job_list` | READ | free | ≤ `wait_ms`, locally | always |
| `job_cancel` | MODEL | free | < 200 ms | always |
| `create_training_set` | MODEL | free (row/byte quota) | < 1 s | teaching key + teach enabled |
| `teach_preflight` | MODEL | free live-test units ×2 buckets | no — job handle | teaching key + teach enabled |
| `teach` | MODEL | **one daily lesson, non-refundable** | no — job handle | teaching key + teach enabled |
| `download_lesson` | MODEL | free | seconds | teaching key + teach enabled |
| `apply_knowledge` / `remove_knowledge` | MODEL | free | no — job handle | `AINIZE_MCP_ALLOW_APPLY=1` |
| `publish_knowledge` | PERMANENT | free of money, **irreversible** | seconds | `AINIZE_MCP_ALLOW_PUBLISH=1` |
| `quote` | MONEY (read) | free | < 1 s | always |
| `buy` | MONEY | **real money** | no — job handle | operator + non-zero budget |
| `reconcile_purchase` | MONEY (read) | free | seconds | operator configured |

Deliberately absent: `verify`, `challenge`, `announce`, `forget`, `runtime_complete`, peers, chain setup, policy,
bans. They are minutes-long, network-visible or destructive, and an agent has no business driving them.

### The workflow the server asks for

Served as `ainize://instructions` and as the server's `instructions` on connect:

1. **Before you claim a knowledge helps, prove it** — ONE `live_test` naming the candidate in `knowledge`; it
   answers both columns under one hold of the shared model lock. Two separate calls are not equivalent: a
   `knowledge: []` call unloads nothing, so a knowledge another process left on the model answers with the base.
2. **Before you spend, quote** — show the total, the base stack and the remaining budget, then **stop**.
3. **Before you teach, preflight** — a daily lesson is scarce and is not refunded. `teach` does this for you.
4. **Everything that touches the model is a job** — poll `job_status`; if the model is held, report *who* and *how
   long* instead of retrying.
5. **Never print a token, key, password or signature.**
6. **Never background-poll a human decision.** The turn that asks for approval ends.
7. **When something is not implemented, say so** — `family_tree` edge kinds, per-knowledge signals and bundle buys
   return `null` with a note. Report the note; do not invent the number.

### Resources

`ainize://instructions` · `ainize://node/info` · `ainize://budget` · `ainize://openapi` (with a header saying the
node's OpenAPI document is hand-written and incomplete — never generate tools from it).

### Errors

Every failure an agent can act on comes back as a normal tool result with `isError: true` and
`{ code, message, retryable, retry_after_ms?, details }`. The node's own codes are passed through unrewritten
(`quota_chat`, `base_retired`, `dataset_private`, …). The codes this layer adds:

| Code | Meaning | Retryable |
|---|---|---|
| `quote_required` | `buy` was called without a `quote_id` | no |
| `quote_expired` | the quote is older than 10 minutes, or unknown | no |
| `quote_mismatch` | the restated total, or the live price, does not match the quote | no |
| `confirmation_required` | `confirm: true` (or `remove_knowledge`'s confirmation) is missing | no |
| `budget_exceeded` | over the session cap; `details` carries cap/spent/remaining/needed | no |
| `per_purchase_cap_exceeded` | over `AINIZE_MCP_MAX_PER_PURCHASE` or the call's `max_price` | no |
| `already_purchased` | this node already bought it; nothing was charged | no |
| `idempotency_replay` | the same key was already used — replays the result, or sends you to reconcile | no |
| `nothing_to_train` | every probed question is already answered correctly, so no lesson was submitted | no |
| `teach_quota_consumed` | the lesson failed (or the session lesson cap is spent); the day's lesson is gone either way | no |
| `base_rejected` / `base_retired` | the knowledge you asked to build on cannot be a base (rejected, challenged, superseded) | no |
| `permanent_ledger_refused` | publishing was aimed at the shared AIN chain, where nothing can be recalled | no |
| `model_busy` | the shared runtime lock is held; the message names the holder | yes (30 s) |
| `job_not_found` | jobs are session-scoped and evicted 30 minutes after they finish | no |
| `node_unreachable` | the node did not answer at all | yes |
| `capability_disabled` | reserved: a capability this server was not configured for (today such tools are simply not registered) | no |

Two node answers are **outcomes, not errors**: HTTP 499 `{cancelled, charged:false}` (a live test given up while
queued) and a quote of a knowledge that is already owned.

---

## The async model — start, poll, cancel

Nothing that touches the model is a blocking call. The shared runtime lock is cross-process and the node waits up
to **20 minutes** on it, so a blocking tool would hit the client's timeout, the client would retry, and the retry
would open another queue ticket behind the one it was waiting on.

```
live_test / teach / teach_preflight / apply_knowledge / remove_knowledge / buy
    → { job_id, state: "queued", poll_after_ms, model_lock: { sentence }, … }        in ~100 ms
job_status { job_id, wait_ms: 25000 }                                                 → the next state change
job_cancel { job_id }                                                                 → charged: true | false
job_list {}                                                                           → what this session started
```

- **`wait_ms` long-polls inside this server.** It never holds a request open on the node; it waits for a state
  change locally and answers as soon as one happens. A queued job usually needs two calls (queued → running →
  done), which is what you want: the intermediate answer carries progress.
- **Jobs are session-scoped** and evicted 30 minutes after they finish (`job_not_found` after that). A lesson can
  also be polled by its *node* lesson id, so a conversation that lost its `job_id` is not stuck.
- **Every job answer names the holder of the model**, computed against the node's own clock:
  `"the model is held by pid:2658057 (a live test of krx-all-2761) for 8 s"`, plus `queue.waiting`.
- **Cancelling a queued live test is genuinely free** (`charged: false`); cancelling a running one is not, and the
  answer says so. Cancelling a lesson never gives the daily lesson back.
- **`buy` is a job too**, because a blob download can take minutes. Its failure path is `reconcile_purchase`, never
  a retry.

## Every tool, with an example call and answer

Answers are abridged with `…`; every field shown is real. The examples marked *(node-a)* / *(node-u)* were captured
from the running cluster on 2026-09-04; the rest come from the request-recording fake node the test suite uses
(`test/fake-node.ts`), which answers with the node's own shapes.

### `search_knowledge` — browse and search *(node-a)*

```jsonc
search_knowledge { "query": "ticker", "limit": 3 }
// also: model, schema, status, author, origin ("operator" | "teach"), sort ("latest"|"popular"|"price"|"rows"), offset
```
```jsonc
{ "total": 4, "shown": 3, "offset": 0,
  "items": [{
    "id": "krx-all-2761", "name": "KRX ticker codes for 2,761 listed companies (final)",
    "description": "All 2,761 ticker codes of companies listed on the Korea Exchange…",
    "price": "25", "currency": "AIN", "rows": 270053, "size_mb": 331.7,
    "status": "LISTED", "downloads": 93, "quorum": "2/2", "quorum_ok": true, "sellable": true,
    "author_name": "node-a", "taught_by": null, "model": "Qwen3.8-Flash-Next", "schema": "krx-ticker-codes",
    "origin": "operator", "is_addon": false, "requires_count": 0, "node_url": "http://localhost:3402"
  }, … ],
  "facets": { "models": ["Qwen3.8-Flash-Next"], "schemas": ["krx-ticker-codes"] } }
```

### `get_knowledge` — detail, verifiers, lineage, base stack *(node-a)*

```jsonc
get_knowledge { "id": "krx-all-2761", "include": ["records", "events", "benchmark_siblings"] }   // include is optional
```
```jsonc
{ "knowledge": { "id": "krx-all-2761", "price": "25", "status": "LISTED", "topic_path": "finance/krx",
                 "benchmark_queries": 2761, "supersedes": ["krx-all-2761-ep12", "krx-all-2761-ep6", "pixelplus-087600"],
                 "superseded_by": [], … },
  "verification": { "quorum": "2/2", "quorum_ok": true, "sellable": true, "open_challenge": null,
    "attestations": [ { "verifier_name": "node-b", "passed": true,
                        "score": { "free_generation": "26/26", "pre_apply": "1/8" },
                        "verified_on": "vllm:Qwen3.8-Flash-Next" }, … ] },
  "lineage": { "parents": [{ "id": "krx-all-2761-ep12", "status": "SUPERSEDED" }], "children": [] },
  "requires": [], "requires_note": null,
  "availability": { "has_body": true, "purchased": false, "owned": true, "applied": false,
                    "gateway_url": "http://localhost:3402/x402/patch/krx-all-2761" },
  "training_set": null }
```

### `family_tree` — the version and derivation graph *(node-a)*

```jsonc
family_tree { "id": "krx-all-2761", "depth": 2 }
```
```jsonc
{ "root": "krx-all-2761",
  "nodes": [{ "id": "krx-all-2761", "status": "LISTED", "added": null, "signals": null }, … ],
  "edges": [{ "from": "krx-all-2761", "to": "krx-all-2761-ep12", "kind": "extends" },
            { "from": "krx-all-2761", "to": "pixelplus-087600", "kind": "supersedes" }, … ],
  "truncated": false,
  "note": "Edge kinds beyond extends/supersedes, per-node `added` counts and usage signals are not recorded by the node yet (lineage design §12.5, PR L6). `added` and `signals` are null, not 0 — do not report a number here." }
```

### `get_training_set` — what a knowledge was built from

```jsonc
get_training_set { "id": "k1", "rows": false, "limit": 20 }    // rows: true streams the real rows (public access only)
```
```jsonc
{ "id": "k1", "sha256": "dddd…", "rows_total": 2761, "access": "public", "license": "CC-BY-4.0",
  "parents": [], "held": true, "include_notes": false, "merkle_root": null,
  "preview": [{ "prompt": "Q", "answer": "A" }, …], "rows": null }
```
Access levels: `public` (open) · `derivative` (a teaching key only — this server signs with its own) · `private`
(refused, with the metadata in the error body).

### `node_status` — the node, the model, the lock, the caps *(node-a)*

```jsonc
node_status { "refresh": false }     // refresh: true forces a runtime probe (~3 s)
```
```jsonc
{ "node": { "name": "node-a", "ledger": "ain", "roles": ["seller","verifier","serving"], "quorum": 2,
            "currency": "AIN", "model": "Qwen3.8-Flash-Next", "balance": "3374.29…",
            "royalty_share": 0.3, "contributor_share": 0.7, "peers": 2,
            "counts": { "patches": 4, "listed": 1, "superseded": 3 }, "applied": [] },
  "runtime": { "available": true, "api": "http://localhost:8002", "hook": true, "applied": [] },
  "model_lock": { "holder": { "owner": "pid:2658057", "label": "chat:krx-all-2761", "held_s": 1, "mine": true },
                  "queue": { "running": 1, "waiting": 0 },
                  "sentence": "the model is held by pid:2658057 (a live test of krx-all-2761) for 1 s" },
  "quota": { "live_tests_remaining": null, "limit": 20,
             "note": "the node has no quota endpoint — the remaining count is only known after a live test answers…" },
  "teach_policy": { "enabled": true, "publish": "auto", "trainer": "ready", "backend": "stub", "limits": { … } },
  "capabilities": { "can_read": true, "can_live_test": true, "can_teach": false, "can_buy": false,
                    "can_apply": false, "can_publish": false },
  "capability_reasons": { "can_buy": "no operator credential is configured on this MCP server…", … },
  "budget": { "cap": "0", "spent": "0", "remaining": "0", "currency": "AIN" },
  "warnings": ["this node is on the shared AIN chain: publishing and announcing are refused by this server unless explicitly allowed"] }
```

### `my_library` — what this node owns, bought, taught and earned

```jsonc
my_library { "include": ["purchases", "published", "applied", "lessons", "datasets"] }   // all five by default
```
```jsonc
{ "purchases": [{ "id": "k1", "amount": "5", "currency": "CREDIT", "tx_hash": "0x…", "bought_at": 1788…, "body_present": true }],
  "published": [ /* flat knowledge rows */ ], "applied": [], "lessons": [], "datasets": [],
  "omitted": [{ "section": "purchases", "reason": "no operator credential is configured on this MCP server" }],
  "teaching_key_address": "0x2999…" }
```
The stored **manifest is never returned** — it carries a download token. The tx hash is.

### `knowledge_signals` — usage, honestly

```jsonc
knowledge_signals { "id": "k1", "limit": 20 }
```
```jsonc
{ "id": "k1", "downloads": 93, "revenue": "2325",
  "verification": { "quorum": "2/2", "attestations": [ … ] },
  "events": [{ "ts": 1, "level": "info", "kind": "usage", "message": "live test k1" }],
  "signals": null,
  "note": "GET /api/patches/:id/signals and /issues are PR L6 and do not exist yet: `signals` is null, not zero. Events are redacted for non-operators, and everything here is what this one node recorded — not network truth." }
```

### `teacher_profile` — a data provider's public page

```jsonc
teacher_profile { "address": "0x2222…" }
```
```jsonc
{ "address": "0x2222…", "name": "a teacher", "lessons": [ … ],
  "earnings": { "total": "0", "currency": "CREDIT" } }
```

### `live_test` → `job_status` — the before/after *(node-a, real run)*

```jsonc
live_test { "question": "픽셀플러스 종목코드 알려줘. 숫자만.", "knowledge": ["krx-all-2761"], "mode": "compare" }
```
```jsonc
// 91 ms
{ "job_id": "lt_3e19184626c3", "kind": "live_test", "state": "queued", "poll_after_ms": 1500,
  "model_lock": { "sentence": "the model is held by pid:2658069 (a live test of krx-all-2761) for 7 s" },
  "applied_on_this_model": [],
  "quota": { "metered": true, "live_tests_remaining": null, "limit": 20, "note": "…20 per rolling hour per visitor IP, shared by everyone using this MCP server." },
  "next": "call job_status with this job_id (wait_ms lets one call cover the whole wait)" }
```
```jsonc
job_status { "job_id": "lt_3e19184626c3", "wait_ms": 90000 }
```
```jsonc
// 18.9 s later
{ "state": "done", "elapsed_ms": 18828,
  "result": {
    "before": { "answer": "058420", "latency_ms": 406, "truncated": false },
    "after":  { "answer": "087600", "latency_ms": 378, "truncated": false },
    "changed": true, "verdict": null,
    "knowledge": [{ "id": "krx-all-2761", "applied_ms": 3789, "was_already_applied": true,
                    "verification": { "quorum": "2/2", "attestations": [ /* node-b 26/26, node-c 26/26 */ ] } }],
    "apply_ms_total": 3789,
    "quota": { "metered": true, "remaining": 17, "limit": 20, "note": "free live tests are metered per visitor IP — this bucket is shared by everyone using this MCP server" },
    // with AINIZE_OPERATOR_PASSWORD set, this reads instead:
    // "quota": { "metered": false, "remaining": null, "limit": null, "note": "not metered: this server signs its live tests in as the node's operator…" },
    "caveats": ["this question is not in the knowledge's own benchmark, so the comparison is unscored — report it as a comparison, not as a verified result"] } }
```

### `job_cancel` · `job_list`

```jsonc
job_cancel { "job_id": "lt_…", "reason": "the user changed the question" }
→ { "job_id": "lt_…", "kind": "live_test", "cancelled": true, "reason": "queued", "charged": false,
    "note": "nothing had reached the model, so nothing was charged" }
// once it is running:  "reason": "already_running", "charged": true,
//   "note": "the node had already started this on the model: the work and the metered try stand…"
// a lesson:            "charged": true,
//   "note": "the lesson is cancelled, but the daily lesson it consumed is NOT returned — the node charges one at submit time…"

job_list { "kind": "teach", "state": "running", "limit": 20 }
→ { "jobs": [{ "job_id": "th_…", "kind": "teach", "state": "running", "native_state": "TRAINING",
               "summary": "MCP docs demo", "started_at": 1788…, "finished_at": null }, …] }
```

### `create_training_set` *(node-u, real run)*

```jsonc
create_training_set {
  "rows": [{ "prompt": "What is the internal code name of the Ainize MCP bridge?", "answer": "aincp-3" },
           { "prompt": "Which port does the Ainize teach demo node listen on?", "answer": "3422" }],
  "name": "MCP docs demo", "retention": "keep",
  "provenance": { /* from McpDataSource, optional */ } }
```
```jsonc
{ "dataset_id": "43647481-78ed-46b5-8b40-dc92272442ff", "existing": false, "rows_accepted": 2, "rows_rejected": [],
  "sha256": "67c1b685259a898c9f92ff6a8deedbfa9a2900e8bc3ca016d66840433a143890",
  "predicted_sha256": "67c1b685…", "sha256_matches_prediction": true, "revision": 1, "size_bytes": 172,
  "summary": { "source_rows": 2, "accepted": 2, "duplicates": 0, "conflicts": 0, "too_long": 0, "langs": { "latin": 2, … } },
  "note": "a new training set was created on the node" }
```

### `teach_preflight` → `job_status` *(node-u, real run)*

```jsonc
teach_preflight { "dataset_id": "43647481-…" }        // or { rows: [...] }, plus base / compare_with
→ { "job_id": "tp_28da33a8a678", "state": "queued",
    "cost": "free of money; it spends at least one of the 20 free live-test units per hour, charged to this server's IP and to the teaching key" }
```
```jsonc
job_status { "job_id": "tp_28da33a8a678", "wait_ms": 120000 }
→ { "state": "done", "result": {
      "trainable": 2, "checked": 2,
      "sampled": { "checked": 2, "of": 2, "note": "a sample of the training set, not the whole of it — the node probes at most 8 questions per call" },
      "items": [{ "question": "What is the internal code name of the Ainize MCP bridge?", "expected": "aincp-3",
                  "status": "will_train", "model_said": "(stub model) I do not know: …",
                  "meaning": "the model gets this wrong today — teaching it is worth a lesson" }, … ],
      "lessons_left_today": { "key": 20, "address": 0 },
      "cost_note": "this preflight spent free live-test units (one per three model calls, at least one)…" } }
```
*(node-u runs the stub trainer, so `model_said` is stubbed. The shape is identical on a GPU node.)*

### `teach` → `job_status`

```jsonc
teach { "rows": [{ "prompt": "…", "answer": "…" }], "base": ["krx-all-2761"], "mode": "extend",
        "export": "delta", "effort": "balanced", "dry_run": false, "confirm": false }
```
```jsonc
{ "job_id": "th_5c018e8ae834", "state": "queued", "poll_after_ms": 3000,
  "built_on": [{ "id": "base1", "status": "LISTED", "price": "5", "body_held": false, "training_set": "public", "problem": null }],
  "mode": "extend", "export": "delta",
  "lessons": { "limit": 3, "used_today": 0, "remaining": 3, "session_cap": 3, "session_spent": 1 },
  "what_happens_next": "the training set is uploaded, the model is asked what it already knows (that is the preflight), and the lesson is submitted only if something is left to teach",
  "eta_note": "no measured estimate yet — job_status carries the node's own ETA once the lesson is queued" }
```
```jsonc
job_status { "job_id": "th_5c018e8ae834", "wait_ms": 25000 }
→ { "state": "done", "node_job_id": "lesson-1", "result": {
      "native_state": "READY", "what_is_happening": "ready: the lesson stuck and passed its checks",
      "eta_s": null, "eta_note": "no measured estimate yet", "progress": null,
      "questions": { "in_the_lesson": 1, "measured": 1, "learned": 1, "not_learned": 0,
                     "still_wrong": [], "taught": [{ "question": "Q1?", "answer": "A1", "alt_phrasing_ok": true }] },
      "checks": { "taught": { "hits": 1, "of": 1, "percent": 100 },
                  "other_phrasing": { "hits": 1, "of": 1, "percent": 100 },
                  "did_not_break_the_base": { "ok": true, "hits": 10, "of": 10 },
                  "did_not_change_unrelated_answers": { "ok": true, "same": 20, "of": 20 },
                  "reversible": null, "publish_gate": "open",
                  "note": "this node trains with the STUB backend: these numbers were simulated, nothing was measured in a live model" },
      "training_set": { "id": "ds_1", "sha256": "…", "rows": 1, "trained_rows": 1 },
      "knowledge_file": { "sha256": "…", "rows": 1, "size_bytes": 1024 },
      "draft_id": "taught-draft-1", "publish_status": "none",
      "next_steps": ["live_test with knowledge: [\"taught-draft-1\"] — prove the new answer against the bare model…",
                     "download_lesson — …the draft stays private until you publish it",
                     "publish_knowledge — irreversible: it writes a record on the ledger and offers the knowledge for sale"],
      "quota": { "key_remaining": 2, "ip_remaining": 5, "rows_remaining": 300 } } }
```

The refusals are the interesting part:

```jsonc
teach { "rows": [ /* things the model already answers */ ] }
→ isError: true
  { "code": "nothing_to_train",
    "message": "the model already answers all 3 probed questions correctly — no lesson was submitted and none was spent.",
    "retryable": false, "details": { "items": [ /* per-question verdicts */ ] } }

teach { … }            // when the key has one lesson left today
→ { "code": "confirmation_required",
    "message": "this is the last lesson this teaching key has on http://localhost:3422 today (2 of 3 used), and a lesson that fails is not refunded…" }

teach { "base": ["a", "b"] }
→ { "code": "merge_not_available", "message": "combining two knowledges is a merge, and no node supports it yet — build on one of them." }
```

### `download_lesson` — keep it private

```jsonc
download_lesson { "lesson_id": "lesson-1", "include": ["knowledge_file", "recipe", "notes"] }   // all three by default
→ { "lesson_id": "lesson-1", "directory": "/…/lessons/lesson-1",
    "files": [{ "what": "knowledge_file", "path": "/…/lesson-x.npz", "bytes": 1024 },
              { "what": "recipe", "path": "/…/recipe.json", "bytes": 312 },
              { "what": "notes", "path": "/…/RUN-LOCALLY.md", "bytes": 2048 }],
    "knowledge": { "sha256": "eeee…", "rows": 3, "size_bytes": 1024, "filename": "lesson-x.npz", "model": "Qwen3.8-Flash-Next" },
    "privacy": "this lesson is still a private draft on the node: nothing was published, nothing was announced, and nobody else can see it.",
    "note": "the node's download links carry a short-lived token, which is a credential — this server used them and did not return them." }
```

### `publish_knowledge` — irreversible, opt-in

```jsonc
publish_knowledge { "lesson_id": "lesson-1", "name": "X", "description": "…", "price": "5",
                    "license": "CC-BY-4.0", "training_set": { "access": "derivative", "source": "own", "no_pii": true },
                    "dry_run": true }
```
```jsonc
{ "dry_run": true,
  "lesson": { "id": "lesson-1", "status": "READY", "built_on": [] },
  "would_publish": { "name": "X", "price": "0", "currency": "CREDIT", "license": null, "training_set": null },
  "split_preview": { "to_the_people_it_was_built_on": { "amount": "0", "applies": false, "note": "no parent, so no lineage pool" },
                     "to_you_the_teacher": { "of_what_is_left": "70%" },
                     "explanation": "70% of the price, because this knowledge has no parent to pay." },
  "ledger": "local",
  "confirm_phrase_required": "publish lesson-1 permanently",
  "note": "nothing was written. Show the human the split and the fact that this cannot be undone, wait for them, then call again with both consents and the confirmation phrase." }
```
With a parent, `explanation` reads *"49% of the price: a lineage pool of 30% is paid to what it was built on first"*
— the real number, never the publish sheet's flat 70 %. The live call additionally needs
`consent_permanent: true`, `consent_rights: true` and the exact `confirm_phrase`, and is refused with
`permanent_ledger_refused` on a node whose ledger is `ain`.

### `quote` — the honest total, free *(node-b, a real 25 AIN knowledge against a 10 AIN cap)*

```jsonc
quote { "id": "krx-all-2761", "dry_run": true }     // dry_run prices from the catalogue and reserves no nonce
```
```jsonc
{ "quote_id": "q_16b6e28da2a3", "expires_at": 1788516643556, "binding": false, "dry_run": true,
  "items": [{ "id": "krx-all-2761", "role": "requested", "price": "25", "currency": "AIN", "status": "LISTED",
              "superseded_by": null, "license": null, "seller": "0xF7A9…", "quorum": "2/2", "sellable": true,
              "already_purchased": false, "owned": false, "body_held": true,
              "gateway_url": "http://localhost:3402/x402/patch/krx-all-2761" }],
  "total_requested": "25", "total_with_bases": "25",
  "budget": { "cap": "10", "spent": "0", "reserved": "0", "remaining": "10", "per_purchase_cap": "10" },
  "affordable": { "requested": false, "with_bases": false, "shortfall": "15",
    "explanation": "krx-all-2761 alone costs 25 AIN and does not fit. With the bases it needs the honest total is 25 — 15 over your remaining 10. Buy the add-on now and it sits unusable until the base is bought, raise AINIZE_MCP_SESSION_BUDGET, or look for a stand-alone knowledge that covers the same questions." },
  "confirm_with": { "tool": "buy", "quote_id": "q_16b6e28da2a3", "confirm_total": "25", "confirm": true },
  "next": "show the human the total, the bases and the remaining budget, then STOP. Never call buy in the same turn you first learned the price." }
```
Without `dry_run` the answer is `binding: true` and each item also carries `scheme`, `pay_to` and `nonce` from the
seller's own 402.

### `buy` — settles a quote, and only a quote

```jsonc
buy { "quote_id": "q_876cc6d685ec", "confirm_total": "5", "confirm": true, "dry_run": true }
→ { "dry_run": true, "would_buy": "k1", "amount": "5", "currency": "CREDIT",
    "gates_passed": ["quote present and unexpired", "total restated exactly", "confirm: true",
                     "not already purchased", "quorum met", "not challenged", "price unchanged",
                     "within the session cap"],
    "note": "nothing was called on the gateway and no nonce was reserved. Re-run without dry_run to settle." }
```
```jsonc
buy { "quote_id": "q_876cc6d685ec", "confirm_total": "5", "confirm": true }   // optional: apply, max_price, idempotency_key
→ { "job_id": "by_e8dd1778e6b4", "state": "queued", "patch_id": "k1", "amount": "5",
    "idempotency_key": "q:896b97cf…",
    "budget": { "cap": "10", "spent": "0", "reserved": "5", "remaining": "5" },
    "next": "poll job_status. If it fails or times out, do NOT buy again — call reconcile_purchase with this idempotency_key." }

job_status { "job_id": "by_e8dd1778e6b4", "wait_ms": 60000 }
→ { "state": "done", "result": {
      "patch_id": "k1", "amount": "5", "scheme": "local-credit", "tx_hash": "0xbbbb…",
      "body_present": true, "applied": false,
      "steps": [{ "step": "quorum", "detail": "2 attestation(s) ≥ quorum 2" }, { "step": "402", "detail": "payment required" },
                { "step": "settled", "detail": "paid" }, { "step": "download", "detail": "body fetched" }],
      "budget": { "cap": "10", "spent": "5", "remaining": "5" } } }
```

### `reconcile_purchase` — after any failure, instead of paying again

```jsonc
reconcile_purchase { "id": "k1" }        // or { idempotency_key }
→ { "state": "complete",
    "purchase": { "amount": "5", "scheme": "local-credit", "tx_hash": "0x…", "bought_at": 1788…, "body_present": true },
    "explanation": "k1 is paid for and recorded on this node (tx …). Buying it again would pay a second time for nothing." }
```
The four states are `complete` · `settled_no_body` (the money moved, the body did not — carries the tx hash) ·
`never_paid` (a fresh quote → buy is safe) · `recovered`.

### `apply_knowledge` / `remove_knowledge` — off by default

```jsonc
apply_knowledge { "id": "krx-all-2761" }
→ { "job_id": "ap_…", "state": "queued", "patch_id": "krx-all-2761",
    "model_lock": { "sentence": "the model is free" },
    "warning": "this changes the model server every node on this machine shares; the change persists across restarts and is visible to every other user of that model" }

remove_knowledge { "id": "krx-all-2761" }            // without confirm
→ { "code": "confirmation_required",
    "message": "removing krx-all-2761 writes the base model back over every memory row it owns, including rows another loaded knowledge shares — pass confirm: true once the human has agreed." }
```

---

## Teaching, through MCP

The teach door is the half of Ainize that makes new knowledge rather than reselling it, and it is the part an agent
can drive end to end. Four tools, in the order they are meant to be called:

```
create_training_set   rows in → a training set on the node (free, sub-second, de-duped by content)
teach_preflight       ask the model each question FIRST: will_train / already_known / overlaps_listing / invalid
teach                 spend one daily lesson and train it — optionally ON TOP OF an existing knowledge
download_lesson       take the knowledge file, the recipe and the run-it-yourself notes; the draft stays private
publish_knowledge     irreversible, opt-in: announce it on the ledger and offer it for sale
```

**A lesson is scarce like money.** The node charges one of `jobs_per_key_per_day` the moment a lesson is submitted —
before it trains, before it checks — and never refunds it. So:

- `teach` runs the preflight itself and refuses with `nothing_to_train` when every probed question is already
  answered correctly. The per-question verdicts come back in the refusal, and no lesson is spent.
- When the key has one lesson left today, `teach` requires `confirm: true` and says so.
- `AINIZE_MCP_MAX_TEACH_JOBS` caps what one MCP session may spend. It is server configuration; no argument raises it.
- A failed lesson comes back as `teach_quota_consumed`, never as an automatic retry. Spending another one is a
  decision a person makes.
- `dry_run: true` resolves the base, the quota and the rows and reports what *would* happen without uploading,
  probing or training anything.

**`base` is not `compare_with`.** `base` is what the lesson is trained on top of: recorded as a parent for good,
paid a share of every sale, and required by anyone who buys the child. `compare_with` is loaded during the lesson
for comparison only and is recorded nowhere. They map to the node's `base_ids` and `context_ids`; the deprecated
`builds_on_context` is never sent.

```jsonc
teach {
  "rows": [{ "prompt": "픽셀플러스의 종목코드는?", "answer": "087600" }],
  "base": ["krx-all-2761"],        // trained on top of it, and its parent for good
  "mode": "extend",                 // "extend" needs a base; "merge" is not available on any node yet
  "export": "delta",                // "delta" needs the base loaded; "squash" is stand-alone
  "effort": "balanced"
}
```

**Reading the result.** `job_status` on a lesson returns the node's own 13-state machine (`native_state`), one
sentence for what is happening, and — when it lands — *what it learned and what it did not*: every question that
still fails with what the model said instead, the taught/held-out/locality checks, whether the publish gate is open,
and the `draft_id` you can immediately `live_test` against the bare model. A lesson trained on a stub node says
`simulated: true` and the note says nothing was measured in a live model.

**Publishing** shows the real revenue split before it writes anything. With a lineage pool of 0.3 and a contributor
share of 0.7, a knowledge *with a parent* pays its teacher 0.7 × 0.7 = **49 %** of the price, not the 70 % the web
publish sheet prints (`docs/ux-critique-3.json`, item 186). `publish_knowledge` computes it from the node's own
`royalty_share` / `contributor_share`, per `royaltySplit` in `packages/core/src/catalog.ts`, and shows it in
`dry_run` before either consent is asked for.

---

## Ainize as an MCP client — subgraph → training set

`McpDataSource` (`src/datasource.ts`) is the other direction: it connects to somebody *else's* MCP server over SSE,
Streamable HTTP or stdio, calls a tool you name, and hands back both the answer and a provenance record. It maps the
answer into `{prompt, answer}` rows with a declarative mapping, so the mapping is JSON a human can read and re-run —
not a closure buried in a script.

```ts
const source = new McpDataSource({
  name: 'subgraph-mcp',
  transport: { kind: 'sse', url: 'https://subgraphs.mcp.thegraph.com/sse', headers: { Authorization: `Bearer ${key}` } },
});
await source.connect();
const { rows, provenance, rejected } = await source.fetchRows({
  tool: 'execute_query_by_subgraph_id',
  arguments: { subgraph_id: '5zvR82…', query: '{ _meta { block { number } } tokens(first: 20) { id symbol name } }' },
  mapping: {
    path: 'data.tokens',
    prompt: 'What is the {chain} contract address of the {name} ({symbol}) token?',
    answer: '{id}',
    require: ['id', 'symbol', 'name'],
    constants: { chain: 'Ethereum mainnet' },
  },
  upstream: { subgraph_id: '5zvR82…', block: 25903086 },
  note_fields: ['subgraph_id', 'block'],
});
// → create_training_set { rows, provenance }   … and STOP.
```

**Provenance is the point.** `RowProvenance` records the server, the negotiated protocol version, whether a
credential was presented (never the credential), the tool, the exact arguments and their sha256, the block the answer
was pinned to, a hash per row and the sha256 of the canonical JSONL. That last one is *the node's own hash*
(`test/rows.test.ts` holds this implementation to `sha256Rows` in `packages/node/src/teach-dataset.ts`), so a caller
knows the training-set id before uploading and identical rows land on the same training set instead of a second copy.
Because the node's dataset API has no provenance field yet, the compact line goes into each row's own `note` — which
is what a buyer sees when the training set is published with notes — and the full record is written beside the
journal when a state directory is configured.

**The hard stop.** The pipeline ends at `create_training_set`. It never chains into `teach`: one agent turn must not
be able to spend a day's lessons on on-chain data nobody has read.

### The worked example

```bash
export GRAPH_API_KEY=…            # https://thegraph.com/studio/apikeys/
node packages/mcp/dist/examples/subgraph-to-training-set.js \
  --keyword uniswap --subgraph 5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV --first 20 \
  --out /tmp/uniswap.jsonl --upload --name "Uniswap v3 token addresses"
```

It follows the Subgraph MCP's *own* mandated workflow, which that server states in its `graphql://subgraph`
resource: search → **always** check the 30-day query volume → read the schema → run a bounded, block-pinned query.
Measured on this machine on 2026-09-04 and reported honestly by the example rather than papered over:

- the hosted server speaks the **legacy HTTP+SSE** transport (`POST /mcp` is 404 there);
- `get_deployment_30day_query_counts` currently answers **0 for every deployment**, so the ranking signal the
  workflow depends on is unavailable. The example still calls it, still prints what it said, and then *asks for
  `--subgraph <id>` instead of guessing* — which is what the Subgraph MCP's instructions say to do when volumes
  cannot decide;
- the schema is fetched and checked against the mapping before any field name is used;
- rows are deliberately **immutable facts only** (an address, a symbol, a name). A price or a TVL changes every
  block: that is retrieval, not memory, and training it produces a knowledge that is wrong tomorrow.

**No key, no run.** `graph/README.md` requires live data, so a missing `GRAPH_API_KEY` is a clear failure with an
instruction, never a silent fall back to fixtures. (`--anonymous` is offered because the hosted server does answer
unauthenticated — the run is then attributable to nobody, which is not what a real integration ships.)

---

## Tests

```bash
npm test -w packages/mcp                      # unit + tool handlers against a fake node (fast, no cluster needed)
AINIZE_SMOKE_NODE_URL=http://localhost:3422 npm test -w packages/mcp    # + a real-node smoke test
AINIZE_MCP_SMOKE_LIVE=1 npm test -w packages/mcp                        # + one real before/after on the shared GPU
GRAPH_API_KEY=… npm test -w packages/mcp                                # + the live Subgraph MCP smoke test
npx tsc -p packages/mcp/tsconfig.json --noEmit
```

`test/fake-node.ts` answers with the real node's shapes and records every request, so the tests can assert what was
**not** called: a dry-run quote must never touch `/x402/…` (a 402 reserves a nonce), a refused gate must never reach
`/api/patches/:id/buy`, and a replayed idempotency key must not produce a second purchase.

### Driving it from a real MCP client

The unit tests call the handlers. `scripts/drive.mjs` does not: it **spawns `dist/bin.js` as a subprocess and speaks
the protocol to it** with the official SDK client — `initialize`, `tools/list`, `resources/list`, `tools/call`,
`notifications/tools/list_changed` — exactly as Claude Code or Cursor does, and writes every request and every
answer to a JSONL transcript under `packages/e2e/results/mcp/`. Every defect listed in the git log under
"a real MCP client found" was found this way and could not have been found by the fake.

```bash
node packages/mcp/scripts/drive.mjs packages/mcp/scripts/scenarios/<scenario>.mjs
```

| Scenario | What it drives | Needs |
|---|---|---|
| `job1-prove.mjs` | find a Korean-ticker knowledge and prove it: search → detail → one `live_test` → before/after with the verifiers' scores | a node with a serving model; `AINIZE_OPERATOR_PASSWORD` to skip the trial quota |
| `job2-teach.mjs` | teach five facts on top of an existing knowledge and keep it private: training set → preflight → lesson → what it learned and what it did not → download | a teach-enabled node (`teach.lineage: true`), `TEACH_KEY_FILE` |
| `job3-money.mjs` | quote → refuse over the cap → buy with an explicit confirm → receipt, plus every money attack | a PRIVATE local-ledger cluster with something sellable, `MONEY_NODE_PASSWORD` |
| `job3b-stale-quote.mjs` | holds one session open past the quote's 10-minute life and then tries to settle it | the same private cluster (takes 11 minutes) |
| `job4-subgraph.mjs` | both directions: Ainize as a client of The Graph's Subgraph MCP, then those rows landing as a training set with provenance | `GRAPH_API_KEY`, `TEACH_KEY_FILE` |
| `job5-attacks.mjs` | bad ids, credentials in the wrong place, arguments that try to raise a cap, a node that is down, money on a port | any node |
| `job6-http.mjs` | the Streamable HTTP transport: handshake, session id, forged session, forged `Host`, no CORS grant | any node |
| `job7-lock.mjs` | two sessions fighting over the shared model lock: who holds it, free give-up, session-scoped jobs | a node with a serving model |
| `demo-cluster-untouched.mjs` | the before/after snapshot that says a session left the shared demo cluster alone | the demo cluster |

Each run writes `<scenario>.jsonl` (the transcript) and `<scenario>.checks.json` (the pass/fail table) and exits
non-zero if anything failed. **`job3` and `job3b` settle real money and must only ever be pointed at a private
local-ledger cluster**, never at the demo cluster or the shared AIN chain.

## Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| The client shows **0 tools** | the server started but the node did not answer | check `AINIZE_NODE_URL`; `curl $AINIZE_NODE_URL/api/info`. Read tools register even when the node is down, so 0 tools means the process itself failed — run `node packages/mcp/dist/bin.js --help` by hand and read stderr |
| The stdio handshake **hangs or garbles** | something printed to stdout before the transport connected | this server guards stdout before importing anything (`@ainize/core` prints `secp256k1 unavailable` on import). If you add an import that prints, that guard is why the handshake still works |
| **`teach` is missing** | no teaching key, or the node runs no teach worker | set `AINIZE_TEACH_KEY`; `node_status` → `capability_reasons.can_teach` says which |
| **`buy` is missing** | the session budget is `0` (the default), or no operator credential | set `AINIZE_MCP_SESSION_BUDGET` **and** `AINIZE_OPERATOR_PASSWORD` / `AINIZE_TOKEN`. Buying is operator-gated on the node itself |
| **`publish_knowledge` is missing** | it is opt-in | `AINIZE_MCP_ALLOW_PUBLISH=1`, and on an AIN-chain node also `AINIZE_MCP_ALLOW_AIN_PUBLISH=1` (think first: nothing on that chain can be recalled) |
| `--http` **refuses to start** | a spending budget or apply/publish is enabled on a listening port | that is the guard. Add `--i-am-the-only-user` if the port really is private, or drop the budget |
| Everything is **`model_busy`** | another node holds the shared model | the message names the holder and how long. `node_status` shows the queue. Wait; do not loop |
| **`quota_chat`** after a few tests | 20 free live tests per hour per visitor IP, and one MCP server is one IP | `retry_after_ms` says when they come back. An operator credential removes the cap and the metering with it |
| **`quota_ip` / `quota_key`** on a lesson | the node's daily lesson limit for this IP or key | measured on node-u while writing these docs: `{"code":"quota_ip","message":"daily lesson limit reached for this address"}`. Nothing to retry today — use a private cluster for experiments |
| **`invalid_signature`** with a key you know is right | a teaching-key signature is request-bound and single use; something replayed the request | do not cache or reuse a header; do not follow redirects. This server signs per attempt |
| A live test's **"before" already knows the answer** | the knowledge is *pinned* on the shared model server by somebody else | `result.knowledge[].was_already_applied` and `applied_on_this_model` say so. Report it; the comparison is not against a bare model |
| `verdict` is **`null`** | the question is not in the knowledge's own benchmark | say "unscored comparison". It is not a failure |
| `eta_s` is **`null`** | the node has fewer than three measured samples on a real backend | render "no measured estimate yet". Never 0 |
| A lesson says **100 % and `simulated: true`** | the node trains with the stub backend | nothing was measured in a live model. Say so before anyone believes the number |
| `job_not_found` | jobs are session-scoped, evicted 30 min after finishing | `job_list`; for a lesson, poll by its node lesson id |
| A buy **timed out** | the blob download can take minutes | never buy again. `reconcile_purchase` tells you whether the money moved |
| The node answers **409 `not sold here; gateway is <url>`** | you are quoting a knowledge another node sells | point the server at that node, or buy from it. The url in the error is the answer |


## Not in this version

- **`merge`.** Two bases is a merge, which no node supports yet: the schema reserves the value and the refusal quotes
  the node's own `merge_not_available`.
- **A provenance field on the dataset manifest.** Until the lineage work adds one, provenance rides in each row's
  `note` and in a JSON record beside the journal (§ *Ainize as an MCP client*).
- **`reconcile_purchase` cannot re-fetch a body itself.** It reports `settled_no_body` with the tx hash and names the
  recovery, because the blob fetch needs a signature from the *node identity* key, which this server deliberately
  does not hold.
- **Prompts** (`prove_it`, `shop_for_knowledge`, `teach_on_top`, `subgraph_to_knowledge`) and the
  `ainize://knowledge/{id}` resource template — the tools and `ainize://instructions` carry the same guidance today.
- **A bundle buy.** `quote` states the whole stack and its honest total; `buy` purchases the named child only and
  says so before the money moves, because `?bundle=1` does not exist on the node.
