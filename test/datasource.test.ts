/**
 * Direction B's client half, against a REAL MCP server: the SDK's own Streamable HTTP transport, an express app, a
 * server that answers like a data server does. No mock of the protocol — a hand-written fake would prove the fake
 * works, and the transport is exactly the part that is easy to get wrong.
 *
 * The SSE transport (which is what The Graph's hosted Subgraph MCP speaks) is exercised for real by
 * `test/smoke-subgraph-mcp.test.ts`, which runs only when a key and an opt-in are present.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { z } from 'zod';
import { McpDataSource, McpDataSourceError } from '../src/datasource.js';
import type { RowMapping } from '../src/rows.js';

const TOKENS = {
  data: {
    _meta: { block: { number: 25903086 } },
    tokens: [
      { id: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', name: 'Wrapped Ether' },
      { id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', name: 'USD Coin' },
    ],
  },
};

const MAPPING: RowMapping = {
  path: 'data.tokens',
  prompt: 'What is the contract address of the {name} ({symbol}) token?',
  answer: '{id}',
  require: ['id', 'symbol'],
};

/** A small upstream data server: one query tool, one that errors, one that answers with more bytes than anyone wants. */
async function startServer(): Promise<{ url: string; stop: () => Promise<void>; seen: { authorization?: string }[] }> {
  const seen: { authorization?: string }[] = [];
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  app.post('/mcp', async (req, res) => {
    seen.push({ ...(req.header('authorization') ? { authorization: req.header('authorization') } : {}) });
    const sid = req.header('mcp-session-id');
    let transport = sid ? sessions.get(sid) : undefined;
    if (!transport) {
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => sessions.set(id, created),
      });
      transport = created;
      const server = new McpServer({ name: 'test-data-server', version: '9.9.9' });
      server.registerTool('execute_query', { description: 'run a query', inputSchema: { query: z.string() } }, async () => ({
        content: [{ type: 'text', text: JSON.stringify(TOKENS) }],
      }));
      server.registerTool('broken', { description: 'always fails', inputSchema: {} }, async () => ({
        content: [{ type: 'text', text: 'the upstream index is down' }], isError: true,
      }));
      server.registerTool('huge', { description: 'answers with a lot', inputSchema: {} }, async () => ({
        content: [{ type: 'text', text: 'x'.repeat(50_000) }],
      }));
      server.registerTool('prose', { description: 'answers with words, not JSON', inputSchema: {} }, async () => ({
        content: [{ type: 'text', text: 'no JSON here' }],
      }));
      await server.connect(created);
    }
    await transport.handleRequest(req, res, req.body);
  });
  const http: Server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = (http.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/mcp`, stop: () => new Promise((r) => http.close(() => r())), seen };
}

const source = (url: string, opts: Record<string, unknown> = {}) =>
  new McpDataSource({ name: 'test-source', transport: { kind: 'http', url, headers: { Authorization: 'Bearer upstream-key-value' } }, timeoutMs: 10_000, ...opts });

test('connect: the handshake, the tool list, and what goes into provenance about the far side', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const s = source(server.url);
  t.after(() => s.close());
  const { server: ref, tools } = await s.connect();
  assert.equal(ref.server_name, 'test-data-server');
  assert.equal(ref.server_version, '9.9.9');
  assert.equal(ref.transport, 'http');
  assert.equal(ref.authenticated, true, 'that a credential was presented is recorded');
  assert.match(ref.protocol_version, /^\d{4}-\d{2}-\d{2}$/, 'the NEGOTIATED protocol version, not a guess');
  assert.deepEqual(tools.map((x) => x.name).sort(), ['broken', 'execute_query', 'huge', 'prose']);
  assert.ok(!JSON.stringify(ref).includes('upstream-key-value'), 'the credential itself is never in the record');
  assert.equal(server.seen[0]?.authorization, 'Bearer upstream-key-value', 'and it did reach the server');
});

test('fetchRows: rows in the canonical shape, provenance sealed over exactly those rows', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const s = source(server.url);
  t.after(() => s.close());
  await s.connect();
  const out = await s.fetchRows({
    tool: 'execute_query',
    arguments: { query: '{ tokens { id symbol name } }' },
    mapping: MAPPING,
    upstream: { subgraph_id: '5zvR82', block: 25903086 },
    note_fields: ['subgraph_id', 'block'],
  });
  assert.equal(out.items, 2);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0]?.answer, '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
  assert.match(String(out.rows[0]?.note), /via MCP test-source · execute_query · subgraph_id 5zvR82 · block 25903086/);
  assert.equal(out.provenance.rows, 2);
  assert.equal(out.provenance.row_hashes.length, 2);
  assert.equal(out.provenance.tool, 'execute_query');
  assert.equal(out.provenance.arguments.query, '{ tokens { id symbol name } }', 'the query a buyer would re-run is on the record');
  assert.equal(out.provenance.upstream?.block, 25903086);
  assert.equal(out.provenance.server.server_name, 'test-data-server');
  assert.deepEqual(out.raw.json, TOKENS);
  assert.equal(out.raw_bytes, Buffer.byteLength(out.raw.text, 'utf8'));
  assert.equal(out.raw.provenance.arguments_sha256, out.provenance.arguments_sha256);
});

test('an upstream tool error is an error here, never an empty training set', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const s = source(server.url);
  t.after(() => s.close());
  await s.connect();
  await assert.rejects(
    () => s.fetchRows({ tool: 'broken', mapping: MAPPING }),
    (e: McpDataSourceError) => e.code === 'mcp_tool_error' && /the upstream index is down/.test(e.message),
  );
});

test('an answer that is not JSON is refused rather than mapped into nothing', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const s = source(server.url);
  t.after(() => s.close());
  await s.connect();
  await assert.rejects(() => s.fetchRows({ tool: 'prose', mapping: MAPPING }), (e: McpDataSourceError) => e.code === 'mcp_not_json');
});

test('a runaway answer is capped before it becomes the agent\'s context', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const s = source(server.url, { maxResultBytes: 1000 });
  t.after(() => s.close());
  await s.connect();
  await assert.rejects(
    () => s.call('huge'),
    (e: McpDataSourceError) => e.code === 'mcp_result_too_large' && /page the query/.test(e.message),
  );
});

test('calling before connecting, and connecting to nothing, both say so plainly', async () => {
  const s = new McpDataSource({ name: 'nowhere', transport: { kind: 'http', url: 'http://127.0.0.1:1/mcp' } });
  await assert.rejects(() => s.call('anything'), (e: McpDataSourceError) => e.code === 'mcp_not_connected');
  await assert.rejects(() => s.connect(), (e: McpDataSourceError) => e.code === 'mcp_unreachable');
});
