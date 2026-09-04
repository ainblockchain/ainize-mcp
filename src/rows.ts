/**
 * The seam between the two directions (design §2.2, §11.3).
 *
 * Direction B (a node pulling data out of another MCP server) produces exactly one thing that direction A knows how
 * to eat: an array of `TeachRow` plus a `RowProvenance` saying where every row came from. Nothing else crosses.
 *
 * Two rules make the seam worth having:
 *
 *  1. **The hash is the node's hash.** `rowsSha256` reproduces `sha256Rows` from `packages/node/src/teach-dataset.ts`
 *     byte for byte — same NFC pass, same control/bidi/zero-width strip, same whitespace collapse, same canonical
 *     JSONL with an LF after the last row. So a caller can compute the dataset id BEFORE uploading, and a second
 *     upload of the same rows lands on the same dataset instead of making a new one. `test/rows.test.ts` holds this
 *     copy to the node's own implementation; if the node's normalisation moves, that test fails.
 *  2. **Provenance travels with the rows, not beside them.** A published knowledge has to be able to say which
 *     server, which tool, which arguments and which block its facts came from. The node's dataset API has no
 *     provenance field yet (design §11.4), so the record is written where it survives: one compact line in each
 *     row's own `note`, plus the full JSON returned to the caller and stored by `create_training_set`.
 */
import { createHash } from 'node:crypto';

export interface TeachRow {
  prompt: string;
  answer: string;
  /** A second phrasing of the same question — the node trains and checks it as an alternative form. */
  alt_prompt?: string;
  /** Where the fact came from. Published with the training set when the teacher chooses `include_notes`. */
  note?: string;
}

export interface McpServerRef {
  /** The name this side gave the connection (`subgraph-mcp`), not a secret. */
  name: string;
  url: string;
  transport: 'sse' | 'http' | 'stdio';
  protocol_version: string;
  server_name?: string;
  server_version?: string;
  /** Whether a credential was presented. The credential itself never appears anywhere in this record. */
  authenticated: boolean;
}

export interface RowProvenance {
  source: 'mcp';
  server: McpServerRef;
  tool: string;
  /**
   * The call, as made. It is the query text a buyer needs to re-run the check — but it is also the one field an API
   * key could hide in, so it leaves through the same scrubber as everything else, and `arguments_sha256` is what a
   * signature or a claim should ever be taken over.
   */
  arguments: Record<string, unknown>;
  arguments_sha256: string;
  fetched_at: number;
  /** Whatever pins the answer in time and place: subgraph id, ipfs hash, block number, 30-day query volume. */
  upstream?: Record<string, string | number | boolean | null>;
  /** sha256 of `${prompt}\n${answer}` per row, in row order. */
  row_hashes: string[];
  /** sha256 of the canonical JSONL — the id the dataset lands on. */
  rows_sha256: string;
  rows: number;
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * The control / bidi / zero-width class `packages/node/src/teach-dataset.ts` strips from every dataset field. Copied
 * rather than imported: `@ngram/node`'s entry point pulls express, sqlite and the trainer into a process that only
 * speaks HTTP. `test/rows.test.ts` proves the copy still matches.
 */
const CONTROLS = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u00ad\\u034f\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff\\ufff9-\\ufffb]', 'g');
const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
const clean = (s: string): string => collapse(String(s).normalize('NFC').replace(CONTROLS, ''));

/** One row, exactly as the node would store it after `normalizeRow` — so the sha256 below is the node's sha256. */
export function normalizeTeachRow(row: TeachRow): TeachRow {
  const prompt0 = clean(row.prompt);
  // the node unwraps a benchmark rendering ("Q: …\nA:") rather than training the literal text
  const qa = prompt0.match(/^Q\s*:\s*(.*?)\s*(?:A\s*:\s*)?$/i);
  const prompt = qa && qa[1] && /^Q\s*:/i.test(prompt0) ? qa[1] : prompt0;
  const answer = collapse(String(row.answer).normalize('NFC').replace(CONTROLS, '').replace(/[\r\n\t]+/g, ' '));
  const alt = row.alt_prompt === undefined ? undefined : clean(row.alt_prompt);
  const note = row.note === undefined ? undefined : clean(row.note).slice(0, 500);
  return { prompt, answer, ...(alt ? { alt_prompt: alt } : {}), ...(note ? { note } : {}) };
}

