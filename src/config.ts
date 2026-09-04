/**
 * Server configuration — env or a config file, never a tool argument (design §3.3, §8).
 *
 * The node URL is configuration on purpose: a tool that took one would let a model point a publish at node-a and the
 * shared AIN chain with one wrong string. Operators who want several nodes run several server entries.
 *
 * Secrets (`AINIZE_OPERATOR_PASSWORD`, `AINIZE_TOKEN`, `AINIZE_TEACH_KEY`) live here and nowhere else: no tool takes
 * one, no result returns one, and `publicSummary()` is what the model is allowed to know about them (booleans).
 */
import { existsSync, readFileSync } from 'node:fs';
import { identityFromPrivateKey } from '@ngram/core';
import { normalizeAmount } from './dec.js';

export interface TeachKey { privateKey: string; address: string }

export interface McpConfig {
  nodeUrl: string;
  /** Exchanged once at startup for an in-memory bearer; never stored, never returned. */
  operatorPassword: string | null;
  /** A pre-existing session token (alternative to the password). */
  token: string | null;
  teachKey: TeachKey | null;
  budget: {
    /** Total spend allowed for the life of this process. `"0"` → the `buy` tool is not registered at all. */
    session: string;
    /** Ceiling for a single purchase; defaults to the session budget. */
    perPurchase: string;
    /** Daily lessons this server may spend (teach tier — a lesson is scarce like money, design §6.7). */
    teachJobs: number;
  };
  allow: { apply: boolean; publish: boolean; ainPublish: boolean };
  /** Where the idempotency journal is persisted (mode 0600). Null = in memory only. */
  stateDir: string | null;
  /** Where `download_lesson` writes the files it fetches. Defaults under the state dir, else the system temp dir. */
  downloadDir: string | null;
  /** Ceiling for one downloaded artefact, in bytes — a knowledge file can be hundreds of megabytes. */
  maxDownloadBytes: number;
  /** Upstream timeout for a READ call. Model/money calls set their own. */
  timeoutMs: number;
  /** How often this server asks the node how a running lesson is getting on. */
  pollMs: number;
}

const PRIV_RE = /^(0x)?[0-9a-fA-F]{64}$/;

/** A hex key, a path to the browser's key backup JSON, or that JSON itself — the same three forms the CLI accepts. */
export function parseTeachKey(raw: string): TeachKey {
  const value = raw.trim();
  if (PRIV_RE.test(value)) return keyFrom(value);
  const text = value.startsWith('{') ? value : existsSync(value) ? readFileSync(value, 'utf8') : '';
  if (!text) throw new Error(`AINIZE_TEACH_KEY: not a 64-hex key and not a readable key file: ${value.slice(0, 40)}`);
  const j = JSON.parse(text) as Record<string, unknown>;
  const hex = [j.privateKey, j.private_key, j.key, j.secret].find((v): v is string => typeof v === 'string' && PRIV_RE.test(v.trim()));
  if (!hex) throw new Error('AINIZE_TEACH_KEY: the key file has no 64-hex `privateKey`');
  return keyFrom(hex.trim());
}

function keyFrom(hex: string): TeachKey {
  const priv = hex.startsWith('0x') ? hex.slice(2) : hex;
  const id = identityFromPrivateKey(priv);
  return { privateKey: priv, address: id.address };
}

const bool = (v: string | undefined): boolean => v === '1' || v?.toLowerCase() === 'true';

export interface LoadOptions { env?: NodeJS.ProcessEnv; file?: string }

/**
 * `AINIZE_MCP_CONFIG` (or `--config`) names a JSON file with the same keys in snake_case; environment variables win
 * over it, so a checked-in file can carry the safe half (node URL, caps) while the secrets stay in the shell.
 */
