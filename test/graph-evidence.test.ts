import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { validateEvidence } from '../scripts/validate-graph-evidence.mjs';

const recorded = resolve('evidence/ethonline2026/tokens.jsonl');

test('the recorded live Graph evidence reconstructs all canonical rows', () => {
  const result = validateEvidence(recorded);
  assert.equal(result.rows, 20);
  assert.equal(result.authenticated, true);
  assert.equal(result.block, 25969047);
});

test('evidence verifier rejects changed rows, provenance, pins and raw responses', (context) => {
  const directory = mkdtempSync(resolve('.graph-evidence-test-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'tokens.jsonl');
  const suffixes = ['', '.provenance.json', '.evidence.json'];
  for (const mutation of ['rows', 'block', 'query', 'raw']) {
    for (const suffix of suffixes) copyFileSync(recorded + suffix, path + suffix);
    if (mutation === 'rows') writeFileSync(path, readFileSync(path, 'utf8').replace('Wrapped Ether', 'Tampered Ether'));
    else if (mutation === 'block') {
      const provenance = JSON.parse(readFileSync(`${path}.provenance.json`, 'utf8'));
      provenance.upstream.block++;
      writeFileSync(`${path}.provenance.json`, JSON.stringify(provenance));
    } else {
      const evidence = JSON.parse(readFileSync(`${path}.evidence.json`, 'utf8'));
      if (mutation === 'query') evidence.calls.query.provenance.arguments.query = '{ tokens(first: 20) { id } }';
      else evidence.calls.query.json.data.tokens[0].id = '0x0000000000000000000000000000000000000000';
      writeFileSync(`${path}.evidence.json`, JSON.stringify(evidence));
    }
    assert.throws(() => validateEvidence(path), `rejects tampered ${mutation}`);
  }
});
