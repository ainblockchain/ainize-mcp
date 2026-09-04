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

/** `predicted_sha256`, `dataset_sha256`, `blob_sha256` … all name the same kind of public fact. */
const isKeepKey = (k: string): boolean => KEEP_KEYS.has(k) || k.endsWith('sha256');

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

const MARK = '\u0000';

/**
 * `safe` holds the values this payload already publishes under an allow-listed key — a tx hash, a blob sha, a record
 * hash. The SAME value written into a sentence is the same public fact, and redacting it there is how "did I already
 * pay?" used to be answered with `tx 45[redacted]`. They are masked out before the pattern pass and put back after,
 * so a shape-based rule can never hide a fact the very same answer states as a field.
 */
const scrubString = (s: string, literals: string[], safe: string[] = []): string => {
  let out = s;
  for (const lit of literals) if (lit && out.includes(lit)) out = out.split(lit).join(REDACTED);
  const held: string[] = [];
  for (const v of safe) {
    if (v.length < 16 || !out.includes(v)) continue;
    out = out.split(v).join(`${MARK}${held.length}${MARK}`);
    held.push(v);
  }
  for (const re of PATTERNS) out = out.replace(re, (m, prefix?: string) => (prefix ? `${prefix}${REDACTED}` : REDACTED));
  return held.length ? out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => held[Number(i)] ?? '') : out;
};

const CREDENTIAL_SHAPE = /^(0x)?[0-9a-fA-F]{64,}$/;

/**
 * A caller-supplied identifier, made safe to quote back in an error message. Echoing the id IS the useful half of
 * "no such quote" — it says WHICH one was wrong — but a model that pastes a private key where an id belongs must not
 * have it written into the answer, the client's transcript and the log. Anything with a credential's shape comes
 * back described instead of quoted, which also tells the caller exactly what they got wrong.
 */
export function echoId(raw: unknown, max = 48): string {
  if (typeof raw !== 'string') return JSON.stringify(raw);
  if (CREDENTIAL_SHAPE.test(raw)) {
    return `<${raw.length} hex characters, not quoted here: that is the shape of a private key or a signature, not an id>`;
  }
  return raw.length > max ? `${JSON.stringify(raw.slice(0, max))} (truncated from ${raw.length} characters)` : JSON.stringify(raw);
}

/** Deep-copy `value` with every secret removed. Cycles are cut with `"[circular]"`. */
export function scrub<T>(value: T, opts: ScrubOptions = {}): T {
  const literals = (opts.secrets ?? []).filter((s): s is string => !!s && s.length >= 8);
  const safe = publicFacts(value);
  // The guard is for a CYCLE, so membership must follow the path down and be released on the way back up. A
  // permanent visited-set turns the second, perfectly finite mention of a shared object into "[circular]" — which is
  // how `get_training_set` came back with its `preview` intact and its identical `rows` array replaced by a string.
  const onPath = new WeakSet<object>();
  const walk = (v: unknown, keyName: string | null): unknown => {
    if (typeof v === 'string') return keyName && isKeepKey(keyName) ? v : scrubString(v, literals, safe);
    if (v === null || typeof v !== 'object') return v;
    if (onPath.has(v as object)) return '[circular]';
    onPath.add(v as object);
    try {
      if (Array.isArray(v)) return v.map((x) => walk(x, keyName));
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const lower = k.toLowerCase();
        if (SECRET_KEYS.has(lower)) { out[k] = REDACTED; continue; }
        out[k] = walk(val, lower);
      }
      return out;
    } finally {
      onPath.delete(v as object);
    }
  };
  return walk(value, null) as T;
}

/** Every value this payload publishes under an allow-listed key — the facts a sentence is allowed to repeat. */
function publicFacts(value: unknown): string[] {
  const out = new Set<string>();
  const onPath = new WeakSet<object>();
  const walk = (v: unknown, keyName: string | null): void => {
    if (typeof v === 'string') { if (keyName && isKeepKey(keyName) && v.length >= 16) out.add(v); return; }
    if (v === null || typeof v !== 'object' || onPath.has(v as object)) return;
    onPath.add(v as object);
    try {
    if (Array.isArray(v)) { for (const x of v) walk(x, keyName); return; }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const lower = k.toLowerCase();
      if (SECRET_KEYS.has(lower)) continue;
      walk(val, lower);
    }
    } finally {
      onPath.delete(v as object);
    }
  };
  walk(value, null);
  return [...out];
}

/** The same treatment for a bare message (an upstream error sentence, a thrown stack). */
export const scrubText = (s: string, opts: ScrubOptions = {}): string =>
  scrubString(s, (opts.secrets ?? []).filter((x): x is string => !!x && x.length >= 8));
