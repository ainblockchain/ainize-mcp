# Direction B — another MCP server's data becomes a training set

This standalone repository owns the generic MCP **client** plumbing and the seam
(`{prompt, answer, note?}` rows plus provenance). See the [public demo](../README.md#ethonline2026-the-graph-ai-continuity-demo)
for a single-command live run. Broader benchmarks are maintained separately in ainize-bench.

## The seam

```ts
import { McpDataSource } from '@ainize/mcp';

const source = new McpDataSource({
  name: 'subgraph-mcp',
  transport: { kind: 'sse', url: 'https://subgraphs.mcp.thegraph.com/sse',
               headers: { Authorization: `Bearer ${process.env.GRAPH_API_KEY}` } },
  timeoutMs: 120_000,
  maxResultBytes: 4_000_000,
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
  upstream: { subgraph_id: '5zvR82…', block: 25903174 },
  note_fields: ['subgraph_id', 'block'],
});
```

`transport` is `sse`, `http` (Streamable HTTP) or `stdio`. The mapping is **declarative JSON**, not a closure, so a
human can read it, re-run it and diff it. Every item that did not become a row comes back in `rejected[]` with the
reason (a missing required field, an over-long prompt, a duplicate).

## Provenance is the point

`RowProvenance` records: the server name and identity, the negotiated protocol version, **whether** a credential was
presented (never the credential), the tool, the exact arguments and their sha256, the pinning facts (subgraph id,
IPFS hash, block), a hash per row, and the sha256 of the canonical JSONL — which is the node's own dataset hash, so
the content hash is known before uploading. Ainize returns a separate UUID dataset id.

The node's dataset API has no provenance field yet, so the compact line rides in each row's own `note` (selectable
with `note_fields`, capped at the node's 500 characters):

```
via MCP subgraph-mcp · execute_query_by_subgraph_id · subgraph_id 5zvR82… · block 25903174
```

and the full record is written beside the purchase journal when `AINIZE_MCP_STATE_DIR` is set. `create_training_set`
reports it as `recorded: "client-declared"` — this server cannot verify a claim it did not make itself.

## The mandated workflow, and what it actually does today

The Subgraph MCP publishes its own workflow in a resource (`graphql://subgraph`), and the example follows it:
**search → always check the 30-day query volume → read the schema → run a bounded, block-pinned query.**

Measured on this machine on 2026-09-04, and reported by the example rather than papered over:

- the hosted server speaks the **legacy HTTP+SSE** transport (`POST /mcp` is 404 there);
- `get_deployment_30day_query_counts` answers **0 for every deployment**, so the ranking signal the workflow depends
  on is unavailable. The example still calls it, still prints what it said, and then asks for `--subgraph <id>`
  rather than ranking on a signal that is not there;
- the schema is fetched and checked against the mapping before any field name is used.

## The volatility rule

Prefer **snapshot-scoped identity facts**: a contract address and its indexed token metadata at a stated block.
Names and symbols are not unique and can change; the default questions explicitly include the source and block. A price, a TVL
or a holder count changes every block — that is retrieval, not memory, and training it produces a knowledge that is
wrong tomorrow and unverifiable the day after (a verifier re-running the benchmark would score it against a
different chain state).

## The hard stop

The pipeline ends at `create_training_set`. It never chains into `teach`. One agent turn must not be able to spend a
day's lessons on on-chain data nobody has read: show the rows and the count, and let a person ask for the lesson.

## Running the worked example

```bash
export GRAPH_API_KEY=…            # https://thegraph.com/studio/apikeys/
node dist/examples/subgraph-to-training-set.js \
  --keyword uniswap --subgraph 5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV --first 20 \
  --out /tmp/uniswap.jsonl --upload --name "Uniswap v3 token addresses"
```

`--upload` puts the rows on the configured Ainize node as a training set and then **stops**, printing the separate
`teach_preflight` / `teach` calls a human must approve.

**Live data required.** The public demo uses `--anonymous` when no key is set. Set `GRAPH_API_KEY` for an
authenticated run. Provider failures exit nonzero; recorded evidence is never substituted for a live response.
