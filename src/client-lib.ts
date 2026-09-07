/**
 * `@ngram/mcp/client` — the client half of this package, importable without the MCP server.
 *
 * The `.` entry point exists to BE an MCP server: it registers every tool definition on the SDK's server object, and
 * `bin.ts` reaches for express to serve it. A CLI that only wants the pieces — the typed node client, the MCP data
 * source that reads somebody else's server, the row canonicalisation the node's own dataset parser agrees with, and
 * the one lesson pipeline — should not carry a server it never starts, tool schemas it never registers or an HTTP
 * framework it never listens with. `test/teach-run.test.ts` walks the static import graph and fails if any of that
 * creeps back in.
 *
 * It is a structural boundary, not a speed trick, and the measurement says so: importing this file costs 489 ms
 * against 510 ms for `.` on this machine, because 390 ms of both is `@ngram/core` loading its signing stack — which
 * a buying agent imports anyway. (`@ngram/mcp/money`, which needs neither, is 11 ms.)
 *
 * Everything here is re-exported, never redefined: this file adds no behaviour of its own.
 */

// Configuration and the node client — where the credentials live, and the only place that calls `fetch`.
export { loadConfig, parseTeachKey, publicSummary, secretsOf, type McpConfig, type TeachKey } from './config.js';
export { AinizeClient, teachAuthHeader, teachAuthMessage, type Auth, type RequestOptions } from './client.js';
export { Context, type Capabilities, type NodeInfoView, type QuotaObservation } from './context.js';
export { fail, toToolError, splitNodeCode, ToolFailure, UnreachableError, UpstreamError, MCP_ERROR_CODES, type ToolErrorBody } from './errors.js';

// Direction B: rows in the shape the teach pipeline eats, and the client that fetches them from another MCP server.
export {
  canonicalJsonl, mapRows, normalizeTeachRow, promptKey, provenanceNote, rowHashes, rowsSha256, sealProvenance,
  stableJson, argumentsSha256, withProvenanceNotes, getPath,
  type MappedRows, type McpServerRef, type RowMapping, type RowProvenance, type TeachRow,
} from './rows.js';
export { McpDataSource, McpDataSourceError, type McpCallResult, type McpDataSourceOptions, type McpToolInfo, type McpTransportSpec } from './datasource.js';

// One lesson, start to finish — the same call the `teach` tool makes.
export {
  runTeachLesson, uploadTrainingSet, lessonsToday, datasetRows, preflightView, resolveCompare,
  assertLessonAllowance, reserveLesson, PREFLIGHT_MAX,
  type LessonsToday, type PreflightAnswer, type TeachLessonHooks, type TeachLessonInput, type TeachLessonResult,
  type TeachPolicy, type UploadInput,
} from './teach-run.js';
export { teachJobView, teachSentence, teachState, checksView, learnedSplit, TEACH_TERMINAL, type TeachJobRaw, type TeachStatus } from './teach-view.js';
