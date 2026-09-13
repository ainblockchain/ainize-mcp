# Recorded live Graph → Ainize dataset run

Captured on 2026-09-13 using authenticated HTTPS/SSE calls to
`https://subgraphs.mcp.thegraph.com/sse`. These are real provider responses, not fixtures generated to simulate a run.
No credential or request authorization header is included.

- Subgraph: `5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV` (Uniswap v3, Ethereum).
- Deployment: `QmTZ8ejXJxRo7vDBS4uwqBeGoxLSWbhaA7oXa1RvxunLy7`.
- Block: **25969047**; **20** source tokens → **20** training rows; **0** rejected.
- Dataset SHA-256: `edc53e171486aced6e10c8f6647db0c311b51a96b9d48160a5f3f15da8762b53`.
- Ainize: `https://www.ainize.ai`; dataset id `97a216a3-1692-4ebd-a148-928b5b3dfa9e`.
- Ainize accepted all **20** rows and returned the exact predicted SHA-256.

## Review and video commands

From the standalone repository root, after installation/build:

```bash
node scripts/validate-graph-evidence.mjs evidence/ethonline2026/tokens.jsonl
cat evidence/ethonline2026/tokens.jsonl.validation.txt
node -e 'const fs=require("node:fs"); const e=JSON.parse(fs.readFileSync("evidence/ethonline2026/tokens.jsonl.upload.json")); console.log(JSON.stringify(e.receipt,null,2))'
```

For a fresh live replay, including installation and verification:

```bash
bash scripts/demo-graph.sh --block 25969047
```

The replay writes `evidence/latest/`; it does not replace this recording. With `GRAPH_API_KEY` set it uses
authentication; without a key it uses the provider's public anonymous access. No training occurs.

## Artifacts and limits

`tokens.jsonl` holds canonical training rows. Its provenance sidecar records the exact pinned query and hashes.
Its evidence sidecar includes all five tool responses, resource instructions, server identity, tool schemas,
mapping and rejection report. The transcript records the live example's console output. The upload sidecar
contains the public teaching policy, raw dataset API response/status and normalized receipt; no signing header.

All reported 30-day volumes were zero, so the selection was explicit, not a popularity ranking. The provider
returns **null block hashes for historical queries**; the dataset provenance preserves null and pins by block
number plus deployment. The latest-block probe's hash is retained separately in raw evidence. Hashes verify
internal consistency, not a provider signature or independently verified chain truth.

Token names/symbols are not unique or permanently immutable. Questions are scoped to the indexed snapshot.
Canonical rows include fetch-time notes, so fresh replay content hashes may differ even for identical facts.
The recorded console's phrase “training-set id” beside `rows_sha256` refers to the content hash; the API's actual
dataset id is the UUID above. The current example corrects that wording.

The target policy advertised a seven-day dataset TTL at capture. The dataset is owned by the dedicated teaching
key, so anonymous readback is not promised; the checked-in receipt remains reviewable. **No preflight, training,
publication, or model-improvement claim was made.** The target trainer was busy. Local Ainize port 3422 was down.
Existing public patch statuses are outside this dataset-ingestion result.

## Validation

`tests.txt`: 144 tests, 139 passed, 5 live/environment-dependent tests skipped, 0 failures.
`live-tests.txt`: both authenticated Graph MCP smoke tests passed, including an actual pinned query.
The unit suite includes tamper detection against this real recording and pinning/error regression tests.
`dependency-audit.json` records npm's dependency audit; inherited dependency advisories remain unresolved.
The audit reports 10 advisories (1 low, 1 moderate, 5 high, 3 critical); dependency remediation is outside this demo.

The complete standalone `bash scripts/demo-graph.sh --block 25969047` also passed after `npm ci` under Node
24.21.0. Installation took about five minutes on this host, including native SQLite compilation. The resulting
[anonymous replay](../anonymous/tokens.jsonl) and its raw evidence/validation sidecars reproduce the same 20
questions and answers at the same block. Only fetch-time notes and the resulting content hash differ.
