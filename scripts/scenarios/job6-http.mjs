/**
 * The other transport, driven by a real client: `ainize-mcp --http` over Streamable HTTP. Same server, same tools,
 * same refusals — and the money/mutation guard that keeps a spendable server off a port.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { connect as netConnect } from 'node:net';

/** fetch() will not forge a Host header, and Host is what the DNS-rebinding guard reads. So: a raw socket. */
function rawPost(port, host, body) {
  return new Promise((resolve) => {
    const sock = netConnect(port, '127.0.0.1', () => {
      sock.write(`POST /mcp HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
    let out = '';
    sock.on('data', (b) => { out += String(b); });
    sock.on('end', () => resolve(out));
    sock.on('error', (e) => resolve(`ERROR ${e.message}`));
    setTimeout(() => { sock.destroy(); resolve(out || 'TIMEOUT'); }, 8000);
  });
}

const PORT = Number(process.env.HTTP_PORT ?? 3991);
const NODE = process.env.ATTACK_NODE_URL ?? 'http://localhost:3402';

export default async function ({ check, log, transcript, REPO }) {
  const proc = spawn(process.execPath, [join(REPO, 'packages/mcp/dist/bin.js'), '--http', String(PORT)], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, AINIZE_NODE_URL: NODE },
  });
  let err = '';
  proc.stderr.on('data', (b) => { err += String(b); });
  try {
    await new Promise((r) => { const t = setInterval(() => { if (/listening/.test(err)) { clearInterval(t); r(); } }, 200); setTimeout(() => { clearInterval(t); r(); }, 8000); });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`));
    const client = new Client({ name: 'ainize-http-driver', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    const info = client.getServerVersion();
    const tools = (await client.listTools()).tools.map((t) => t.name);
    const res = await client.callTool({ name: 'search_knowledge', arguments: { query: 'ticker', limit: 3 } });
    const data = res.structuredContent ?? {};
    transcript.write({ kind: 'http', server: info, session: transport.sessionId, tools, rows: (data.items ?? []).length });
    check('H1', 'the Streamable HTTP transport completes a real handshake and issues a session id', !!info?.name && !!transport.sessionId, `${info?.name} ${info?.version} · session ${String(transport.sessionId).slice(0, 8)}…`);
    check('H2', 'the same tools are there and a real call answers over HTTP', tools.includes('search_knowledge') && (data.items ?? []).length > 0, `${tools.length} tools · ${(data.items ?? []).length} rows · first ${data.items?.[0]?.id}`);
    check('H3', 'a server on a port carries no money tool, because it was started without a budget', !tools.includes('buy') && !tools.includes('publish_knowledge'), tools.join(', '));
    await client.close();
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'not-a-session' };
    const forged = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'POST', headers, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    const body = await forged.text();
    check('H4', 'a forged session id is refused rather than served a tool list', forged.status >= 400 || !/search_knowledge/.test(body), `POST with a forged session id → ${forged.status} ${body.slice(0, 160)}`);
    // A DNS-rebinding attack arrives with the ATTACKER'S hostname in the Host header — which fetch() refuses to
    // forge, so this one goes down a raw socket. That is the header the SDK's localhost guard actually validates.
    const raw = await rawPost(PORT, 'evil.example.com', '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"1"}}}');
    check('H5', 'a request carrying an attacker hostname in Host is refused — the DNS-rebinding guard is real', /^HTTP\/1\.[01] (403|421|400)/.test(raw), raw.split('\r\n')[0] + ' · ' + (raw.split('\r\n\r\n')[1] ?? '').slice(0, 120));
    const good = await rawPost(PORT, `127.0.0.1:${PORT}`, '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"1"}}}');
    check('H6', 'the same request with the real Host is served, so the guard is the Host header and nothing else', /^HTTP\/1\.[01] 200/.test(good), good.split('\r\n')[0]);
    check('H7', 'the server hands out no CORS grant, so a page in a browser cannot drive it', !/access-control-allow-origin/i.test(good), (good.split('\r\n\r\n')[0] ?? '').split('\r\n').filter((h) => /^(access-control|mcp-session-id)/i.test(h)).join(' | ') || 'no access-control-* header in the response');
  } finally {
    proc.kill('SIGKILL');
  }
}
