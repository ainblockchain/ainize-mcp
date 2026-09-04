/**
 * One tool definition, and the three risk tiers the wrapper enforces (design §4.0).
 *
 *  READ   free, synchronous, no side effects        → `readOnlyHint`, short timeout, flattened + scrubbed result
 *  MODEL  no money, takes the shared runtime lock   → must return a job handle, never blocks, always says who holds
 *                                                     the model
 *  MONEY  spends AIN/credit or writes the ledger    → quote required, confirmation required, capped, journalled,
 *                                                     `retryable: false` on every error, never auto-retried
 */
import type { ZodRawShape } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';

export type Tier = 'READ' | 'MODEL' | 'MONEY';
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  tier: Tier;
  inputSchema: ZodRawShape;
  annotations?: ToolAnnotations;
  handler: (args: Record<string, never>, extra: ToolExtra) => Promise<Record<string, unknown>>;
}

/** Typed helper so a tool's handler sees its own argument type without casting at every call site. */
export function tool<A>(def: Omit<ToolDef, 'handler'> & { handler: (args: A, extra: ToolExtra) => Promise<Record<string, unknown>> }): ToolDef {
  return def as unknown as ToolDef;
}
