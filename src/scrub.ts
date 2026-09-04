/**
 * The outbound scrubber (design §8.2).
 *
 * Every tool result and every error string leaves through here. Three secrets must never reach the model: the
 * operator session token (or the password that buys one), the visitor teaching key, and the node identity key that
 * signs money. They can leak by accident in three ways an author cannot audit by hand — an upstream 401/409 body
 * echoed through, a purchase manifest carrying a `download_token`, a stack trace — so redaction is a chokepoint, not
 * a per-tool discipline.
 *
 * Two rules, in this order:
 *   1. keys are redacted by NAME (`privateKey`, `token`, `download_token`, `sig`, …), whatever they contain;
 *   2. remaining strings are scanned for shapes that are always secret (`0x`+64 hex — a private key or a signature;
 *      `Bearer …`; an `x-ngram-auth` triple) and for the configured secrets by literal match.
 *
 * `KEEP_KEYS` is the deliberate exception: a tx hash, a record hash and a blob sha ARE public ledger facts and an
 * agent needs them to reconcile a purchase. On the AIN chain a tx hash has exactly the shape of a private key, so
 * without the allowlist the honest answer to "did I already pay?" would come back as `[redacted]`.
 */
const SECRET_KEYS = new Set([
  'privatekey', 'private_key', 'password', 'operator_password', 'token', 'session', 'session_token', 'download_token',
  'authorization', 'x-ngram-auth', 'auth', 'sig', 'signature', 'claim_sig', 'secret', 'api_key', 'apikey',
  'teach_key', 'teaching_key', 'mnemonic', 'seed', 'manifest',
]);

/** Public facts whose value shape collides with a secret's — never redacted by the pattern pass. */
const KEEP_KEYS = new Set([
  'tx_hash', 'record_hash', 'head', 'sha256', 'patch_sha256', 'benchmark_hash', 'rows_sha256', 'merkle_root',
  'address', 'author', 'verifier', 'payto', 'pay_to', 'buyer', 'seller', 'id', 'public_key', 'node_id', 'entry_id',
]);

export const REDACTED = '[redacted]';

const PATTERNS: RegExp[] = [
  /0x[0-9a-fA-F]{64,}/g,            // a private key or a secp256k1 signature
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi, // an operator session
  /0x[0-9a-fA-F]{40}:\d{10,}:[^\s"']+/g, // an x-ngram-auth triple (address:ts:sig[:v2])
  // A download link's `?token=` IS a credential: it opens a private draft's knowledge file for anyone holding it.
  // The node hands them out in `npz_url` / `recipe_url` / `readme_url`, which no key-name rule would catch.
  /([?&](?:token|download_token|api_key|apikey|access_token|key)=)[^&\s"']+/gi,
];

export interface ScrubOptions {
  /** Literal secrets from the server's own config — the password, the token, the teaching key. */
  secrets?: (string | null | undefined)[];
}

const scrubString = (s: string, literals: string[]): string => {
  let out = s;
  for (const lit of literals) if (lit && out.includes(lit)) out = out.split(lit).join(REDACTED);
  for (const re of PATTERNS) out = out.replace(re, (m, prefix?: string) => (prefix ? `${prefix}${REDACTED}` : REDACTED));
  return out;
};

/** Deep-copy `value` with every secret removed. Cycles are cut with `"[circular]"`. */
export function scrub<T>(value: T, opts: ScrubOptions = {}): T {
  const literals = (opts.secrets ?? []).filter((s): s is string => !!s && s.length >= 8);
  const seen = new WeakSet<object>();
  const walk = (v: unknown, keyName: string | null): unknown => {
    if (typeof v === 'string') return keyName && KEEP_KEYS.has(keyName) ? v : scrubString(v, literals);
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return '[circular]';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map((x) => walk(x, keyName));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const lower = k.toLowerCase();
      if (SECRET_KEYS.has(lower)) { out[k] = REDACTED; continue; }
      out[k] = walk(val, lower);
    }
    return out;
  };
  return walk(value, null) as T;
}

/** The same treatment for a bare message (an upstream error sentence, a thrown stack). */
export const scrubText = (s: string, opts: ScrubOptions = {}): string =>
  scrubString(s, (opts.secrets ?? []).filter((x): x is string => !!x && x.length >= 8));
