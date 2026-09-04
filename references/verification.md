# Verification — what "verified" is, and what it is not

## Quorum

A knowledge is `LISTED` (sellable) once **independent** nodes have re-run its benchmark on the real model and
attested to the result. The demo cluster's quorum is 2, and `get_knowledge` reports it as a fraction:

```json
"verification": {
  "quorum": "2/2", "quorum_ok": true, "sellable": true, "open_challenge": null,
  "attestations": [
    { "verifier_name": "node-b", "passed": true,
      "score": { "free_generation": "26/26", "pre_apply": "1/8" },
      "verified_on": "vllm:Qwen3.8-Flash-Next", "created_at": 1788153350500 },
    { "verifier_name": "node-c", "passed": true, "score": { "free_generation": "26/26", "pre_apply": "1/8" }, … }
  ]
}
```

`free_generation` is the score after the knowledge was applied; `pre_apply` is the same benchmark against the bare
model — the pair is the evidence that the knowledge, not the base model, produced the answers.

## Four things a report must get right

1. **Someone else ran it.** An author's attestation of their own knowledge is written to the record but never
   counted, and is refused outright unless a node sets `verifier.allowSelfAttest`. No displayed fraction exceeds the
   quorum.
2. **Nothing is at stake.** No deposit is escrowed, transferred or slashed anywhere in this codebase. What backs a
   result is a verifier node's signature on a permanent public record, plus the fact that any node can challenge it.
   Never describe verification as "staked" or "bonded".
3. **A challenge stops the sale.** While a challenge is newer than the newest counted attestation the knowledge is
   `CHALLENGED`: the gateway answers `423` with the challenger's reason and every buy path refuses. `sellable:
   false` is the field to check; the reason is worth quoting to the human.
4. **The questions are public.** A knowledge's benchmark prompts *and* expected answers are part of its anchor and
   are served to anonymous callers — which is what makes a verifier's score checkable by anyone. It is not a sealed
   exam, and the author knew the questions before publishing. Do not present the score as an independent test set.

## Status, and what each status means for you

| Status | Meaning |
|---|---|
| `DRAFT` | private to its owner; a non-owner gets a 404, deliberately |
| `ANNOUNCED` / `VERIFYING` | on the ledger, not yet sellable — the gateway answers `423 verification n/quorum` |
| `LISTED` | quorum met, sellable |
| `CHALLENGED` | a verifier disputes it; no price is honest while that is open |
| `SUPERSEDED` | a newer version of the same subject and branch exists. Still buyable — name the newer one and let the human choose |
| `REJECTED` | it failed verification |

## Lineage today, and what is not built yet

`get_knowledge` returns one level of `lineage.parents` / `lineage.children`, plus `requires[]` (the base stack) and
`supersedes` / `superseded_by`. `family_tree` walks `GET /api/ledger/graph` client-side and caps at 40 nodes.

Edge kinds beyond `extends` / `supersedes`, per-node `added` counts and usage signals are **not recorded by the node
yet** (lineage design §12.5, PR L6). The tools return `null` with a note saying so. Report the note; `null` is not
`0`, and inventing a number here is the exact failure the note exists to prevent.

Likewise `knowledge_signals` has no endpoint behind it: it is assembled from `downloads`, revenue, attestations and
the (redacted) event stream, and labels itself node-local and partial.
