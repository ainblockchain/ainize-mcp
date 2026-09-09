/**
 * MCP wiring: tools, resources, and the one wrapper that enforces the three tiers (design §4.0).
 *
 * Every tool result leaves through `callTool`, which is where the envelope is built, the tier rules are applied and
 * the scrubber runs. Doing it per tool would mean auditing twenty handlers for a leaked token; doing it once means
 * one place to be right.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Context } from './context.js';
import { toToolError } from './errors.js';
import { scrub } from './scrub.js';
import { readTools } from './tools/read.js';
import { liveTools } from './tools/live.js';
import { moneyTools } from './tools/money.js';
import { teachTools } from './tools/teach.js';
import type { ToolDef, ToolExtra } from './tools/types.js';

export const SERVER_NAME = 'ainize';
export const SERVER_VERSION = '0.1.0';

/** The non-optional workflow, served as a resource and as the server's `instructions` (design §5.3). */
export function instructionsText(ctx: Context): string {
  const caps = ctx.capabilities();
  const reasons = ctx.capabilityReasons();
  const off = Object.entries(caps).filter(([, v]) => !v).map(([k]) => `- ${k}: off — ${reasons[k] ?? 'not configured'}`);
  return [
    'Ainize — knowledge you can buy and knowledge you can teach, for a running LLM.',
    '',
    'A knowledge is a trained memory-table patch a node applies into the serving model. The proof that one works is',
    'a before/after on the same question, not its description.',
    '',
    'THE WORKFLOW, in order:',
    '',
    '1. Before you claim a knowledge helps, PROVE IT — with ONE `live_test` call naming the candidate in `knowledge`.',
    '   That call answers both columns itself, under one hold of the shared model lock, so nothing can move between',
    '   them. Do NOT prove it with two calls: a `knowledge: []` call unloads nothing, so a knowledge another process',
    '   left on the shared model answers along with the "base". Report both answers, the caveats, and who verified it',
    '   with what score.',
    '2. Before you spend, QUOTE. `buy` cannot be called without a `quote_id` and the total restated exactly. Show the',
    '   human the total, the base stack and the remaining session budget, and STOP. Never buy in the same turn you',
    '   first learned the price.',
    '3. Before you teach, PREFLIGHT. A daily lesson is scarce and is not refunded — the node charges one the moment a',
    '   lesson is submitted, whatever happens next. If the model already answers the questions, say so and do not',
    '   submit. `teach` does this for you and refuses with `nothing_to_train`; do not work around it.',
    '4. Everything that touches the model is a JOB. Call the tool, get a `job_id`, poll `job_status`. If the model is',
    '   held by another node, `job_status` says who and for how long — report that instead of retrying in a loop.',
    '5. Never print or pass along a session token, teaching key, password or signature. This server holds them; you',
    '   have no access and no need. No tool takes one.',
    '6. Never background-poll a human decision. The turn that shows a price and asks for approval ENDS.',
    '7. When something is not implemented, say so. Family-tree edge kinds, per-knowledge signals, bundle buys and',
    '   merge are not built yet: the tools return `null` and a note. Report the note; do not invent the number.',
    '8. A vague request is a question, not a guess. If the price, the base or the knowledge is unspecified, ask.',
    '',
    'TIERS: read freely (search_knowledge, get_knowledge, family_tree, get_training_set, node_status, my_library,',
    'knowledge_signals, teacher_profile, quote, job_status, job_list). Echo back exactly what will happen and wait',
    'for the human before anything that spends or mutates (buy, teach, apply_knowledge, remove_knowledge,',
    'publish_knowledge). Two of those cannot be undone: `buy` moves real money, and `publish_knowledge` writes a',
    'record on the ledger that nobody can recall.',
    '',
    `THIS SERVER: node ${ctx.cfg.nodeUrl}. Capabilities that are OFF right now:`,
    ...(off.length ? off : ['- (none: everything configured is available)']),
  ].join('\n');
}

