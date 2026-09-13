/**
 * The live half of direction B: this talks to The Graph's hosted Subgraph MCP over the public internet.
 *
 * It runs only when `GRAPH_API_KEY` (or `THEGRAPH_GATEWAY_API_KEY`) is in the environment, so `npm test` stays
 * offline by default — and it is NEVER replaced by a fixture when the key is missing. `graph/README.md` requires
 * live data; a green test standing in for an absent one would be worse than no test.
 *
 *   GRAPH_API_KEY=… node --test --import tsx test/smoke-subgraph-mcp.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpDataSource } from '../src/datasource.js';
import { rowsSha256 } from '../src/rows.js';
import { assertGraphResult, pinQuery } from '../src/examples/graph-query.js';

const KEY = process.env.GRAPH_API_KEY ?? process.env.THEGRAPH_GATEWAY_API_KEY ?? '';
const SKIP = KEY || process.env.GRAPH_SMOKE_ANONYMOUS === '1' ? false : 'set GRAPH_API_KEY or GRAPH_SMOKE_ANONYMOUS=1 for live data';
/** Uniswap v3 on Ethereum mainnet — the id the Subgraph MCP resolves to that deployment. */
const SUBGRAPH = '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV';

const connect = () => new McpDataSource({
  name: 'subgraph-mcp',
  transport: { kind: 'sse', url: 'https://subgraphs.mcp.thegraph.com/sse', ...(KEY ? { headers: { Authorization: `Bearer ${KEY}` } } : {}) },
  timeoutMs: 120_000,
  clientName: 'ainize-mcp-smoke',
});

test('smoke: the hosted Subgraph MCP answers over SSE and states its own mandatory workflow', { skip: SKIP }, async (t) => {
  const s = connect();
  t.after(() => s.close());
  const { server, tools } = await s.connect();
  assert.equal(server.server_name, 'subgraph-mcp');
  assert.equal(server.transport, 'sse');
  assert.equal(server.authenticated, !!KEY);
  for (const name of ['search_subgraphs_by_keyword', 'get_deployment_30day_query_counts', 'get_schema_by_subgraph_id', 'execute_query_by_subgraph_id']) {
    assert.ok(tools.some((x) => x.name === name), `the workflow this integration follows needs ${name}`);
  }
  const instructions = await s.readResource('graphql://subgraph');
  assert.match(instructions, /get_deployment_30day_query_counts/, 'the volume check is the server\'s own rule, not ours');
});

test('smoke: a live subgraph query becomes block-pinned training rows', { skip: SKIP }, async (t) => {
  const s = connect();
  t.after(() => s.close());
  await s.connect();

  // the volume check runs whatever it answers — the point is that it is not skipped
  const search = await s.call('search_subgraphs_by_keyword', { keyword: 'uniswap' });
  const hashes = ((search.json as { subgraphs?: { currentVersion?: { subgraphDeployment?: { ipfsHash?: string } } }[] }).subgraphs ?? [])
    .map((x) => x.currentVersion?.subgraphDeployment?.ipfsHash).filter((x): x is string => !!x).slice(0, 10);
  assert.ok(hashes.length > 0, 'the keyword search found candidates');
  const volume = await s.call('get_deployment_30day_query_counts', { ipfs_hashes: hashes });
  assert.ok(Array.isArray((volume.json as { deployments?: unknown[] }).deployments), 'the volume check answered');

  const schema = await s.call('get_schema_by_subgraph_id', { subgraph_id: SUBGRAPH });
  assert.match(schema.text, /type Token\b/, 'the schema is read before a field name is used');

  const probe = await s.call('execute_query_by_subgraph_id', { subgraph_id: SUBGRAPH, query: '{ _meta { block { number } } }' });
  const block = assertGraphResult(probe);
  const query = pinQuery('{ _meta { block { number } } tokens(first: 5, orderBy: txCount, orderDirection: desc) { id symbol name } }', block);
  const out = await s.fetchRows({
    tool: 'execute_query_by_subgraph_id',
    arguments: { subgraph_id: SUBGRAPH, query },
    mapping: {
      path: 'data.tokens',
      prompt: 'What is the {chain} contract address of the {name} ({symbol}) token?',
      answer: '{id}',
      require: ['id', 'symbol', 'name'],
      constants: { chain: 'Ethereum mainnet' },
    },
    upstream: { subgraph_id: SUBGRAPH, block },
    note_fields: ['subgraph_id'],
  });
  assert.equal(out.rows.length, 5);
  for (const row of out.rows) {
    assert.match(row.answer, /^0x[0-9a-f]{40}$/, 'a token address, live off the chain');
    assert.ok(row.prompt.length <= 400 && row.answer.length <= 200, 'inside the node\'s own limits');
    assert.match(String(row.note), /via MCP subgraph-mcp · execute_query_by_subgraph_id · subgraph_id/);
  }
  assert.equal(out.provenance.rows_sha256, rowsSha256(out.rows), 'the record hashes the rows it travels with');
  assertGraphResult(out.raw, block);
  assert.equal(out.provenance.upstream?.block, block);
  assert.equal(out.provenance.arguments.query, pinQuery(query, block));
});
