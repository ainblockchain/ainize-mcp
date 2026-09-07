#!/usr/bin/env node
/**
 * `ainize-mcp` — the Ainize MCP server.
 *
 *   ainize-mcp                      stdio (what `claude mcp add ainize -- node …/dist/bin.js` spawns)
 *   ainize-mcp --http 3499          Streamable HTTP on 127.0.0.1:3499/mcp (several clients, one process)
 *
 * Configuration is env or `--config <file>`, never a tool argument (design §3.3, §8). In stdio mode stdout IS the
 * protocol channel: every diagnostic goes to stderr, and `guardStdout()` below catches the one thing this package
 * cannot control — a dependency printing at import time (`@ainize/core` → ain-util prints "secp256k1 unavailable,
 * reverting to browser version" on stdout, which is enough to make a client fail to parse the handshake).
 */
import { randomUUID } from 'node:crypto';

interface Args { http: number | null; host: string; config?: string; onlyUser: boolean; help: boolean; version: boolean }

export function parseArgs(argv: string[]): Args {
  const out: Args = { http: null, host: '127.0.0.1', config: undefined, onlyUser: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--http') out.http = Number(argv[++i]);
    else if (a?.startsWith('--http=')) out.http = Number(a.slice(7));
    else if (a === '--host') out.host = String(argv[++i]);
    else if (a === '--config') out.config = String(argv[++i]);
    else if (a === '--i-am-the-only-user') out.onlyUser = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version' || a === '-v') out.version = true;
    else if (a) throw new Error(`unknown argument: ${a}`);
  }
  if (out.http !== null && (!Number.isInteger(out.http) || out.http < 1 || out.http > 65535)) throw new Error('--http needs a port');
  return out;
}

/**
 * Keep stdout a clean JSON-RPC channel: anything that is not a JSON message is rerouted to stderr, so a chatty
 * dependency (or a stray console.log) can never corrupt the protocol. Returns the raw writer for `--help`.
 */
function guardStdout(): (s: string) => void {
  const raw = process.stdout.write.bind(process.stdout);
  const filtered = (chunk: unknown, enc?: unknown, cb?: unknown): boolean => {
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const done = typeof enc === 'function' ? enc as () => void : typeof cb === 'function' ? cb as () => void : undefined;
    if (text.startsWith('{') || text.startsWith('[')) return raw(chunk as never, enc as never, cb as never);
    process.stderr.write(text);
    done?.();
    return true;
  };
  process.stdout.write = filtered as typeof process.stdout.write;
  console.log = (...a: unknown[]) => process.stderr.write(`${a.map(String).join(' ')}\n`);
  return (s: string) => { raw(s); };
}

