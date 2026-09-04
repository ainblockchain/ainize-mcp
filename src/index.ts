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
// Direction B: the seam another pipeline (graph/) builds on — rows in the shape direction A eats, and the client
// that fetches them from somebody else's MCP server.
export {
  canonicalJsonl, mapRows, normalizeTeachRow, promptKey, provenanceNote, rowHashes, rowsSha256, sealProvenance,
  stableJson, argumentsSha256, withProvenanceNotes, getPath,
  type MappedRows, type McpServerRef, type RowMapping, type RowProvenance, type TeachRow,
} from './rows.js';
export { McpDataSource, McpDataSourceError, type McpCallResult, type McpDataSourceOptions, type McpToolInfo, type McpTransportSpec } from './datasource.js';
export { teachTools, uploadTrainingSet, splitPreview, type UploadInput } from './tools/teach.js';
export { teachJobView, teachSentence, teachState, checksView, learnedSplit, TEACH_TERMINAL, type TeachJobRaw, type TeachStatus } from './teach-view.js';
export type { ToolDef, Tier, ToolExtra } from './tools/types.js';
