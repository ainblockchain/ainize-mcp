/** One MCP server wired to one fake node, and a `call(name, args)` that goes through the real tool wrapper. */
import { loadConfig } from '../src/config.js';
import { Context } from '../src/context.js';
import { allTools, callTool } from '../src/server.js';
import type { ToolDef, ToolExtra } from '../src/tools/types.js';
import { FakeNode, OPERATOR_TOKEN } from './fake-node.js';

export const TEST_TEACH_KEY = '4c0883a69102937d6231471b5dbb6204fe512961708279f2c9e1a1b0b8b4f0a1';

const extra = {
  signal: new AbortController().signal, requestId: 1, sessionId: undefined, _meta: {},
  sendNotification: async () => {}, sendRequest: async () => ({}), authInfo: undefined,
} as unknown as ToolExtra;

export interface Harness {
  fake: FakeNode;
  ctx: Context;
  tools: Map<string, ToolDef>;
  names: string[];
  call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; data: Record<string, unknown> }>;
  stop: () => Promise<void>;
}

export async function harness(env: Record<string, string> = {}, setup?: (fake: FakeNode) => void): Promise<Harness> {
  const fake = new FakeNode();
  const url = await fake.start();
  setup?.(fake);   // capabilities are resolved once, from the node's answers — a test that changes them must do it here
  const cfg = loadConfig({ env: { AINIZE_NODE_URL: url, ...env } as NodeJS.ProcessEnv });
  const ctx = new Context(cfg);
  await ctx.resolveCapabilities();
  const defs = allTools(ctx);
  const tools = new Map(defs.map((d) => [d.name, d]));
  return {
    fake, ctx, tools, names: defs.map((d) => d.name),
    call: async (name, args = {}) => {
      const def = tools.get(name);
      if (!def) throw new Error(`tool ${name} is not registered (registered: ${[...tools.keys()].join(', ')})`);
      const res = await callTool(ctx, def, args as Record<string, never>, extra);
      return { isError: !!res.isError, data: (res.structuredContent ?? {}) as Record<string, unknown> };
    },
    stop: () => fake.stop(),
  };
}

/** An operator-and-teaching-key server with a spending budget — the full-capability shape. */
export const fullEnv = (over: Record<string, string> = {}): Record<string, string> => ({
  AINIZE_TOKEN: OPERATOR_TOKEN,
  AINIZE_TEACH_KEY: TEST_TEACH_KEY,
  AINIZE_MCP_SESSION_BUDGET: '10',
  AINIZE_MCP_ALLOW_APPLY: '1',
  ...over,
});
