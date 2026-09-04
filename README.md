# `@ngram/mcp` — Ainize as an MCP server

`ainize-mcp` puts the Ainize knowledge marketplace behind the Model Context Protocol, so Claude Code, Cursor and any
other MCP client can do the four things the product exists for:

- **find** knowledge — trained memory-table patches a node applies into a running LLM;
- **prove** it — the same question answered twice, by the bare model and by the model with the knowledge loaded,
  together with who verified it and with what score. This is the signature capability and the hardest thing to fake;
- **price** it honestly — a quote that includes the base stack a delta child needs, and a session budget the model
  cannot raise;
- **buy** it over x402 — quote → explicit confirm → settle, journalled so a retry can never pay twice.

The design this implements is `docs/mcp-integration-design.md`. Direction **B** (Ainize as an MCP *client*, pulling
rows from The Graph's Subgraph MCP into a teaching dataset) lives in `graph/` and is not part of this package yet.

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
7. **It will never publish to a permanent ledger by accident.** Publishing is opt-in and refused on a node whose
   ledger is the shared AIN chain (not yet shipped in this package — see *Not in this version*).

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
same object shape:

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
| `AINIZE_MCP_ALLOW_PUBLISH` / `_ALLOW_AIN_PUBLISH` | reserved for the publish tool | off | yes |
| `AINIZE_MCP_STATE_DIR` | where the purchase journal is persisted (mode 0600) | memory only | no |
| `AINIZE_MCP_CONFIG` | a JSON file with the same keys in snake_case; env wins over it | — | no |

## Which node to point at

| Node | URL | Ledger | Safe for |
|---|---|---|---|
| **node-u** | `http://localhost:3422` | `local` | everything — the default in every example |
| node-a / b / c | `:3402` `:3403` `:3404` | **`ain` (shared chain)** | reading, quoting and live tests |
| a private cluster | `NGRAM_CLUSTER_HOME=<tmpdir> NGRAM_PORT_BASE=3512 NGRAM_LEDGER=local NGRAM_SEED=0 scripts/cluster-restart.sh` | `local` | end-to-end money tests |

**All of them share one model server** (`http://localhost:8002`). A live test run from an MCP client is therefore
visible to every other node on the machine, and anything *applied* changes the "before" column of everyone else's
live test until it is removed.

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
| `apply_knowledge` / `remove_knowledge` | MODEL | free | no — job handle | `AINIZE_MCP_ALLOW_APPLY=1` |
| `quote` | MONEY (read) | free | < 1 s | always |
| `buy` | MONEY | **real money** | no — job handle | operator + non-zero budget |
| `reconcile_purchase` | MONEY (read) | free | seconds | operator configured |

Deliberately absent: `verify`, `challenge`, `announce`, `forget`, `runtime_complete`, peers, chain setup, policy,
bans. They are minutes-long, network-visible or destructive, and an agent has no business driving them.

### The workflow the server asks for

Served as `ainize://instructions` and as the server's `instructions` on connect:

1. **Before you claim a knowledge helps, prove it** — `live_test` with `knowledge: []`, then with the candidate.
2. **Before you spend, quote** — show the total, the base stack and the remaining budget, then **stop**.
3. **Everything that touches the model is a job** — poll `job_status`; if the model is held, report *who* and *how
   long* instead of retrying.
4. **Never print a token, key, password or signature.**
5. **Never background-poll a human decision.** The turn that asks for approval ends.
6. **When something is not implemented, say so** — `family_tree` edge kinds, per-knowledge signals and bundle buys
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
| `model_busy` | the shared runtime lock is held; the message names the holder | yes (30 s) |
| `job_not_found` | jobs are session-scoped and evicted 30 minutes after they finish | no |
| `node_unreachable` | the node did not answer at all | yes |
| `capability_disabled` | reserved: a capability this server was not configured for (today such tools are simply not registered) | no |

Two node answers are **outcomes, not errors**: HTTP 499 `{cancelled, charged:false}` (a live test given up while
queued) and a quote of a knowledge that is already owned.

---

## Tests

```bash
npm test -w packages/mcp                      # unit + tool handlers against a fake node (fast, no cluster needed)
AINIZE_SMOKE_NODE_URL=http://localhost:3422 npm test -w packages/mcp    # + a real-node smoke test
AINIZE_MCP_SMOKE_LIVE=1 npm test -w packages/mcp                        # + one real before/after on the shared GPU
npx tsc -p packages/mcp/tsconfig.json --noEmit
```

`test/fake-node.ts` answers with the real node's shapes and records every request, so the tests can assert what was
**not** called: a dry-run quote must never touch `/x402/…` (a 402 reserves a nonce), a refused gate must never reach
`/api/patches/:id/buy`, and a replayed idempotency key must not produce a second purchase.

## Not in this version

- **The teach tools** (`teach`, `teach_preflight`, `create_training_set`) and **`publish`** — the next PRs. The teach
  door already accepts `base_ids`/`context_ids` on the node, and the tool schema is designed against that.
- **`reconcile_purchase` cannot re-fetch a body itself.** It reports `settled_no_body` with the tx hash and names the
  recovery, because the blob fetch needs a signature from the *node identity* key, which this server deliberately
  does not hold.
- **Prompts** (`prove_it`, `shop_for_knowledge`, `teach_on_top`) and the `ainize://knowledge/{id}` resource template.
- **A bundle buy.** `quote` states the whole stack and its honest total; `buy` purchases the named child only and
  says so before the money moves, because `?bundle=1` does not exist on the node.