/**
 * `rows.jsonl` as the node writes it: keys always in the order `prompt, answer, alt_prompt, note`, absent when
 * empty, LF endings, exactly one trailing LF, none at all for an empty set.
 */
export function canonicalJsonl(rows: TeachRow[]): string {
  const norm = rows.map(normalizeTeachRow);
  return norm.map((r) => JSON.stringify({ prompt: r.prompt, answer: r.answer, ...(r.alt_prompt ? { alt_prompt: r.alt_prompt } : {}), ...(r.note ? { note: r.note } : {}) })).join('\n') + (norm.length ? '\n' : '');
}

/** The dataset id-by-content: identical bytes answer 200 with the SAME dataset instead of creating a second one. */
export const rowsSha256 = (rows: TeachRow[]): string => sha256(canonicalJsonl(rows));

/** Per-row fingerprints, in order — what lets a buyer check one fact without the whole file. */
export const rowHashes = (rows: TeachRow[]): string[] =>
  rows.map(normalizeTeachRow).map((r) => sha256(`${r.prompt}\n${r.answer}`));

/** The node's own de-dupe key for a question (prompt only — two answers to one question are a conflict, not a pair). */
export const promptKey = (row: TeachRow): string => normalizeTeachRow(row).prompt;

/**
 * The one line that fits in a row's `note` (the node caps it at 500 characters) and still answers "where did this
 * fact come from?" — server, tool, the pinning facts, and the first 12 hex of the argument hash so the full record
 * can be found again.
 */
export function provenanceNote(p: Pick<RowProvenance, 'server' | 'tool' | 'arguments_sha256' | 'upstream' | 'fetched_at'>, noteFields?: string[]): string {
  const bits = [`via MCP ${p.server.name}`, p.tool];
  for (const [k, v] of Object.entries(p.upstream ?? {})) {
    if (noteFields && !noteFields.includes(k)) continue;   // the note carries what PINS the fact; the rest stays in the record
    if (v !== null && v !== '') bits.push(`${k} ${v}`);
  }
  bits.push(`args ${p.arguments_sha256.slice(0, 12)}`);
  bits.push(new Date(p.fetched_at).toISOString().slice(0, 19) + 'Z');
  return bits.join(' · ').slice(0, 500);
}

/** Stamp the provenance line on every row that has no note of its own. An existing note is never overwritten. */
export function withProvenanceNotes(rows: TeachRow[], p: Parameters<typeof provenanceNote>[0], noteFields?: string[]): TeachRow[] {
  const note = provenanceNote(p, noteFields);
  return rows.map((r) => (r.note ? r : { ...r, note }));
}

/** Complete a provenance record once the rows are final. */
export function sealProvenance(rows: TeachRow[], partial: Omit<RowProvenance, 'row_hashes' | 'rows_sha256' | 'rows'>): RowProvenance {
  return { ...partial, row_hashes: rowHashes(rows), rows_sha256: rowsSha256(rows), rows: rows.length };
}

export const argumentsSha256 = (args: Record<string, unknown>): string => sha256(stableJson(args));

/** Key-sorted JSON so the same call hashes the same however the object was built. */
export function stableJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = walk((v as Record<string, unknown>)[k]);
    return out;
  };
  return JSON.stringify(walk(value));
}

// ------------------------------------------------------------------ mapping another server's answer into rows

