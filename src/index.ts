/** Library entry: everything a test, a harness or the direction-B pipeline needs without spawning the binary. */
export { loadConfig, parseTeachKey, publicSummary, secretsOf, type McpConfig, type TeachKey } from './config.js';
export { AinizeClient, teachAuthHeader, teachAuthMessage, type Auth, type RequestOptions } from './client.js';
export { Context, type Capabilities, type NodeInfoView } from './context.js';
export { JobTable, JOB_TTL_MS, type Job, type JobKind, type JobState } from './jobs.js';
export { Budget, PurchaseJournal, QuoteBook, QUOTE_TTL_MS, type Quote, type QuoteItem, type JournalRow } from './money.js';
export { addAmounts, cmpAmounts, formatAmount, normalizeAmount, parseAmount, subAmounts, AmountError } from './dec.js';
export { scrub, scrubText, REDACTED } from './scrub.js';
export { fail, toToolError, splitNodeCode, ToolFailure, UnreachableError, UpstreamError, MCP_ERROR_CODES, type ToolErrorBody } from './errors.js';
export { modelLock, knowledgeRow, verification, etaNote, type ModelLockView } from './format.js';
export { allTools, buildServer, callTool, instructionsText, SERVER_NAME, SERVER_VERSION } from './server.js';
export type { ToolDef, Tier, ToolExtra } from './tools/types.js';
