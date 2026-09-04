/**
 * The typed HTTP client for ONE Ainize node — the only place in this package that calls `fetch`.
 *
 * Three auth mechanisms, all held here and never exposed (design §8):
 *  - `none`      the public surface (catalog, patch detail, chat status, x402 quote);
 *  - `operator`  a bearer exchanged ONCE from the configured password via `POST /api/auth/login`, kept in memory;
 *  - `teach`     a per-request `x-ngram-auth` v2 signature from the visitor teaching key. v2 headers are
 *                request-bound AND single-use — the node's replay cache refuses a second verification of the same
 *                header — so a header is built per attempt and never cached or replayed.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { signMessage } from '@ngram/core';
import type { McpConfig, TeachKey } from './config.js';
import { UnreachableError, UpstreamError } from './errors.js';

export type Auth = 'none' | 'operator' | 'teach';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  auth?: Auth;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Accept these non-2xx statuses as a normal answer (the 402 quote handshake needs 402). */
  allowStatus?: number[];
}

export interface RawResponse<T> { status: number; body: T; headers: Headers }

const sha256 = (b: string) => createHash('sha256').update(b).digest('hex');

/**
 * The string a v2 teaching-key header signs — mirrors `teachAuthMessage` in `packages/node/src/teach-auth.ts`.
 * Kept as a local 6-line copy rather than importing `@ngram/node`, whose index pulls the whole node server
 * (express, sqlite, the trainer) into an stdio process that only speaks HTTP. `test/auth.test.ts` holds the two
 * implementations to the same output.
 */
export function teachAuthMessage(t: { node: string; method: string; path: string; ts: number; body?: string | null }): string {
  const parts = ['teach', t.node, t.method.toUpperCase(), t.path, String(t.ts)];
  if (t.body) parts.push(sha256(t.body));
  return parts.join(':');
}

export function teachAuthHeader(key: TeachKey, t: { node: string; method: string; path: string; body?: string | null }, ts = Date.now()): string {
  return `${key.address}:${ts}:${signMessage(teachAuthMessage({ ...t, ts }), key.privateKey)}:v2`;
}

interface CacheEntry<T> { at: number; value: T }

export class AinizeClient {
  private operatorToken: string | null;
  private loginOnce: Promise<string | null> | null = null;
  private nodeAddress: string | null = null;
  private readonly cache = new Map<string, CacheEntry<unknown>>();

  constructor(private readonly cfg: McpConfig, private readonly fetchImpl: typeof fetch = fetch) {
    this.operatorToken = cfg.token;
  }

  get url(): string { return this.cfg.nodeUrl; }
  get hasOperator(): boolean { return !!(this.cfg.token || this.cfg.operatorPassword); }
  get hasTeachKey(): boolean { return !!this.cfg.teachKey; }
  get teachAddress(): string | null { return this.cfg.teachKey?.address ?? null; }

  /** The operator bearer, logging in at most once per process. Null when no operator credential is configured. */
  async operatorBearer(): Promise<string | null> {
    if (this.operatorToken) return this.operatorToken;
    if (!this.cfg.operatorPassword) return null;
    this.loginOnce ??= (async () => {
      const out = await this.request<{ ok: boolean; token: string }>('/api/auth/login', { method: 'POST', body: { password: this.cfg.operatorPassword }, auth: 'none' });
      this.operatorToken = out.token;      // held in memory; never returned by any tool
      return this.operatorToken;
    })();
    return this.loginOnce;
  }

  /** The node's identity address — what a v2 teaching signature is bound to. Public (`GET /api/auth/me`). */
  async address(): Promise<string> {
    this.nodeAddress ??= (await this.request<{ address: string }>('/api/auth/me')).address;
    return this.nodeAddress;
  }

