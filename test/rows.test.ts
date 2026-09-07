/**
 * The seam between the two directions. The load-bearing assertion is the first one: our canonical hash must be the
 * NODE's canonical hash, or a caller cannot predict the training-set id, and a second upload of identical rows would
 * make a second dataset instead of landing on the first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// the node's own implementation — this is what keeps the local copy in src/rows.ts honest
import { canonicalJsonl as nodeJsonl, normalizeRow as nodeNormalize, sha256Rows as nodeSha } from '@ainize/node';
import {
  argumentsSha256, canonicalJsonl, mapRows, normalizeTeachRow, promptKey, provenanceNote, rowHashes, rowsSha256,
  sealProvenance, stableJson, withProvenanceNotes, type RowMapping, type TeachRow,
} from '../src/rows.js';

const ROWS: TeachRow[] = [
  { prompt: '픽셀플러스의  종목코드는?', answer: '087600' },
  { prompt: 'What is the WETH address?', answer: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', note: 'from a subgraph' },
  { prompt: 'Q: Who indexes this?\nA:', answer: 'The\tGraph', alt_prompt: 'Which protocol indexes it?' },
];

test('the canonical bytes and the sha256 are the node\'s own, character for character', () => {
  const mine = canonicalJsonl(ROWS);
  const theirs = nodeJsonl(ROWS.map((r) => nodeNormalize(r)));
  assert.equal(mine, theirs);
  assert.equal(rowsSha256(ROWS), nodeSha(ROWS.map((r) => nodeNormalize(r))));
  assert.ok(mine.endsWith('\n') && !mine.endsWith('\n\n'), 'exactly one trailing LF');
  assert.equal(canonicalJsonl([]), '', 'and none at all for an empty set');
});

test('normalisation matches the node row for row: NFC, invisibles, collapsed space, a flattened answer, Q:/A: unwrapped', () => {
  for (const row of ROWS) {
    const mine = normalizeTeachRow(row);
    const theirs = nodeNormalize(row);
    assert.equal(mine.prompt, theirs.prompt);
    assert.equal(mine.answer, theirs.answer);
    assert.equal(mine.alt_prompt ?? null, theirs.alt_prompt ?? null);
    assert.equal(mine.note ?? null, theirs.note ?? null);
  }
  assert.equal(normalizeTeachRow({ prompt: 'Q: Who indexes this?\nA:', answer: 'x' }).prompt, 'Who indexes this?');
  assert.equal(normalizeTeachRow({ prompt: 'a\u200bb', answer: 'x' }).prompt, 'ab', 'a zero-width space is removed, not turned into a space');
});

test('row hashes are per-row, ordered, and stable across a rebuild', () => {
  const a = rowHashes(ROWS);
  assert.equal(a.length, 3);
  assert.deepEqual(a, rowHashes(ROWS.map((r) => ({ ...r }))));
  assert.notDeepEqual(a, rowHashes([...ROWS].reverse()), 'order is part of the record');
  assert.equal(promptKey({ prompt: ' 픽셀플러스의  종목코드는? ', answer: 'x' }), '픽셀플러스의 종목코드는?');
});

test('the argument hash ignores key order but not values', () => {
  assert.equal(argumentsSha256({ a: 1, b: { c: 2, d: 3 } }), argumentsSha256({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(argumentsSha256({ a: 1 }), argumentsSha256({ a: 2 }));
  assert.equal(stableJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('a provenance note fits the node\'s 500-character cap and names what pins the fact', () => {
  const head = {
    server: { name: 'subgraph-mcp', url: 'https://subgraphs.mcp.thegraph.com/sse', transport: 'sse' as const, protocol_version: '2024-11-05', authenticated: true },
    tool: 'execute_query_by_subgraph_id',
    arguments_sha256: 'a'.repeat(64),
    upstream: { subgraph_id: '5zvR82', block: 25903086, volume_check: 'ran; every candidate reported 0' },
    fetched_at: 1788000000000,
  };
  const full = provenanceNote(head);
  assert.ok(full.length <= 500);
  assert.match(full, /via MCP subgraph-mcp · execute_query_by_subgraph_id · subgraph_id 5zvR82 · block 25903086/);
  const pinned = provenanceNote(head, ['subgraph_id', 'block']);
  assert.ok(!pinned.includes('volume_check'), 'the note carries what pins the fact; the rest stays in the record');

  const stamped = withProvenanceNotes(ROWS, head, ['subgraph_id', 'block']);
  assert.equal(stamped[1]?.note, 'from a subgraph', 'a row that already has a note keeps it');
  assert.match(String(stamped[0]?.note), /via MCP subgraph-mcp/);
});

test('a sealed provenance record hashes exactly the rows it travels with', () => {
  const p = sealProvenance(ROWS, {
    source: 'mcp',
    server: { name: 'x', url: 'https://x.invalid/sse', transport: 'sse', protocol_version: '2025-03-26', authenticated: false },
    tool: 't', arguments: { q: 1 }, arguments_sha256: argumentsSha256({ q: 1 }), fetched_at: 1,
  });
  assert.equal(p.rows, 3);
  assert.equal(p.rows_sha256, rowsSha256(ROWS));
  assert.deepEqual(p.row_hashes, rowHashes(ROWS));
});

// ------------------------------------------------------------------ the mapping

const TOKENS = {
  data: {
    _meta: { block: { number: 25903086 } },
    tokens: [
      { id: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', name: 'Wrapped Ether', decimals: '18' },
      { id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', name: 'USD Coin', decimals: '6' },
      { id: '', symbol: 'BROKEN', name: 'No address', decimals: '18' },
      { id: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', name: 'Wrapped Ether', decimals: '18' },
    ],
  },
};

const MAPPING: RowMapping = {
  path: 'data.tokens',
  prompt: 'What is the {chain} contract address of the {name} ({symbol}) token?',
  answer: '{id}',
  require: ['id', 'symbol'],
  constants: { chain: 'Ethereum mainnet' },
};

test('mapping turns a tool answer into rows, and says why every other item did not make it', () => {
  const out = mapRows(TOKENS, MAPPING);
  assert.equal(out.items, 4);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0]?.prompt, 'What is the Ethereum mainnet contract address of the Wrapped Ether (WETH) token?');
  assert.equal(out.rows[0]?.answer, '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
  assert.deepEqual(out.rejected, [
    { index: 2, reason: 'missing: id' },
    { index: 3, reason: 'duplicate: the same question was already produced' },
  ]);
});

test('the node\'s own limits are enforced where the source row can still be named', () => {
  const long = mapRows({ items: [{ q: 'x'.repeat(500), a: 'ok' }, { q: 'fine', a: 'y'.repeat(300) }] }, { path: 'items', prompt: '{q}', answer: '{a}' });
  assert.equal(long.rows.length, 0);
  assert.match(long.rejected[0]?.reason ?? '', /too_long: prompt is 500 characters/);
  assert.match(long.rejected[1]?.reason ?? '', /too_long: answer is 300 characters/);
  const capped = mapRows({ items: Array.from({ length: 5 }, (_, i) => ({ q: `q${i}`, a: 'a' })) }, { path: 'items', prompt: '{q}', answer: '{a}', max_rows: 2 });
  assert.equal(capped.rows.length, 2);
  assert.equal(capped.rejected.length, 3);
  assert.match(capped.rejected[0]?.reason ?? '', /over_cap/);
});

test('a path that selects nothing produces no rows and no pretence', () => {
  const out = mapRows({ data: {} }, MAPPING);
  assert.deepEqual(out, { rows: [], rejected: [], items: 0 });
});