const HELP = `ainize-mcp — Ainize as an MCP server

  ainize-mcp                       speak MCP over stdio (default)
  ainize-mcp --http <port>         speak MCP over Streamable HTTP at http://<host>:<port>/mcp
  ainize-mcp --host <addr>         bind address for --http (default 127.0.0.1; DNS-rebinding protection on localhost)
  ainize-mcp --config <file>       JSON config; environment variables win over it
  ainize-mcp --i-am-the-only-user  allow money/mutating capabilities over --http (they are refused otherwise)

Configuration (env):
  AINIZE_NODE_URL                  the node this server speaks for            (default http://localhost:3422)
  AINIZE_OPERATOR_PASSWORD         exchanged once for a session bearer; never returned by any tool
  AINIZE_TOKEN                     a pre-existing operator session token instead of the password
  AINIZE_TEACH_KEY                 64-hex visitor teaching key, or a path to the key backup JSON
  AINIZE_MCP_SESSION_BUDGET        total spend allowed this process           (default 0 — \`buy\` is not registered)
  AINIZE_MCP_MAX_PER_PURCHASE      ceiling for one purchase                   (default: the session budget)
  AINIZE_MCP_MAX_TEACH_JOBS        daily lessons this server may spend        (default 1)
  AINIZE_MCP_ALLOW_APPLY=1         register apply_knowledge / remove_knowledge (they change a SHARED model server)
  AINIZE_MCP_ALLOW_PUBLISH=1       register publish (irreversible; refused on the AIN chain without ALLOW_AIN_PUBLISH)
  AINIZE_MCP_STATE_DIR             where the purchase journal is kept (mode 0600)

No tool takes or returns a password, a token, a key or a signature.
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stdout = guardStdout();
  if (args.help) { stdout(HELP); return; }

  // Imported AFTER the stdout guard: `@ainize/core` prints on stdout the moment it loads.
  const { loadConfig } = await import('./config.js');
  const { Context } = await import('./context.js');
  const { buildServer, SERVER_VERSION } = await import('./server.js');
  if (args.version) { stdout(`${SERVER_VERSION}\n`); return; }

  const cfg = loadConfig(args.config ? { file: args.config } : {});
  const ctx = new Context(cfg);

  // Capabilities come from the node's own answers. A node that is down is not a startup failure: the server still
  // serves its read tools and every call reports `node_unreachable` honestly.
  await ctx.resolveCapabilities().catch((e: Error) => { process.stderr.write(`[ainize-mcp] could not reach ${cfg.nodeUrl}: ${e.message}\n`); });
  const caps = ctx.capabilities();
  process.stderr.write(`[ainize-mcp] node ${cfg.nodeUrl} · capabilities ${Object.entries(caps).filter(([, v]) => v).map(([k]) => k.replace('can_', '')).join(', ') || 'none'} · budget ${ctx.budget.view().cap}\n`);

  if (args.http === null) {
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const { server } = buildServer(ctx);
    await server.connect(new StdioServerTransport());
    const stop = () => { ctx.jobs.abortAll(); void server.close().finally(() => process.exit(0)); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    return;
  }

  // A port is reachable by people who are not the operator: money and permanence over it need a deliberate act.
  const risky = [
    ...(ctx.budget.enabled ? ['a non-zero session budget'] : []),
    ...(cfg.allow.apply ? ['AINIZE_MCP_ALLOW_APPLY'] : []),
    ...(cfg.allow.publish ? ['AINIZE_MCP_ALLOW_PUBLISH'] : []),
  ];
  if (risky.length && !args.onlyUser) {
    throw new Error(`--http refuses to start with ${risky.join(' and ')}: anyone who can reach the port could spend or mutate. Pass --i-am-the-only-user if that is what you meant.`);
  }

  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { createMcpExpressApp } = await import('@modelcontextprotocol/sdk/server/express.js');
  const express = (await import('express')).default;
  const app = createMcpExpressApp({ host: args.host });
  app.use(express.json({ limit: '4mb' }));
  const sessions = new Map<string, InstanceType<typeof StreamableHTTPServerTransport>>();

  app.post('/mcp', async (req, res) => {
    const sid = req.header('mcp-session-id');
    let transport = sid ? sessions.get(sid) : undefined;
    if (!transport) {
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => { sessions.set(id, created); },
        onsessionclosed: (id: string) => { sessions.delete(id); },
      });
      transport = created;
      // One MCP server per client session — the job table and the budget are session state.
      const { server } = buildServer(ctx);
      await server.connect(created);
    }
    await transport.handleRequest(req, res, req.body);
  });
  const bySession = async (req: import('express').Request, res: import('express').Response) => {
    const t = sessions.get(req.header('mcp-session-id') ?? '');
    if (!t) { res.status(404).json({ error: 'unknown session' }); return; }
    await t.handleRequest(req, res);
  };
  app.get('/mcp', bySession);
  app.delete('/mcp', bySession);

  await new Promise<void>((resolve) => { app.listen(args.http as number, args.host, () => resolve()); });
  process.stderr.write(`[ainize-mcp] listening on http://${args.host}:${args.http}/mcp\n`);
}

main().catch((e: Error) => { process.stderr.write(`[ainize-mcp] ${e.message}\n`); process.exit(1); });