  async raw<T>(path: string, opts: RequestOptions = {}): Promise<RawResponse<T>> {
    const method = opts.method ?? 'GET';
    const bodyText = opts.body === undefined ? null : JSON.stringify(opts.body);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (bodyText !== null) headers['content-type'] = 'application/json';
    if (opts.auth === 'operator') {
      const token = await this.operatorBearer();
      if (!token) throw new UpstreamError(401, { error: 'operator login required — this MCP server has no operator credential configured (AINIZE_OPERATOR_PASSWORD or AINIZE_TOKEN)' }, path);
      headers.authorization = `Bearer ${token}`;
    }
    if (opts.auth === 'teach') {
      const key = this.cfg.teachKey;
      if (!key) throw new UpstreamError(401, { error: 'invalid_signature: this MCP server has no teaching key configured (AINIZE_TEACH_KEY)' }, path);
      headers['x-ngram-auth'] = teachAuthHeader(key, { node: await this.address(), method, path, body: bodyText });
    }
    const timeout = opts.timeoutMs ?? this.cfg.timeoutMs;
    const signals = [AbortSignal.timeout(timeout), ...(opts.signal ? [opts.signal] : [])];
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.nodeUrl}${path}`, {
        method, headers, ...(bodyText !== null ? { body: bodyText } : {}),
        redirect: 'manual',                      // a redirect would replay a single-use signature (design §8.3)
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      throw new UnreachableError(this.cfg.nodeUrl, (e as Error).message);
    }
    const text = await res.text();
    const isJson = (res.headers.get('content-type') ?? '').includes('json');
    let body: unknown;
    // Not every answer is JSON: `/api/patches/:id/dataset/rows` streams ndjson, and an error page is HTML. A
    // non-JSON 2xx comes back as the raw text so the caller can parse it in the shape it actually has.
    if (!isJson && res.ok) body = text;
    else { try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 400) }; } }
    if (!res.ok && !(opts.allowStatus ?? []).includes(res.status)) {
      throw new UpstreamError(res.status, (typeof body === 'object' && body ? body : { error: String(body) }) as Record<string, unknown>, path);
    }
    return { status: res.status, body: body as T, headers: res.headers };
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return (await this.raw<T>(path, opts)).body;
  }

  /**
   * Fetch a node path straight to a file. Two reasons this is not `request()`: the bodies are binary (a knowledge
   * file is an .npz of tens of megabytes), and the node's own download links carry a short-lived token in the query
   * string — a credential, which must be used here and never returned to the model.
   */
  async download(path: string, destPath: string, opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<{ path: string; bytes: number }> {
    const max = opts.maxBytes ?? 512 * 1024 * 1024;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.nodeUrl}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs ?? 10 * 60_000) });
    } catch (e) {
      throw new UnreachableError(this.cfg.nodeUrl, (e as Error).message);
    }
    if (!res.ok) {
      const text = await res.text();
      let body: Record<string, unknown>;
      try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { error: text.slice(0, 400) }; }
      throw new UpstreamError(res.status, body, path.split('?')[0] as string);
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > max) {
      throw new UpstreamError(413, { error: `too_large: the file is ${declared} bytes, over this server's ${max}-byte download cap (AINIZE_MCP_MAX_DOWNLOAD_MB)` }, path.split('?')[0] as string);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > max) {
      throw new UpstreamError(413, { error: `too_large: the file is ${buf.byteLength} bytes, over this server's ${max}-byte download cap (AINIZE_MCP_MAX_DOWNLOAD_MB)` }, path.split('?')[0] as string);
    }
    writeFileSync(destPath, buf, { mode: 0o600 });
    return { path: destPath, bytes: buf.byteLength };
  }

  /** A short-lived read cache. `/api/info` is 60 s, `/api/teach/policy` is 10 s (it is rate-limited per IP). */
  async cached<T>(path: string, ttlMs: number, opts: RequestOptions = {}): Promise<T> {
    const hit = this.cache.get(path) as CacheEntry<T> | undefined;
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = await this.request<T>(path, opts);
    this.cache.set(path, { at: Date.now(), value });
    return value;
  }

  invalidate(path?: string): void { if (path) this.cache.delete(path); else this.cache.clear(); }
}
