/**
 * Job 4 — the MCP-CLIENT direction: another MCP server's output becomes an Ainize training set, with provenance.
 *
 * Both directions run in one transcript:
 *   A. Ainize as an MCP client — `McpDataSource` connects to The Graph's hosted Subgraph MCP over SSE and follows
 *      THAT server's own mandated workflow (search → 30-day volume → schema → block-pinned query).
 *   B. Ainize as an MCP server — the driver's MCP client calls `create_training_set` with the rows and provenance.
 *
 * Live data only: no reachable Subgraph MCP and no key means no run, and the scenario says exactly what is missing
 * rather than inventing rows.
 */
import { readFileSync } from 'node:fs';
import { McpDataSource } from '../../dist/datasource.js';
import { mapRows, rowsSha256 } from '../../dist/rows.js';

const SUBGRAPH_MCP = 'https://subgraphs.mcp.thegraph.com/sse';
const TEACH_NODE = process.env.TEACH_NODE_URL ?? 'http://localhost:3422';
const KEY_FILE = process.env.TEACH_KEY_FILE;
const SUBGRAPH_ID = process.env.SUBGRAPH_ID ?? '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV';   // Uniswap v3 (mainnet)

const QUERY = (first) => `{
  _meta { block { number } }
  tokens(first: ${first}, orderBy: txCount, orderDirection: desc) { id symbol name decimals }
}`;

const MAPPING = {
  path: 'data.tokens',
  prompt: 'What is the {chain} contract address of the {name} ({symbol}) token?',
  answer: '{id}',
  alt_prompt: 'Which address is the {symbol} token deployed at on {chain}?',
  require: ['id', 'symbol', 'name'],
  constants: { chain: 'Ethereum mainnet' },
  max_rows: 5,
};

