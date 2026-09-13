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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { McpDataSource, McpDataSourceError } from '../datasource.js';
import { canonicalJsonl, getPath, type RowMapping } from '../rows.js';
import { assertGraphResult, pinQuery } from './graph-query.js';

const SUBGRAPH_MCP = 'https://subgraphs.mcp.thegraph.com/sse';

/**
 * The default pull: indexed token identities scoped to a Uniswap snapshot. Names and symbols may change or collide,
 * so the questions identify the source, chain and block. Prices and TVL are deliberately excluded.
 */
const DEFAULT_QUERY = `{
  _meta { block { number hash } deployment hasIndexingErrors }
  tokens(first: %FIRST%, orderBy: txCount, orderDirection: desc) {
    id
    symbol
    name
    decimals
  }
}`;

const DEFAULT_MAPPING: RowMapping = {
  path: 'data.tokens',
  prompt: 'At block {block}, which {chain} address is indexed by Uniswap v3 for {name} ({symbol})?',
  answer: '{id}',
  alt_prompt: 'In the Uniswap v3 snapshot at {chain} block {block}, what is the address for {name} ({symbol})?',
  require: ['id', 'symbol', 'name'],
  constants: { chain: 'Ethereum mainnet' },
  max_rows: 200,
};

interface Args {
  keyword: string; subgraph: string | null; first: number; out: string | null;
  queryFile: string | null; mappingFile: string | null; upload: boolean; name: string | null;
  anonymous: boolean; timeoutMs: number; block: number | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { keyword: 'uniswap', subgraph: null, first: 20, out: null, queryFile: null, mappingFile: null, upload: false, name: null, anonymous: false, timeoutMs: 120_000, block: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    if (!['--upload', '--anonymous', '--help', '-h'].includes(argv[i]) && (!v || v.startsWith('--'))) throw new Error(`Missing value for ${argv[i]}`);
    switch (argv[i]) {
      case '--keyword': a.keyword = String(v); i++; break;
      case '--subgraph': a.subgraph = String(v); i++; break;
      case '--first': a.first = Number(v); i++; break;
      case '--block': a.block = Number(v); i++; break;
      case '--out': a.out = String(v); i++; break;
      case '--query-file': a.queryFile = String(v); i++; break;
      case '--mapping-file': a.mappingFile = String(v); i++; break;
      case '--name': a.name = String(v); i++; break;
      case '--timeout-ms': a.timeoutMs = Number(v); i++; break;
      case '--upload': a.upload = true; break;
      case '--anonymous': a.anonymous = true; break;
      case '--help': case '-h': usage(); process.exit(0); break;
      default: throw new Error(`unknown option ${argv[i]}`);
    }
  }
  if (!Number.isSafeInteger(a.first) || a.first < 1 || a.first > 200) throw new Error('--first must be an integer from 1 to 200');
  if (!Number.isSafeInteger(a.timeoutMs) || a.timeoutMs < 1) throw new Error('--timeout-ms must be a positive integer');
  if (a.block !== null && (!Number.isSafeInteger(a.block) || a.block < 1)) throw new Error('--block must be a positive integer');
  if (a.subgraph && a.subgraph !== '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV' && !a.mappingFile) throw new Error('A different subgraph needs --mapping-file with its own chain and fact wording');
  return a;
}