function toolResult(payload: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * One call: envelope → tier extras → scrub. An error the model can act on comes back as `isError: true` with a
 * `{code, message, retryable, details}` body, never as a protocol error it cannot read.
 */
export async function callTool(ctx: Context, def: ToolDef, args: Record<string, never>, extra: ToolExtra): Promise<CallToolResult> {
  const secrets = { secrets: ctx.secrets };
  try {
    const out = await def.handler(args, extra);
    const payload: Record<string, unknown> = { ok: true, node: await ctx.envelopeNode(), ...out };
    if (def.tier === 'MODEL' && payload.model_lock === undefined) payload.model_lock = await ctx.modelLock();
    if (def.tier === 'MONEY' && payload.budget === undefined) payload.budget = ctx.budget.view();
    return toolResult(scrub(payload, secrets));
  } catch (err) {
    const body = toToolError(err);
    // Nothing in the money tier is ever safe to retry automatically: a retry is how an agent pays twice.
    if (def.tier === 'MONEY') body.retryable = false;
    const payload = { ok: false, node: await ctx.envelopeNode().catch(() => ({ url: ctx.cfg.nodeUrl })), tool: def.name, error: body, ...(def.tier === 'MONEY' ? { budget: ctx.budget.view() } : {}) };
    return toolResult(scrub(payload, secrets), true);
  }
}

export function allTools(ctx: Context): ToolDef[] {
  return [...readTools(ctx), ...liveTools(ctx), ...teachTools(ctx), ...moneyTools(ctx)];
}

/** How often a connected server re-asks the node what it can do. Cheap: one cached `/api/info` + one teach policy. */
const CAPABILITY_POLL_MS = 45_000;

/** Build one `McpServer` for one client session. Capabilities are already resolved on `ctx`. */
export function buildServer(ctx: Context): { server: McpServer; tools: ToolDef[] } {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: 'Ainize knowledge marketplace' },
    { capabilities: { tools: { listChanged: true }, resources: {} }, instructions: instructionsText(ctx) },
  );
  const tools = allTools(ctx);
  const registered = new Map<string, ReturnType<McpServer['registerTool']>>();
  const register = (def: ToolDef) => {
    registered.set(def.name, server.registerTool(def.name, {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      ...(def.annotations ? { annotations: def.annotations } : {}),
    }, ((args: Record<string, never>, extra: ToolExtra) => callTool(ctx, def, args, extra)) as never));
  };
  for (const def of tools) register(def);

  /**
   * The serving model can be stopped and restarted under a live session — a GPU gets claimed, a container is
   * recycled — and the capability set moves with it. Rebuilding the tool list here (and letting the SDK emit
   * `notifications/tools/list_changed`) is what stops a session from having to be restarted to get `live_test` back.
   * A tool that goes away is disabled rather than removed, so it can be re-enabled when the node recovers.
   */
  const syncTools = () => {
    const now = new Map(allTools(ctx).map((d) => [d.name, d]));
    for (const [name, handle] of registered) {
      const live = now.has(name);
      if (live !== handle.enabled) handle.update({ enabled: live });
    }
    for (const [name, def] of now) if (!registered.has(name)) register(def);
  };
  const watcher = () => syncTools();
  ctx.capabilityWatchers.add(watcher);
  const timer = setInterval(() => { void ctx.syncCapabilities(CAPABILITY_POLL_MS - 5_000); }, CAPABILITY_POLL_MS);
  timer.unref?.();                       // never the reason a process stays alive
  const priorClose = server.server.onclose;
  server.server.onclose = () => { clearInterval(timer); ctx.capabilityWatchers.delete(watcher); priorClose?.(); };

  server.registerResource('instructions', 'ainize://instructions', {
    title: 'Ainize server instructions',
    description: 'The non-optional workflow: prove before you claim, quote before you spend, poll instead of blocking, never print a secret.',
    mimeType: 'text/markdown',
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: instructionsText(ctx) }] }));

  server.registerResource('node', 'ainize://node/info', {
    title: 'This node',
    description: 'Identity, ledger, currency, serving model, capabilities and the session budget of the node this server speaks for.',
    mimeType: 'application/json',
  }, async (uri) => {
    const payload = scrub({
      node: await ctx.nodeInfo().catch(() => null),
      capabilities: ctx.capabilities(),
      capability_reasons: ctx.capabilityReasons(),
      teach_policy: await ctx.teachPolicy(),
      server: ctx.configSummary(),
    }, { secrets: ctx.secrets });
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) }] };
  });

  server.registerResource('budget', 'ainize://budget', {
    title: 'Session budget',
    description: 'What this MCP session may still spend, and every purchase it has journalled.',
    mimeType: 'application/json',
  }, async (uri) => {
    const payload = scrub({
      budget: ctx.budget.view(),
      purchases: ctx.journal.list().map((r) => ({ key: r.key, state: r.state, patch_id: r.patch_id, amount: r.amount, currency: r.currency, tx_hash: r.tx_hash ?? null, at: r.at })),
      note: 'the cap is server configuration (AINIZE_MCP_SESSION_BUDGET) — no tool argument can raise it',
    }, { secrets: ctx.secrets });
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) }] };
  });

  server.registerResource('openapi', 'ainize://openapi', {
    title: 'Ainize HTTP API (incomplete)',
    description: 'The node\'s own OpenAPI document, for humans reading along. It is hand-written and misses the training-set routes — never generate tools from it.',
    mimeType: 'application/json',
  }, async (uri) => {
    const doc = await ctx.client.request<Record<string, unknown>>('/api/openapi.json').catch(() => ({ error: 'the node did not answer' }));
    const text = JSON.stringify({ _warning: 'This document is hand-written in ainize-node (src/openapi.ts) and omits the /api/patches/:id/dataset* and /p2p/dataset* routes. Do not generate tools from it.', ...doc }, null, 2);
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] };
  });

  return { server, tools };
}