export function loadConfig(opts: LoadOptions = {}): McpConfig {
  const env = opts.env ?? process.env;
  const filePath = opts.file ?? env.AINIZE_MCP_CONFIG;
  let file: Record<string, unknown> = {};
  if (filePath) {
    if (!existsSync(filePath)) throw new Error(`AINIZE_MCP_CONFIG: no such file: ${filePath}`);
    file = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  }
  const pick = (envKey: string, fileKey: string): string | undefined => {
    const e = env[envKey];
    if (e !== undefined && e !== '') return e;
    const f = file[fileKey];
    return f === undefined || f === null ? undefined : String(f);
  };

  const nodeUrl = (pick('AINIZE_NODE_URL', 'node_url') ?? 'http://localhost:3422').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(nodeUrl)) throw new Error(`AINIZE_NODE_URL must be an http(s) URL, got ${JSON.stringify(nodeUrl)}`);

  const teachRaw = pick('AINIZE_TEACH_KEY', 'teach_key') ?? pick('AINIZE_TEACH_KEY_FILE', 'teach_key_file');
  const session = normalizeAmount(pick('AINIZE_MCP_SESSION_BUDGET', 'session_budget') ?? '0', 'AINIZE_MCP_SESSION_BUDGET');
  const perPurchase = normalizeAmount(pick('AINIZE_MCP_MAX_PER_PURCHASE', 'max_per_purchase') ?? session, 'AINIZE_MCP_MAX_PER_PURCHASE');
  const teachJobs = Number(pick('AINIZE_MCP_MAX_TEACH_JOBS', 'max_teach_jobs') ?? 1);
  if (!Number.isInteger(teachJobs) || teachJobs < 0) throw new Error('AINIZE_MCP_MAX_TEACH_JOBS must be a non-negative integer');

  return {
    nodeUrl,
    operatorPassword: pick('AINIZE_OPERATOR_PASSWORD', 'operator_password') ?? null,
    token: pick('AINIZE_TOKEN', 'token') ?? null,
    teachKey: teachRaw ? parseTeachKey(teachRaw) : null,
    budget: { session, perPurchase, teachJobs },
    allow: {
      apply: bool(pick('AINIZE_MCP_ALLOW_APPLY', 'allow_apply')),
      publish: bool(pick('AINIZE_MCP_ALLOW_PUBLISH', 'allow_publish')),
      ainPublish: bool(pick('AINIZE_MCP_ALLOW_AIN_PUBLISH', 'allow_ain_publish')),
    },
    stateDir: pick('AINIZE_MCP_STATE_DIR', 'state_dir') ?? null,
    downloadDir: pick('AINIZE_MCP_DOWNLOAD_DIR', 'download_dir') ?? null,
    maxDownloadBytes: Math.max(1, Number(pick('AINIZE_MCP_MAX_DOWNLOAD_MB', 'max_download_mb') ?? 512)) * 1024 * 1024,
    timeoutMs: Number(pick('AINIZE_MCP_TIMEOUT_MS', 'timeout_ms') ?? 15_000),
    pollMs: Math.max(50, Number(pick('AINIZE_MCP_POLL_MS', 'poll_ms') ?? 3_000)),
  };
}

/** Every literal the scrubber must never let through. */
export const secretsOf = (cfg: McpConfig): string[] =>
  [cfg.operatorPassword, cfg.token, cfg.teachKey?.privateKey, cfg.teachKey ? `0x${cfg.teachKey.privateKey}` : null].filter((x): x is string => !!x);

/** What the model may know about the server's credentials: that they exist, never what they are. */
export const publicSummary = (cfg: McpConfig) => ({
  node_url: cfg.nodeUrl,
  operator_configured: !!(cfg.operatorPassword || cfg.token),
  teaching_key_configured: !!cfg.teachKey,
  teaching_key_address: cfg.teachKey?.address ?? null,
  session_budget: cfg.budget.session,
  max_per_purchase: cfg.budget.perPurchase,
  max_teach_jobs: cfg.budget.teachJobs,
  max_download_mb: Math.round(cfg.maxDownloadBytes / (1024 * 1024)),
  allow_apply: cfg.allow.apply,
  allow_publish: cfg.allow.publish,
  allow_ain_publish: cfg.allow.ainPublish,
});