function usage(): void {
  console.log(`subgraph-to-training-set — turn a live subgraph query into an Ainize training set

  --keyword <word>       what to search the Subgraph MCP for (default: uniswap)
  --subgraph <id>        the subgraph to query. Required unless the 30-day volume check can rank the candidates.
  --first <n>            page size for the default query (default 20, max 200)
  --block <n>            reproduce a historical block (default: discover latest, then pin)
  --query-file <path>    your own GraphQL query instead of the built-in one
  --mapping-file <path>  your own row mapping (JSON: {path, prompt, answer, require, constants, …})
  --out <path>           write JSONL, .provenance.json and full .evidence.json sidecars
  --upload               upload the rows to Ainize as a training set, then STOP (never trains)
  --name <text>          name for the uploaded training set
  --anonymous            connect with no API key (the hosted server allows it; the run is then unattributed)
  --timeout-ms <n>       per MCP call (default 120000, the hosted server's own limit)

Environment: GRAPH_API_KEY (or THEGRAPH_GATEWAY_API_KEY) for The Graph; AINIZE_NODE_URL and AINIZE_TEACH_KEY for --upload.`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const key = args.anonymous ? '' : process.env.GRAPH_API_KEY ?? process.env.THEGRAPH_GATEWAY_API_KEY ?? '';
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
    const instructions = await source.readResource('graphql://subgraph');

    // 1) search ------------------------------------------------------------------------------------------------
    const search = await source.call('search_subgraphs_by_keyword', { keyword: args.keyword });
    if (search.isError) throw new Error(`Subgraph search failed: ${search.text.slice(0, 400)}`);
    const found = (getPath(search.json, 'subgraphs') as { id?: string; metadata?: { displayName?: string }; currentVersion?: { subgraphDeployment?: { ipfsHash?: string } } }[] | undefined) ?? [];
    console.log(`1. search_subgraphs_by_keyword("${args.keyword}") → ${found.length} candidate(s)`);
    if (!found.length) { console.error(`nothing matched "${args.keyword}" — try another keyword.`); return 3; }

    // 2) the volume check the server's own instructions call NON-OPTIONAL -------------------------------------
    const hashes = [...new Set(found.map((s) => s.currentVersion?.subgraphDeployment?.ipfsHash).filter((x): x is string => !!x))].slice(0, 30);
    const volume = await source.call('get_deployment_30day_query_counts', { ipfs_hashes: hashes });
    if (volume.isError) throw new Error(`Volume check failed: ${volume.text.slice(0, 400)}`);
    const counts = [...((getPath(volume.json, 'deployments') as { ipfs_hash: string; total_query_count: number }[] | undefined) ?? [])]
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
    if (!args.mappingFile && subgraphId !== '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV') throw new Error('Default mapping is for Uniswap v3 Ethereum; specify --mapping-file for other subgraphs');

    // 3) the schema — never guess a field name ----------------------------------------------------------------
    const schema = await source.call('get_schema_by_subgraph_id', { subgraph_id: subgraphId });
    if (schema.isError) throw new Error(`Schema fetch failed: ${schema.text.slice(0, 400)}`);
    const sdl = schema.text;
    console.log(`3. get_schema_by_subgraph_id → ${sdl.length} bytes of SDL`);

    const mapping: RowMapping = args.mappingFile ? (JSON.parse(readFileSync(args.mappingFile, 'utf8')) as RowMapping) : DEFAULT_MAPPING;
    const queryTemplate = args.queryFile ? readFileSync(args.queryFile, 'utf8') : DEFAULT_QUERY.replace('%FIRST%', String(args.first));
    const entity = (mapping.path ?? '').split('.').pop() ?? '';
    const missing = [entity, ...(mapping.require ?? [])].filter((f) => f && !new RegExp(`\\b${f.replace(/[^\w]/g, '')}\\b`).test(sdl));
    if (missing.length) {
      console.error(`the schema this subgraph returned has no ${missing.join(', ')} — the mapping was written for a different schema. Pass --mapping-file / --query-file that match it.`);
      return 5;
    }
    console.log(`   schema check: ${[entity, ...(mapping.require ?? [])].join(', ')} all present\n`);

    // 4) the query, and the rows -------------------------------------------------------------------------------
    const probe = await source.call('execute_query_by_subgraph_id', { subgraph_id: subgraphId, query: args.block === null
      ? '{ _meta { block { number hash } deployment hasIndexingErrors } }'
      : pinQuery('{ _meta { block { number hash } deployment hasIndexingErrors } }', args.block) });
    const block = assertGraphResult(probe, args.block ?? undefined);
    const query = pinQuery(queryTemplate, block);
    mapping.constants = { ...mapping.constants, block };
    const out = await source.fetchRows({
      tool: 'execute_query_by_subgraph_id',
      arguments: { subgraph_id: subgraphId, query },
      mapping,
      upstream: {
        subgraph_id: subgraphId,
        deployment: String(getPath(probe.json, 'data._meta.deployment') ?? ''),
        block_hash: String(getPath(probe.json, 'data._meta.block.hash') ?? ''),
        ...(block !== undefined ? { block: Number(block) } : {}),
        ...(counts[0] ? { thirty_day_queries_top_candidate: counts[0].total_query_count } : {}),
        volume_check: allZero ? 'ran; every candidate reported 0' : 'ran',
      },
      // the row note carries what PINS the fact — which subgraph, which block. The rest of the record (the volume
      // check, the argument hash, every row hash) stays in the provenance JSON, where it is not paying for context.
      note_fields: ['subgraph_id', 'block'],
    });
    assertGraphResult(out.raw, block);
    for (const field of ['deployment', 'block.hash']) {
      const expected = getPath(probe.json, `data._meta.${field}`);
      const actual = getPath(out.raw.json, `data._meta.${field}`);
      if (expected && actual && actual !== expected) throw new Error(`Graph ${field} changed between probe and pinned query`);
    }
    out.provenance.upstream!.block_hash = getPath(out.raw.json, 'data._meta.block.hash') as string | null ?? null;
    if (!out.rows.length) throw new Error('Live query produced no usable training rows');
    console.log(`4. execute_query_by_subgraph_id → ${out.items} item(s) → ${out.rows.length} row(s), ${out.rejected.length} rejected, ${out.raw_bytes} bytes`);
    for (const r of out.rejected.slice(0, 5)) console.log(`     rejected #${r.index}: ${r.reason}`);
    console.log('');
    for (const r of out.rows.slice(0, 5)) console.log(`   Q ${r.prompt}\n   A ${r.answer}\n     ${r.note ?? ''}`);
    if (out.rows.length > 5) console.log(`   … ${out.rows.length - 5} more`);
    console.log(`\nrows_sha256 ${out.provenance.rows_sha256}   (expected dataset content hash; Ainize assigns a separate dataset id)`);

    if (args.out) {
      mkdirSync(dirname(args.out), { recursive: true });
      writeFileSync(args.out, canonicalJsonl(out.rows), 'utf8');
      writeFileSync(`${args.out}.provenance.json`, JSON.stringify(out.provenance, null, 2), 'utf8');
      writeFileSync(`${args.out}.evidence.json`, JSON.stringify({
        format: 'ainize-graph-evidence-v1', server, tools, instructions,
        selection: { keyword: args.keyword, subgraph_id: subgraphId, reason: args.subgraph ? 'explicit CLI selection' : 'highest reported 30-day query volume' },
        calls: { search, volume, schema, probe, query: out.raw },
        mapping, items: out.items, rejected: out.rejected, rows_sha256: out.provenance.rows_sha256,
      }, null, 2), 'utf8');
      console.log(`wrote ${args.out}, ${args.out}.provenance.json and ${args.out}.evidence.json`);
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

process.exitCode = await main().catch((error: Error) => { console.error(error.message); return 2; });
