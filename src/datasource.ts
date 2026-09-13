/**
 * Ainize as an MCP **client** (design §11.1) — direction B.
 *
 * One small class that connects to somebody else's MCP server, calls a tool the caller names, and hands back the
 * answer together with a provenance record. It knows nothing about The Graph: the Graph-specific pipeline lives in
 * `graph/` per `graph/README.md`, and the only thing that crosses between them is `{ rows, provenance }` from
 * `rows.ts`.
 *
 * What it deliberately does NOT do:
 *  - reformulate a query, retry a bad answer, or summarise a result. A pipeline that "helps" here is a pipeline that
 *    cannot say what the upstream server actually returned, and provenance stops being evidence.
 *  - accept a credential from a tool argument. The `Authorization` header comes from the caller's own environment
 *    and is never recorded, logged or returned — `provenance.server.authenticated` is the only trace.
 *  - chain into training. `fetchRows` ends at rows; spending a GPU and a daily lesson is a separate, confirmed call
 *    (design §11.5).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { argumentsSha256, mapRows, sealProvenance, withProvenanceNotes, type MappedRows, type McpServerRef, type RowMapping, type RowProvenance } from './rows.js';

export type McpTransportSpec =
  | { kind: 'sse'; url: string; headers?: Record<string, string> }
  | { kind: 'http'; url: string; headers?: Record<string, string> }
  | { kind: 'stdio'; command: string; args?: string[]; env?: Record<string, string> };

export interface McpDataSourceOptions {
  /** How this connection is named in provenance. */
  name: string;
  transport: McpTransportSpec;
  /** Per call. The hosted Subgraph MCP's own limit is a fixed 120 s and surfaces as JSON-RPC -32001. */
  timeoutMs?: number;
  /** A runaway query must not become the agent's context. Default 1 MB of tool output. */
  maxResultBytes?: number;
  /** Retries, and only on a transport-level failure (-32001 / -32000). A wrong answer is never retried. */
  maxRetries?: number;
  clientName?: string;
  clientVersion?: string;
}

export interface McpToolInfo { name: string; description?: string; inputSchema?: unknown }

export interface McpCallResult {
  /** Every text block the tool returned, concatenated — what the server actually said. */
  text: string;
  /** `text` parsed as JSON when it is JSON, else null. Most data servers answer with a JSON document in one block. */
  json: unknown;
  /** The raw content blocks, for a server that answers with images or resources. */
  content: unknown[];
  isError: boolean;
  elapsed_ms: number;
  provenance: Omit<RowProvenance, 'row_hashes' | 'rows_sha256' | 'rows'>;
}

export class McpDataSourceError extends Error {
  constructor(message: string, readonly code: string, readonly detail?: unknown) {
    super(message);
    this.name = 'McpDataSourceError';
  }
}

/** JSON-RPC codes worth one retry: the connection dropped or the server ran out of time, not "the answer was bad". */
const RETRYABLE = new Set([-32001, -32000]);

export class McpDataSource {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private server: McpServerRef;
  private readonly timeoutMs: number;
  private readonly maxResultBytes: number;
  private readonly maxRetries: number;

  constructor(private readonly opts: McpDataSourceOptions) {
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxResultBytes = opts.maxResultBytes ?? 1_000_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.server = {
      name: opts.name,
      url: opts.transport.kind === 'stdio' ? `stdio:${opts.transport.command}` : opts.transport.url,
      transport: opts.transport.kind,
      protocol_version: 'unknown',
      authenticated: opts.transport.kind !== 'stdio' && !!opts.transport.headers?.Authorization,
    };
  }

  /** What goes into provenance about the far side. Never a header, never a key. */
  get serverRef(): McpServerRef { return { ...this.server }; }