/**
 * A declarative mapping from a tool result to `{prompt, answer}` rows (design §11.3). Declarative on purpose: it is
 * JSON, so it can be logged, reviewed by a human, stored in provenance and re-run — a mapping written as a closure
 * could not be any of those.
 *
 * `prompt` / `answer` / `note` are templates over the row's own fields: `{symbol}`, `{token.id}`, `{block}`.
 * `path` selects the array inside the tool's JSON answer (`data.tokens`).
 */
export interface RowMapping {
  path?: string;
  prompt: string;
  answer: string;
  note?: string;
  alt_prompt?: string;
  /** Fields (dotted paths) that must be present and non-empty, or the row is rejected with `missing:<field>`. */
  require?: string[];
  /** Extra values available to the templates but not present on the item — the block number, the chain, the source. */
  constants?: Record<string, string | number>;
  max_rows?: number;
  /** Drop a second row with the same question (the node would report it as `duplicate` anyway). Default true. */
  drop_duplicates?: boolean;
}

export interface MappedRows {
  rows: TeachRow[];
  rejected: { index: number; reason: string }[];
  /** What the mapping saw, so a caller can tell "the query returned nothing" from "everything was rejected". */
  items: number;
}

export function getPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(seg)) { cur = cur[Number(seg)]; continue; }
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

const render = (template: string, item: unknown, constants: Record<string, string | number>): string =>
  template.replace(/\{([A-Za-z0-9_.]+)\}/g, (_m, key: string) => {
    const v = key in constants ? constants[key] : getPath(item, key);
    return v === null || v === undefined ? '' : String(v);
  });

/**
 * Apply a mapping. Nothing is silently dropped: every item that does not become a row comes back in `rejected` with
 * the reason, the same contract the node's own dataset report keeps.
 */
export function mapRows(data: unknown, mapping: RowMapping): MappedRows {
  const raw = mapping.path ? getPath(data, mapping.path) : data;
  const items = Array.isArray(raw) ? raw : [];
  const constants = mapping.constants ?? {};
  const rows: TeachRow[] = [];
  const rejected: { index: number; reason: string }[] = [];
  const seen = new Set<string>();
  const max = mapping.max_rows ?? 2000;
  for (const [index, item] of items.entries()) {
    if (rows.length >= max) { rejected.push({ index, reason: `over_cap: the mapping asked for at most ${max} rows` }); continue; }
    const missing = (mapping.require ?? []).find((f) => {
      const v = f in constants ? constants[f] : getPath(item, f);
      return v === null || v === undefined || String(v).trim() === '';
    });
    if (missing) { rejected.push({ index, reason: `missing: ${missing}` }); continue; }
    const row: TeachRow = {
      prompt: render(mapping.prompt, item, constants),
      answer: render(mapping.answer, item, constants),
      ...(mapping.alt_prompt ? { alt_prompt: render(mapping.alt_prompt, item, constants) } : {}),
      ...(mapping.note ? { note: render(mapping.note, item, constants) } : {}),
    };
    const norm = normalizeTeachRow(row);
    if (!norm.prompt) { rejected.push({ index, reason: 'empty: the prompt template rendered to nothing' }); continue; }
    if (!norm.answer) { rejected.push({ index, reason: 'empty: the answer template rendered to nothing' }); continue; }
    // the node's own caps, checked here so a rejection is explained in terms of the source row, not of row 137 of a file
    if (norm.prompt.length > 400) { rejected.push({ index, reason: `too_long: prompt is ${norm.prompt.length} characters, the node's limit is 400` }); continue; }
    if (norm.answer.length > 200) { rejected.push({ index, reason: `too_long: answer is ${norm.answer.length} characters, the node's limit is 200` }); continue; }
    const key = norm.prompt;
    if (mapping.drop_duplicates !== false && seen.has(key)) { rejected.push({ index, reason: 'duplicate: the same question was already produced' }); continue; }
    seen.add(key);
    rows.push(norm);
  }
  return { rows, rejected, items: items.length };
}
