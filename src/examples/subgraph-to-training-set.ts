#!/usr/bin/env node
/**
 * The worked example for direction B (design §11.2): **a subgraph becomes a training set**.
 *
 * It connects to The Graph's hosted Subgraph MCP as a client, follows that server's own mandated workflow, maps the
 * rows it gets back into Ainize's canonical `{prompt, answer}` shape with provenance attached, and stops. Training
 * is a separate, explicitly confirmed call — one command must never be able to spend a day's lessons on data nobody
 * has read (design §11.5).
 *
 * The workflow is the Subgraph MCP's, not ours. Its `graphql://subgraph` resource states it as non-optional:
 *
 *   1. `search_subgraphs_by_keyword`                 — find candidates
 *   2. `get_deployment_30day_query_counts`           — ALWAYS check volume before choosing one
 *   3. `get_schema_by_subgraph_id`                   — read the schema; never guess a field name
 *   4. `execute_query_by_subgraph_id`                — run a bounded query, pinned to a block
 *
 * Measured on 2026-09-04 from this machine and worth knowing before you read the output:
 *  - the hosted server speaks the legacy HTTP+SSE transport (`POST /mcp` answers 404);
 *  - `get_deployment_30day_query_counts` currently returns 0 for every deployment we have asked about, so the
 *    ranking signal the workflow depends on is unavailable. This script still calls it, still reports what it said,
 *    and then refuses to guess: it asks for `--subgraph <id>` rather than picking a subgraph on a signal that is not
 *    there. That is what the Subgraph MCP's own instructions say to do when volumes cannot decide.
 *
 * **Live data only.** With no reachable server and no key there is no run: `graph/README.md` forbids mocked or
 * static substitutes, so this exits with an instruction instead of inventing rows.
 *
 *   GRAPH_API_KEY=…  node dist/examples/subgraph-to-training-set.js \
 *     --keyword uniswap --subgraph 5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV --out /tmp/uniswap.jsonl
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { McpDataSource, McpDataSourceError } from '../datasource.js';
import { canonicalJsonl, getPath, type RowMapping } from '../rows.js';

const SUBGRAPH_MCP = 'https://subgraphs.mcp.thegraph.com/sse';

/**
 * The default pull: token identities out of a Uniswap subgraph. Every field used here is immutable — a contract
 * address, a symbol, a name, a decimals count. A price or a TVL would change every block, and a fact that changes
 * every block is retrieval, not memory: training it produces a knowledge that is wrong by tomorrow (design §11.3).
 */
const DEFAULT_QUERY = `{
  _meta { block { number } }
  tokens(first: %FIRST%, orderBy: txCount, orderDirection: desc) {
    id
    symbol
    name
    decimals
  }
}`;

const DEFAULT_MAPPING: RowMapping = {
  path: 'data.tokens',
  prompt: 'What is the {chain} contract address of the {name} ({symbol}) token?',
  answer: '{id}',
  alt_prompt: 'Which address is the {symbol} token deployed at on {chain}?',
  require: ['id', 'symbol', 'name'],
  constants: { chain: 'Ethereum mainnet' },
  max_rows: 200,
};

interface Args {
  keyword: string; subgraph: string | null; first: number; out: string | null;
  queryFile: string | null; mappingFile: string | null; upload: boolean; name: string | null;
  anonymous: boolean; timeoutMs: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { keyword: 'uniswap', subgraph: null, first: 20, out: null, queryFile: null, mappingFile: null, upload: false, name: null, anonymous: false, timeoutMs: 120_000 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case '--keyword': a.keyword = String(v); i++; break;
      case '--subgraph': a.subgraph = String(v); i++; break;
      case '--first': a.first = Math.max(1, Math.min(200, Number(v))); i++; break;
      case '--out': a.out = String(v); i++; break;
      case '--query-file': a.queryFile = String(v); i++; break;
      case '--mapping-file': a.mappingFile = String(v); i++; break;
      case '--name': a.name = String(v); i++; break;
      case '--timeout-ms': a.timeoutMs = Number(v); i++; break;
      case '--upload': a.upload = true; break;
      case '--anonymous': a.anonymous = true; break;
      case '--help': case '-h': usage(); process.exit(0); break;
      default: if (argv[i]?.startsWith('--')) { console.error(`unknown option ${argv[i]}`); usage(); process.exit(2); }
    }
  }
  return a;
}

