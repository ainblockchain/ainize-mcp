/**
 * `drive.mjs` — a REAL MCP client for the Ainize MCP server.
 *
 * Not a unit test: this spawns `dist/bin.js` as a subprocess and speaks the protocol to it with the official SDK
 * client (initialize → tools/list → resources/list → tools/call), exactly as Claude Code or Cursor does. Everything
 * that crosses the wire is written to a JSONL transcript so a claim in a report can be checked against the bytes.
 *
 *   node packages/mcp/scripts/drive.mjs <scenario.mjs> [--out <dir>]
 *
 * A scenario module default-exports `async ({ session, log, out }) => {}`; `session(env)` connects one client.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '../../..');
const BIN = join(REPO, 'packages/mcp/dist/bin.js');

/** One transcript file per run; every request and every answer, with the wall clock and the elapsed time. */
export class Transcript {
  constructor(path) { this.path = path; this.seq = 0; mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, ''); }
  write(rec) {
    const line = { seq: ++this.seq, at: new Date().toISOString(), ...rec };
    appendFileSync(this.path, `${JSON.stringify(line)}\n`);
    return line;
  }
}

export async function connect({ env = {}, transcript, label = 'session', args = [] }) {
  const stderr = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, ...args],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ainize-adversarial-driver', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  transport.stderr?.on('data', (b) => { for (const l of String(b).split('\n')) if (l.trim()) stderr.push(l); });

  const serverInfo = client.getServerVersion();
  const instructions = client.getInstructions();
  transcript.write({ kind: 'connect', label, env_keys: Object.keys(env).sort(), server: serverInfo, protocol: transport.protocolVersion ?? null, instructions_bytes: (instructions ?? '').length });

  const call = async (name, args = {}, note) => {
    const t0 = Date.now();
    let res;
    try {
      res = await client.callTool({ name, arguments: args }, undefined, { timeout: 25 * 60_000 });
    } catch (err) {
      const rec = transcript.write({ kind: 'call', label, tool: name, note, args, ms: Date.now() - t0, protocol_error: String(err?.message ?? err) });
      return { protocolError: String(err?.message ?? err), isError: true, data: {}, text: '', rec };
    }
    const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const data = res.structuredContent ?? (text ? safeJson(text) : {});
    transcript.write({ kind: 'call', label, tool: name, note, args, ms: Date.now() - t0, isError: !!res.isError, result: data });
    return { isError: !!res.isError, data, text };
  };

  return {
    client, call, stderr,
    tools: async () => {
      const l = await client.listTools();
      transcript.write({ kind: 'tools/list', label, names: l.tools.map((t) => t.name) });
      return l.tools;
    },
    resources: async () => {
      const l = await client.listResources();
      transcript.write({ kind: 'resources/list', label, uris: l.resources.map((r) => r.uri) });
      return l.resources;
    },
    readResource: async (uri) => {
      const r = await client.readResource({ uri });
      transcript.write({ kind: 'resources/read', label, uri, bytes: JSON.stringify(r).length });
      return r;
    },
    instructions: () => instructions,
    close: async () => { await client.close().catch(() => {}); },
  };
}

function safeJson(t) { try { return JSON.parse(t); } catch { return { _text: t }; } }

/** Poll a job handle to a standstill through the real client, the way an agent must. */
export async function pollJob(s, jobId, { timeoutMs = 20 * 60_000, waitMs = 15_000, note } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await s.call('job_status', { job_id: jobId, wait_ms: 0 }, note);
  while (!last.isError && ['queued', 'running'].includes(String(last.data.state)) && Date.now() < deadline) {
    last = await s.call('job_status', { job_id: jobId, wait_ms: Math.min(waitMs, Math.max(500, deadline - Date.now())) }, note);
  }
  return last;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const scenario = process.argv[2];
  if (!scenario) { console.error('usage: drive.mjs <scenario.mjs>'); process.exit(2); }
  const outDir = join(REPO, 'packages/e2e/results/mcp');
  mkdirSync(outDir, { recursive: true });
  const mod = await import(pathToFileURL(resolve(scenario)).href);
  const name = scenario.replace(/.*\//, '').replace(/\.mjs$/, '');
  const transcript = new Transcript(join(outDir, `${name}.jsonl`));
  const results = [];
  const log = (...a) => { console.error(...a); };
  const check = (id, title, pass, detail) => { results.push({ id, title, pass: !!pass, detail }); transcript.write({ kind: 'check', id, title, pass: !!pass, detail }); log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${title}${detail ? ` — ${detail}` : ''}`); };
  try {
    await mod.default({ session: (env, opts = {}) => connect({ env, transcript, ...opts }), transcript, log, check, pollJob, outDir, REPO });
  } finally {
    writeFileSync(join(outDir, `${name}.checks.json`), `${JSON.stringify(results, null, 2)}\n`);
    const failed = results.filter((r) => !r.pass);
    log(`\n${results.length - failed.length}/${results.length} checks passed · transcript ${join(outDir, `${name}.jsonl`)}`);
    if (failed.length) process.exitCode = 1;
  }
}
