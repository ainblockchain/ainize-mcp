# Errors — every code, and what to do about it

## The shape

A failure an agent can act on is **not** a protocol error. It comes back as a normal tool result with
`isError: true` and:

```json
{ "ok": false, "node": { … }, "tool": "buy",
  "error": { "code": "budget_exceeded", "message": "…", "retryable": false,
             "retry_after_ms": 30000, "details": { … } } }
```

`retryable` is the field that stops an agent from paying twice: it is **false for everything in the money tier**,
whatever the node said. Protocol-level failures (a malformed call the model cannot act on) stay JSON-RPC errors and
are raised by the SDK.

The node's own error sentences are passed through **unrewritten** — three UX reviews tuned them — and its machine
code prefix (`quota_chat: …`) becomes `code`.

## Codes this server adds

| Code | Meaning | Retryable | What to do |
|---|---|---|---|
| `quote_required` | `buy` without a `quote_id` | no | call `quote`, show the human, wait |
| `quote_expired` | the quote is older than 10 minutes, or unknown to this session | no | quote again; the price may have moved |
| `quote_mismatch` | the restated total, or the live price, does not match | no | quote again and show the new number |
| `confirmation_required` | `confirm: true` missing (`buy`, `remove_knowledge`, the last lesson of the day) | no | ask the human, in words, for that specific thing |
| `budget_exceeded` | over the session cap | no | report cap / spent / remaining / needed; only the server's env can raise it |
| `per_purchase_cap_exceeded` | over `AINIZE_MCP_MAX_PER_PURCHASE` or the call's `max_price` | no | same |
| `already_purchased` | this node already bought it | no | nothing was charged; use the stored tx hash and date |
| `idempotency_replay` | the same idempotency key was used already | no | `reconcile_purchase`, never a second `buy` |
| `payment_settled_delivery_failed` | the money moved, the body did not arrive | no | `reconcile_purchase`; recovery is an operator action |
| `nothing_to_train` | every probed question is already answered correctly | no | say what the model already knows; ask for harder facts. **No lesson was spent** |
| `teach_quota_consumed` | the lesson failed, or the session lesson cap is spent | no | the day's lesson is gone either way; a person decides what is next |
| `model_busy` | the shared runtime lock is held (the message names the holder) | yes (30 s) | report the sentence; retry once, not in a loop |
| `job_not_found` | jobs are session-scoped and evicted 30 min after they finish | no | `job_list`; for a lesson, poll by its node lesson id instead |
| `permanent_ledger_refused` | a publish aimed at the shared AIN chain | no | publish on a local-ledger node (`:3422`) |
| `capability_disabled` | the server was not configured for this | no | the env var to set is named in the message |
| `node_unreachable` | the node did not answer at all | yes | say the node is down; never invent a catalogue |
| `invalid_request` | the arguments contradict each other (both `rows` and `dataset_id`, `extend` without a base) | no | fix the call |
| `upstream_error` | anything else | only on 5xx | pass the sentence through |

## The node's own codes, passed through

`quota_chat` · `quota_key` · `quota_ip` · `quota_rows` · `quota_bytes` · `rate_limited` · `teaching_disabled` ·
`trainer_paused` · `banned` · `invalid_signature` · `not_owner` · `dataset_empty` · `dataset_format` ·
`dataset_hash` · `dataset_in_use` · `dataset_not_found` · `dataset_private` · `dataset_derivative_only` ·
`base_rejected` · `base_retired` · `merge_not_available`

Two of them are worth special handling:

- **`quota_chat`** — free live tests are 20/hour per visitor IP and the bucket is **shared by everyone behind this
  MCP server**. `details.resets_at` / `resets_in_s` come from the node's own `quota_reset`, so say *when* they come
  back.
- **`invalid_signature`** — teaching-key signatures are request-bound and **single-use**; the node's replay cache
  refuses a second verification of the same header. A retry that replays a request looks exactly like a wrong key.
  This server signs per attempt and never follows redirects.

## Answers that are outcomes, not errors

| What | Why it is not a failure |
|---|---|
| HTTP 499 `{cancelled: true, charged: false}` | you gave up a live test while it was still queued. Nothing ran, nothing was charged |
| a quote of something already owned | the honest answer to "what does it cost" is "nothing, you have it" |
| `still_wrong[]` after a lesson | the lesson ran and did not stick for those questions. That is a measurement, and it is the most useful thing in the result |
| `verdict: null` | the question is not in the knowledge's benchmark, so the comparison is unscored |
| `eta_s: null` | the node has no measured estimate yet. Never render it as 0 |

## Redaction

Every result and every error passes through an outbound scrubber before it leaves the server: key-shaped values
(a 64-hex string, a `Bearer …`, an `x-ngram-auth` triple, a `?token=` query credential), fields named like
credentials, and the configured secrets themselves are replaced with `[redacted]`. `tx_hash`, `sha256`, `address`
and `record_hash` are allow-listed so a receipt stays readable — an AIN transaction hash has exactly a private key's
shape, and redacting it would make the money untraceable.
