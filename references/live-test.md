# The live test — the same question, before and after

The signature capability, and the only honest way to claim a knowledge helps.

## What the node actually does

`POST /api/chat` takes the shared runtime lock and then, in order: removes nothing but records what is already
pinned → generates the **base** answer → applies the requested knowledge in list order → generates the **patched**
answer → restores. Both answers come from the same model, the same sampling settings and the same prompt, seconds
apart. Measured on node-a with an idle lock: 3.8 s to apply a 331 MB knowledge, ~0.4 s per generation, 18.8 s end
to end including the queue.

## The tool pair

```jsonc
live_test {
  "question": "픽셀플러스 종목코드 알려줘. 숫자만.",
  "knowledge": ["krx-all-2761"],   // [] asks the bare model on its own; up to 3 ids, applied in order
  "mode": "compare",               // "compare" (default) | "base" | "patched"
  "history": [ /* earlier turns; the question is appended as the last user message */ ],
  "max_tokens": 200,
  "thinking": false
}
→ { "job_id": "lt_…", "state": "queued", "model_lock": {…}, "quota": {…} }      // ~90 ms

job_status { "job_id": "lt_…", "wait_ms": 60000 }
→ { "state": "done", "result": { "before": {…}, "after": {…}, "changed": true, "verdict": null, … } }
```

`wait_ms` long-polls **inside this server** — it never holds a request open on the node — and answers on the next
state change, so a queued job may need two calls (queued → running → done).

## Reading the answer

| Field | How to report it |
|---|---|
| `before.answer` / `after.answer` | verbatim, both of them. This is the evidence |
| `changed` | whether the two differ at all. `false` with knowledge loaded is a real result: say so |
| `verdict` | `null` unless the question is in the knowledge's own benchmark. `null` means *unscored comparison*, not *failed* |
| `knowledge[].verification` | who re-ran the benchmark and with what score — the network's opinion, not this run's |
| `knowledge[].was_already_applied` | the knowledge was **already pinned** on the shared model, so the "before" column is not a bare model. Say so |
| `applied_on_this_model` | what was pinned before the test started, for the same reason |
| `caveats[]` | pass through verbatim |
| `quota` | free tries left this hour, and the note that the bucket is shared |

## The shared model, and who is holding it

Every node on one machine serves the same model behind a cross-process lock (an atomic `mkdir` with a lease under
the patch mailbox). The node waits up to **20 minutes** for it before throwing `shared runtime busy`, which this
server maps to `model_busy` with `retry_after_ms: 30000`.

Every MODEL-tier answer therefore carries, computed against the **node's own clock** (never the local one):

```json
"model_lock": {
  "holder": { "owner": "pid:2658057", "label": "chat:krx-all-2761", "held_s": 8, "alive": true, "stale": false, "mine": true },
  "queue": { "running": 1, "waiting": 0 },
  "sentence": "the model is held by pid:2658057 (a live test of krx-all-2761) for 8 s"
}
```

Report the sentence. Do not retry in a loop: each retry opens another queue ticket behind the one you are waiting
on.

## Cancelling is genuinely free — while queued

`job_cancel { job_id }` proxies the node's own cancel:

- **queued** → nothing was ever sent to the model: `charged: false`, no free try consumed, and the in-flight POST
  ends as HTTP 499 `{cancelled: true, charged: false}` — an outcome, not an error;
- **running** → the work and the charge stand, and the answer says so.

## The quota, and why it is smaller than it looks

Free live tests are metered at **20 units per rolling hour per visitor**, where the visitor id is an HMAC of the
request IP. One MCP server is one IP, so **every user behind this server shares one bucket**. Exhaustion is
`quota_chat` with `retry_after_ms` computed from the node's `quota_reset`, so you can say *"free tries return at
14:05"* instead of *"try later"*.

The count is only known after an answer (there is no quota endpoint), which is why `node_status` reports
`live_tests_remaining: null` until one test has run. Authenticating as operator removes the cap — and with it the
metering that protects a GPU other people are using.

## Testing a private draft

A lesson's `draft_id` is testable only by its owner. This server signs the chat request with the configured
teaching key when there is one, which is exactly what makes `live_test { knowledge: ["taught-draft-…"] }` work
straight after a lesson lands — the proof loop closes without publishing anything.

## Known upstream bug

`POST /api/chat` ignores `max_tokens`: `packages/node/src/api.ts` spreads the parsed snake_case body into
`market.chat`, which reads `opts.maxTokens`. Every live test therefore generates the 200-token default. Reproduced
on node-u with `max_tokens: 8`. Harmless for correctness; it costs latency.