  private buildTransport(): Transport {
    const t = this.opts.transport;
    if (t.kind === 'stdio') {
      return new StdioClientTransport({ command: t.command, args: t.args ?? [], ...(t.env ? { env: t.env } : {}) });
    }
    const headers = t.headers ?? {};
    if (t.kind === 'http') {
      return new StreamableHTTPClientTransport(new URL(t.url), { requestInit: { headers } });
    }
    // Legacy HTTP+SSE. It is what the hosted Subgraph MCP speaks (POST /mcp answers 404 there, measured 2026-09-04),
    // and the SDK's own note is that clients must keep both transports during the migration. The initial GET is made
    // by `eventsource`, which does not inherit `requestInit`, so the header is re-attached through its fetch.
    return new SSEClientTransport(new URL(t.url), {
      requestInit: { headers },
      eventSourceInit: {
        fetch: (url: string | URL, init?: RequestInit) =>
          fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers ?? {})), ...headers } }),
      },
    });
  }

  async connect(): Promise<{ server: McpServerRef; tools: McpToolInfo[] }> {
    if (this.client) return { server: this.serverRef, tools: await this.listTools() };
    const client = new Client(
      { name: this.opts.clientName ?? 'ainize-mcp-client', version: this.opts.clientVersion ?? '0.1.0' },
      { capabilities: {} },
    );
    const transport = this.buildTransport();
    // The negotiated protocol version has no getter on the client; the SDK announces it to the transport instead, so
    // that is where provenance picks it up. `2025-11-25` is the SDK's latest, `2025-03-26` its default — a record
    // that says which one was actually agreed is worth the four lines.
    const original = transport.setProtocolVersion?.bind(transport);
    transport.setProtocolVersion = (version: string) => {
      this.server = { ...this.server, protocol_version: version };
      original?.(version);
    };
    try {
      await client.connect(transport);
    } catch (e) {
      throw new McpDataSourceError(
        `could not connect to ${this.server.url}: ${(e as Error).message}`,
        'mcp_unreachable',
      );
    }
    this.client = client;
    this.transport = transport;
    const info = client.getServerVersion();
    this.server = {
      ...this.server,
      ...(info?.name ? { server_name: info.name } : {}),
      ...(info?.version ? { server_version: info.version } : {}),
    };
    return { server: this.serverRef, tools: await this.listTools() };
  }

  async listTools(): Promise<McpToolInfo[]> {
    const c = this.need();
    const out = await c.listTools(undefined, { timeout: this.timeoutMs });
    return out.tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), inputSchema: t.inputSchema }));
  }

  /** The server's own instructions resource, when it has one (the Subgraph MCP's `graphql://subgraph`). */
  async readResource(uri: string): Promise<string> {
    const c = this.need();
    const out = await c.readResource({ uri }, { timeout: this.timeoutMs });
    return out.contents.map((x) => ('text' in x && typeof x.text === 'string' ? x.text : '')).join('\n');
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<McpCallResult> {
    const c = this.need();
    const started = Date.now();
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await c.callTool({ name: tool, arguments: args }, undefined, { timeout: this.timeoutMs });
        const content = (res.content ?? []) as { type?: string; text?: string }[];
        const text = content.map((b) => (typeof b.text === 'string' ? b.text : '')).join('');
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes > this.maxResultBytes) {
          throw new McpDataSourceError(
            `${tool} returned ${bytes} bytes, over the ${this.maxResultBytes}-byte cap — page the query (first: N / skip) instead of asking for everything`,
            'mcp_result_too_large',
          );
        }
        let json: unknown = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        return {
          text, json, content, isError: !!res.isError, elapsed_ms: Date.now() - started,
          provenance: {
            source: 'mcp', server: this.serverRef, tool, arguments: args,
            arguments_sha256: argumentsSha256(args), fetched_at: Date.now(),
          },
        };
      } catch (e) {
        lastError = e;
        if (e instanceof McpDataSourceError) throw e;
        const code = (e as { code?: number }).code;
        if (attempt >= this.maxRetries || !RETRYABLE.has(Number(code))) break;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    const code = (lastError as { code?: number } | null)?.code;
    throw new McpDataSourceError(
      `${tool} failed on ${this.server.name}: ${(lastError as Error)?.message ?? 'unknown error'}`,
      Number(code) === -32001 ? 'mcp_timeout' : 'mcp_call_failed',
      { jsonrpc_code: code ?? null },
    );
  }

  /**
   * One call, mapped into canonical rows with the provenance sealed over exactly those rows. This is the whole of
   * direction B's contract with direction A: what comes out goes straight into `create_training_set`.
   */
  async fetchRows(spec: {
    tool: string;
    arguments?: Record<string, unknown>;
    mapping: RowMapping;
    /** Facts that pin the answer: subgraph id, ipfs hash, block number, 30-day volume. Recorded, not invented. */
    upstream?: Record<string, string | number | boolean | null>;
    /** Stamp the provenance line on every row that has no note (default true). */
    stamp_notes?: boolean;
    /** Which `upstream` keys belong in that one-line note. Default: all of them. */
    note_fields?: string[];
  }): Promise<MappedRows & { provenance: RowProvenance; raw_bytes: number; raw: McpCallResult }> {
    const out = await this.call(spec.tool, spec.arguments ?? {});
    if (out.isError) {
      throw new McpDataSourceError(`${spec.tool} answered with an error: ${out.text.slice(0, 400)}`, 'mcp_tool_error');
    }
    if (out.json === null) {
      throw new McpDataSourceError(
        `${spec.tool} did not answer with JSON, so there is nothing to map (first 200 bytes: ${out.text.slice(0, 200)})`,
        'mcp_not_json',
      );
    }
    const mapped = mapRows(out.json, spec.mapping);
    const head = { ...out.provenance, ...(spec.upstream ? { upstream: spec.upstream } : {}) };
    const rows = spec.stamp_notes === false ? mapped.rows : withProvenanceNotes(mapped.rows, head, spec.note_fields);
    return { ...mapped, rows, provenance: sealProvenance(rows, head), raw_bytes: Buffer.byteLength(out.text, 'utf8'), raw: out };
  }

  async close(): Promise<void> {
    try { await this.client?.close(); } finally { this.client = null; this.transport = null; }
  }

  private need(): Client {
    if (!this.client) throw new McpDataSourceError(`not connected to ${this.server.url} — call connect() first`, 'mcp_not_connected');
    return this.client;
  }
}