function usage(): void {
  console.log(`subgraph-to-training-set — turn a live subgraph query into an Ainize training set

  --keyword <word>       what to search the Subgraph MCP for (default: uniswap)
  --subgraph <id>        the subgraph to query. Required unless the 30-day volume check can rank the candidates.
  --first <n>            page size for the default query (default 20, max 200)
  --query-file <path>    your own GraphQL query instead of the built-in one
  --mapping-file <path>  your own row mapping (JSON: {path, prompt, answer, require, constants, …})
  --out <path>           write the rows as JSONL and the provenance as <path>.provenance.json
  --upload               upload the rows to Ainize as a training set, then STOP (never trains)
  --name <text>          name for the uploaded training set
  --anonymous            connect with no API key (the hosted server allows it; the run is then unattributed)
  --timeout-ms <n>       per MCP call (default 120000, the hosted server's own limit)

Environment: GRAPH_API_KEY (or THEGRAPH_GATEWAY_API_KEY) for The Graph; AINIZE_NODE_URL and AINIZE_TEACH_KEY for --upload.`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const key = process.env.GRAPH_API_KEY ?? process.env.THEGRAPH_GATEWAY_API_KEY ?? '';
  if (!key && !args.anonymous) {
    console.error([
      'No Graph API key in the environment, so there is nothing live to read — and this example will not invent rows.',
      '',
      '  export GRAPH_API_KEY=<your Subgraph Studio API key>      # https://thegraph.com/studio/apikeys/',
      '',
      'The hosted Subgraph MCP does answer unauthenticated (measured 2026-09-04), so `--anonymous` will run — but the',
      'queries are then attributable to nobody, which is not what a real integration ships.',
    ].join('\n'));
    return 2;
  }

  const source = new McpDataSource({
    name: 'subgraph-mcp',
    transport: { kind: 'sse', url: SUBGRAPH_MCP, ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}) },
    timeoutMs: args.timeoutMs,
    clientName: 'ainize-subgraph-to-training-set',
  });

  try {
    const { server, tools } = await source.connect();
    console.log(`connected: ${server.server_name ?? server.name} ${server.server_version ?? ''} over ${server.transport} (${server.authenticated ? 'with an API key' : 'anonymous'}), protocol ${server.protocol_version}`);
    console.log(`tools: ${tools.map((t) => t.name).join(', ')}\n`);

    // 1) search ------------------------------------------------------------------------------------------------
    const search = await source.call('search_subgraphs_by_keyword', { keyword: args.keyword });
    const found = (getPath(search.json, 'subgraphs') as { id?: string; metadata?: { displayName?: string }; currentVersion?: { subgraphDeployment?: { ipfsHash?: string } } }[] | undefined) ?? [];
    console.log(`1. search_subgraphs_by_keyword("${args.keyword}") → ${found.length} candidate(s)`);
    if (!found.length) { console.error(`nothing matched "${args.keyword}" — try another keyword.`); return 3; }

    // 2) the volume check the server's own instructions call NON-OPTIONAL -------------------------------------
    const hashes = [...new Set(found.map((s) => s.currentVersion?.subgraphDeployment?.ipfsHash).filter((x): x is string => !!x))].slice(0, 30);
    const volume = await source.call('get_deployment_30day_query_counts', { ipfs_hashes: hashes });
    const counts = ((getPath(volume.json, 'deployments') as { ipfs_hash: string; total_query_count: number }[] | undefined) ?? [])
      .sort((a, b) => b.total_query_count - a.total_query_count);
    const nameOf = new Map(found.map((s) => [s.currentVersion?.subgraphDeployment?.ipfsHash ?? '', s.metadata?.displayName ?? '']));
    const idOf = new Map(found.map((s) => [s.currentVersion?.subgraphDeployment?.ipfsHash ?? '', s.id ?? '']));
    console.log('2. get_deployment_30day_query_counts → 30-day volume, highest first:');
    for (const c of counts.slice(0, 5)) console.log(`     ${String(c.total_query_count).padStart(9)}  ${nameOf.get(c.ipfs_hash) ?? '(unnamed)'}  ${c.ipfs_hash}`);
    const allZero = counts.every((c) => !c.total_query_count);
    if (allZero) console.log('     every candidate reports 0 — the ranking signal this workflow depends on is unavailable right now.');

    const subgraphId = args.subgraph ?? (allZero ? null : idOf.get(counts[0]?.ipfs_hash ?? '') ?? null);
    if (!subgraphId) {
      console.error([
        '',
        'No subgraph could be chosen honestly: the 30-day query counts came back 0 for every candidate, so there is',
        'nothing to rank them by. The Subgraph MCP\'s own instructions say to ask rather than guess in exactly this case.',
        '',
        `  --subgraph <id>   e.g. --subgraph ${found[0]?.id ?? '<one of the ids above>'}   (${found[0]?.metadata?.displayName ?? ''})`,
      ].join('\n'));
      return 4;
    }
    console.log(`   using subgraph ${subgraphId}${args.subgraph ? ' (named on the command line)' : ' (highest 30-day volume)'}\n`);

    // 3) the schema — never guess a field name ----------------------------------------------------------------
    const schema = await source.call('get_schema_by_subgraph_id', { subgraph_id: subgraphId });
    const sdl = schema.text;
    console.log(`3. get_schema_by_subgraph_id → ${sdl.length} bytes of SDL`);

    const mapping: RowMapping = args.mappingFile ? (JSON.parse(readFileSync(args.mappingFile, 'utf8')) as RowMapping) : DEFAULT_MAPPING;
    const query = args.queryFile ? readFileSync(args.queryFile, 'utf8') : DEFAULT_QUERY.replace('%FIRST%', String(args.first));
    const entity = (mapping.path ?? '').split('.').pop() ?? '';
    const missing = [entity, ...(mapping.require ?? [])].filter((f) => f && !new RegExp(`\\b${f.replace(/[^\w]/g, '')}\\b`).test(sdl));
    if (missing.length) {
      console.error(`the schema this subgraph returned has no ${missing.join(', ')} — the mapping was written for a different schema. Pass --mapping-file / --query-file that match it.`);
      return 5;
    }
    console.log(`   schema check: ${[entity, ...(mapping.require ?? [])].join(', ')} all present\n`);

    // 4) the query, and the rows -------------------------------------------------------------------------------
    const probe = await source.call('execute_query_by_subgraph_id', { subgraph_id: subgraphId, query });
    const block = getPath(probe.json, 'data._meta.block.number');
    if (block === undefined) console.log('   NOTE: the query returned no `_meta { block { number } }`, so these rows are not pinned to a block.');
    const out = await source.fetchRows({
      tool: 'execute_query_by_subgraph_id',
      arguments: { subgraph_id: subgraphId, query },
      mapping,
      upstream: {
        subgraph_id: subgraphId,
        ...(block !== undefined ? { block: Number(block) } : {}),
        ...(counts[0] ? { thirty_day_queries_top_candidate: counts[0].total_query_count } : {}),
        volume_check: allZero ? 'ran; every candidate reported 0' : 'ran',
      },
      // the row note carries what PINS the fact — which subgraph, which block. The rest of the record (the volume
      // check, the argument hash, every row hash) stays in the provenance JSON, where it is not paying for context.
      note_fields: ['subgraph_id', 'block'],
    });
    console.log(`4. execute_query_by_subgraph_id → ${out.items} item(s) → ${out.rows.length} row(s), ${out.rejected.length} rejected, ${out.raw_bytes} bytes`);
    for (const r of out.rejected.slice(0, 5)) console.log(`     rejected #${r.index}: ${r.reason}`);
    console.log('');
    for (const r of out.rows.slice(0, 5)) console.log(`   Q ${r.prompt}\n   A ${r.answer}\n     ${r.note ?? ''}`);
    if (out.rows.length > 5) console.log(`   … ${out.rows.length - 5} more`);
    console.log(`\nrows_sha256 ${out.provenance.rows_sha256}   (this is the training-set id these bytes will land on)`);

    if (args.out) {
      writeFileSync(args.out, canonicalJsonl(out.rows), 'utf8');
      writeFileSync(`${args.out}.provenance.json`, JSON.stringify(out.provenance, null, 2), 'utf8');
      console.log(`wrote ${args.out} and ${args.out}.provenance.json`);
    }

    if (args.upload) {
      // imported here, not at the top: the Ainize half pulls in the node's crypto stack, and an example that only
      // reads a subgraph should not need it (or print its warnings) to run.
      const { loadConfig } = await import('../config.js');
      const { Context } = await import('../context.js');
      const { uploadTrainingSet } = await import('../tools/teach.js');
      const cfg = loadConfig();
      if (!cfg.teachKey) {
        console.error('\n--upload needs a teaching key: set AINIZE_TEACH_KEY (and AINIZE_NODE_URL) for the node to upload to.');
        return 6;
      }
      const ctx = new Context(cfg);
      const name = args.name ?? `${args.keyword} · subgraph ${subgraphId.slice(0, 8)}${block !== undefined ? ` @ block ${block}` : ''}`;
      const uploaded = await uploadTrainingSet(ctx, { rows: out.rows, name: name.slice(0, 80), provenance: out.provenance as unknown as Record<string, unknown> });
      console.log(`\nuploaded to ${cfg.nodeUrl}: training set ${uploaded.dataset_id} (${uploaded.rows_accepted} row(s)${uploaded.existing ? ', already existed — same bytes' : ''})`);
      console.log([
        '',
        'STOPPING HERE ON PURPOSE. These rows have not been trained into anything, and no lesson has been spent.',
        'Read them first. When you and a human agree they are worth a lesson, that is a separate call:',
        '',
        `  teach_preflight { dataset_id: "${uploaded.dataset_id}" }     # what does the model already answer?`,
        `  teach           { dataset_id: "${uploaded.dataset_id}" }     # spends one of the day's lessons`,
      ].join('\n'));
    } else {
      console.log('\nnothing was uploaded and nothing was trained. Add --upload to put these rows on an Ainize node as a training set.');
    }
    return 0;
  } catch (e) {
    if (e instanceof McpDataSourceError) {
      console.error(`\n${e.code}: ${e.message}`);
      if (e.code === 'mcp_unreachable') console.error(`\n${SUBGRAPH_MCP} did not answer. There is no offline fallback here on purpose — this example only reports live data.`);
      return 7;
    }
    console.error(`\n${(e as Error).message}`);
    return 1;
  } finally {
    await source.close().catch(() => {});
  }
}

process.exitCode = await main();
