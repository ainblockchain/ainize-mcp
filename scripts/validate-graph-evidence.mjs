import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { argumentsSha256, canonicalJsonl, mapRows, rowHashes, withProvenanceNotes } from '../dist/rows.js';
import { assertGraphResult, pinQuery } from '../dist/examples/graph-query.js';

export function validateEvidence(path) {
  const bytes = readFileSync(path, 'utf8');
  const provenance = JSON.parse(readFileSync(`${path}.provenance.json`, 'utf8'));
  const evidence = JSON.parse(readFileSync(`${path}.evidence.json`, 'utf8'));
  assert.equal(evidence.format, 'ainize-graph-evidence-v1');
  assert.equal(provenance.server.url, 'https://subgraphs.mcp.thegraph.com/sse');
  assert.equal(provenance.server.transport, 'sse');
  assert.deepEqual(provenance.server, evidence.server);
  const expectedTools = { search: 'search_subgraphs_by_keyword', volume: 'get_deployment_30day_query_counts', schema: 'get_schema_by_subgraph_id', probe: 'execute_query_by_subgraph_id', query: 'execute_query_by_subgraph_id' };
  for (const [name, tool] of Object.entries(expectedTools)) {
    const call = evidence.calls[name];
    assert.ok(call && !call.isError, `${name} succeeded`);
    assert.equal(call.provenance.tool, tool);
    assert.equal(call.provenance.arguments_sha256, argumentsSha256(call.provenance.arguments));
    assert.equal(call.text, call.content.map((block) => block.text ?? '').join(''));
    if (call.json !== null) assert.deepEqual(JSON.parse(call.text), call.json);
  }
  const raw = evidence.calls.query;
  const block = assertGraphResult(raw, provenance.upstream.block);
  assertGraphResult(evidence.calls.probe, block);
  assert.equal(raw.provenance.arguments.query, pinQuery(raw.provenance.arguments.query, block), 'every root field is pinned');
  assert.deepEqual(raw.provenance.arguments, provenance.arguments);
  assert.equal(provenance.arguments_sha256, argumentsSha256(provenance.arguments));
  assert.equal(provenance.arguments.subgraph_id, evidence.selection.subgraph_id);
  assert.equal(provenance.upstream.subgraph_id, evidence.selection.subgraph_id);
  assert.equal(provenance.fetched_at, raw.provenance.fetched_at);
  assert.equal(raw.json.data._meta.deployment, provenance.upstream.deployment);
  assert.equal(raw.json.data._meta.block.hash, provenance.upstream.block_hash);
  const mapped = mapRows(raw.json, evidence.mapping);
  const rows = withProvenanceNotes(mapped.rows, provenance, ['subgraph_id', 'block']);
  assert.ok(rows.length > 0, 'nonempty training dataset');
  assert.equal(evidence.items, mapped.items);
  assert.deepEqual(evidence.rejected, mapped.rejected);
  assert.equal(bytes, canonicalJsonl(rows), 'raw live response + mapping reproduces exact dataset bytes');
  assert.equal(provenance.rows, rows.length);
  assert.deepEqual(provenance.row_hashes, rowHashes(rows));
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(provenance.rows_sha256, hash);
  assert.equal(evidence.rows_sha256, hash);
  return { rows: rows.length, rejected: mapped.rejected.length, block, authenticated: provenance.server.authenticated, rows_sha256: hash };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.argv[2]) throw new Error('Usage: node scripts/validate-graph-evidence.mjs <dataset.jsonl>');
    console.log(JSON.stringify({ valid: true, ...validateEvidence(process.argv[2]) }, null, 2));
  } catch (error) {
    console.error(`Evidence validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