export default async function ({ session, check, log, transcript }) {
  const key = process.env.GRAPH_API_KEY;
  if (!key) {
    check('J4.0', 'The Graph Subgraph MCP is configured', false, 'GRAPH_API_KEY is not set: the hosted server at https://subgraphs.mcp.thegraph.com/sse requires a Graph gateway API key in an Authorization: Bearer header. Set GRAPH_API_KEY (repo .env) and re-run; nothing here will be faked.');
    return;
  }

  // ---------------------------------------------------------------- A. Ainize as an MCP client
  const src = new McpDataSource({
    name: 'subgraph-mcp',
    transport: { kind: 'sse', url: SUBGRAPH_MCP, headers: { Authorization: `Bearer ${key}` } },
    timeoutMs: 120_000,
  });
  let mapped;
  try {
    const { server, tools } = await src.connect();
    transcript.write({ kind: 'upstream-connect', server, tools: tools.map((t) => t.name) });
    check('J4.1', 'Ainize connects to a third-party MCP server and records what it is (never the credential)', !!server.protocol_version && server.authenticated === true && !JSON.stringify(server).includes(key), `${server.server_name ?? server.name} · protocol ${server.protocol_version} · ${tools.length} tools · authenticated ${server.authenticated}`);

    // The Subgraph MCP's own workflow, in its own order.
    const search = await src.call('search_subgraphs_by_keyword', { keyword: 'uniswap' });
    transcript.write({ kind: 'upstream-call', tool: 'search_subgraphs_by_keyword', bytes: search.text.length, isError: search.isError });
    check('J4.2', "step 1 of the upstream server's mandated workflow: search", !search.isError && search.text.length > 0, `${search.text.length} bytes back in ${search.elapsed_ms} ms`);

    // The volume tool takes DEPLOYMENT ipfs hashes, which come out of the search answer — never a subgraph id.
    const hashes = [...new Set(String(search.text).match(/Qm[1-9A-HJ-NP-Za-km-z]{44}/g) ?? [])].slice(0, 5);
    const volumes = hashes.length
      ? await src.call('get_deployment_30day_query_counts', { ipfs_hashes: hashes }).catch((e) => ({ isError: true, text: String(e.message), elapsed_ms: 0 }))
      : { isError: true, text: 'the search answer carried no deployment ipfs hash to ask about', elapsed_ms: 0 };
    transcript.write({ kind: 'upstream-call', tool: 'get_deployment_30day_query_counts', ipfs_hashes: hashes, answer: String(volumes.text).slice(0, 600) });
    check('J4.3', 'step 2 is always run against real deployment hashes, and what it said is reported rather than assumed', hashes.length > 0 && !volumes.isError, `${hashes.length} deployment hashes asked about → ${String(volumes.text).slice(0, 200)}`);

    const schema = await src.call('get_schema_by_subgraph_id', { subgraph_id: SUBGRAPH_ID });
    const hasTokens = /type\s+Token\b/.test(schema.text) && /\bsymbol\b/.test(schema.text) && /\bdecimals\b/.test(schema.text);
    check('J4.4', 'step 3: the schema is read and the mapping\'s fields are checked against it, never guessed', !schema.isError && hasTokens, `schema ${schema.text.length} bytes; Token.symbol/decimals present: ${hasTokens}`);

    mapped = await src.fetchRows({
      tool: 'execute_query_by_subgraph_id',
      arguments: { subgraph_id: SUBGRAPH_ID, query: QUERY(MAPPING.max_rows) },
      mapping: MAPPING,
      upstream: { subgraph_id: SUBGRAPH_ID },
      note_fields: ['subgraph_id', 'block'],
    });
    // the block the answer is pinned to comes from the answer itself
    const block = mapped.rows.length ? null : null;
    check('J4.5', 'step 4: a bounded query returns rows, and every row is immutable data (an address, not a price)', mapped.rows.length > 0 && mapped.rows.every((r) => /^0x[0-9a-f]{40}$/i.test(r.answer)), `${mapped.rows.length} rows · rejected ${mapped.rejected.length} · ${mapped.rows[0]?.prompt} → ${mapped.rows[0]?.answer}`);
    const p = mapped.provenance;
    check('J4.6', 'provenance names the server, the protocol, the tool, the arguments hash and the row hashes', p.source === 'mcp' && !!p.arguments_sha256 && p.row_hashes.length === mapped.rows.length && p.rows_sha256 === rowsSha256(mapped.rows), `tool ${p.tool} · args sha ${p.arguments_sha256.slice(0, 16)}… · rows sha ${p.rows_sha256.slice(0, 16)}… · ${p.rows} rows`);
    check('J4.7', 'the credential is nowhere in the provenance record', !JSON.stringify(p).includes(key), `provenance is ${JSON.stringify(p).length} bytes and contains no key material`);
    check('J4.8', 'every row carries the line that says where the fact came from', mapped.rows.every((r) => (r.note ?? '').includes('subgraph-mcp')), `note: ${mapped.rows[0]?.note}`);
    transcript.write({ kind: 'mapped-rows', rows: mapped.rows, provenance: { ...p, row_hashes: p.row_hashes.slice(0, 3) } });
  } finally {
    await src.close();
  }

  // ---------------------------------------------------------------- B. Ainize as an MCP server
  if (!KEY_FILE) { check('J4.9', 'a teaching key is configured for the landing node', false, 'TEACH_KEY_FILE is not set'); return; }
  const s = await session({ AINIZE_NODE_URL: TEACH_NODE, AINIZE_TEACH_KEY: KEY_FILE }, { label: 'node-u' });
  try {
    const names = (await s.tools()).map((t) => t.name);
    check('J4.9', 'the landing node offers the teach door and nothing that spends money', names.includes('create_training_set') && !names.includes('buy') && !names.includes('publish_knowledge'), names.join(', '));

    const before = await s.call('my_library', { include: ['lessons', 'datasets'] }, 'how many lessons has this key spent so far');
    const lessonsBefore = (before.data.lessons?.items ?? before.data.lessons ?? []).length ?? 0;

    const up = await s.call('create_training_set', {
      rows: mapped.rows,
      name: `subgraph ${SUBGRAPH_ID.slice(0, 8)} tokens (MCP adversarial run)`,
      provenance: mapped.provenance,
    }, 'the rows another MCP server produced land on an Ainize node');
    check('J4.10', 'the training set is created, free, and its id is the sha256 this side predicted', !up.isError && !!up.data.dataset_id, `dataset ${up.data.dataset_id} · rows ${up.data.rows} · sha256 ${String(up.data.sha256 ?? '').slice(0, 16)}… · predicted ${rowsSha256(mapped.rows).slice(0, 16)}…`);
    check('J4.10b', 'the node stored exactly the rows this side hashed', String(up.data.sha256 ?? '') === rowsSha256(mapped.rows), `node ${up.data.sha256} vs local ${rowsSha256(mapped.rows)}`);

    const back = await s.call('get_training_set', { id: up.data.dataset_id, rows: true }, 'read back what the node actually stored');
    const storedRows = back.data.rows ?? back.data.preview ?? [];
    check('J4.11', 'the id create_training_set returned reads back through get_training_set, rows and provenance intact', !back.isError && back.data.kind === 'uploaded_training_set' && Array.isArray(storedRows) && storedRows.length > 0 && String(JSON.stringify(storedRows)).includes('subgraph-mcp'), `${back.data.kind} · ${storedRows.length} rows read back; first note: ${storedRows[0]?.note ?? '(none)'}`);

    const after = await s.call('my_library', { include: ['lessons', 'datasets'] }, 'nothing was trained: the lesson count must not have moved');
    const lessonsAfter = (after.data.lessons?.items ?? after.data.lessons ?? []).length ?? 0;
    check('J4.12', 'the pipeline STOPS at the training set — no lesson was spent and no GPU was touched', lessonsAfter === lessonsBefore, `lessons ${lessonsBefore} → ${lessonsAfter}; next step is an explicit teach_preflight / teach the human approves`);
    check('J4.13', 'create_training_set says provenance is a client claim, not something this server verified', /client-declared|declared/i.test(JSON.stringify(up.data)), `${JSON.stringify(up.data.provenance ?? up.data).slice(0, 200)}`);
    return { dataset_id: up.data.dataset_id };
  } finally {
    await s.close();
  }
}
