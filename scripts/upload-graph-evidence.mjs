import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { validateEvidence } from './validate-graph-evidence.mjs';
import { loadConfig } from '../dist/config.js';
import { Context } from '../dist/context.js';
import { uploadTrainingSet } from '../dist/teach-run.js';

try {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: node scripts/upload-graph-evidence.mjs <dataset.jsonl>');
  const validation = validateEvidence(path);
  const cfg = loadConfig();
  if (!cfg.teachKey) throw new Error('Set AINIZE_TEACH_KEY to a dedicated teaching key');
  const responses = [];
  const ctx = new Context(cfg, async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).endsWith('/api/teach/datasets')) responses.push({
      method: options?.method, url: String(url), status: response.status,
      body: await response.clone().json(), received_at: new Date().toISOString(),
    });
    return response;
  });
  const policy = await ctx.client.request('/api/teach/policy');
  if (!policy.enabled) throw new Error('Target node has teaching disabled');
  const rows = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const provenance = JSON.parse(readFileSync(`${path}.provenance.json`, 'utf8'));
  const receipt = await uploadTrainingSet(ctx, { rows, provenance, name: `Graph Uniswap v3 identities at block ${validation.block}` });
  const evidence = { format: 'ainize-graph-upload-v1', node_url: cfg.nodeUrl, teaching_address: cfg.teachKey.address,
    fetched_at: new Date().toISOString(), dataset_sha256: validation.rows_sha256,
    policy, responses, receipt, training_requested: false, publication_requested: false };
  writeFileSync(`${path}.upload.json`, JSON.stringify(evidence, null, 2) + '\n');
  assert.equal(receipt.sha256_matches_prediction, true, 'Ainize stores exactly the Graph dataset bytes');
  assert.equal(receipt.rows_accepted, rows.length, 'all Graph rows accepted');
  assert.equal(receipt.sha256, validation.rows_sha256);
  console.log(JSON.stringify({ node_url: cfg.nodeUrl, dataset_id: receipt.dataset_id, rows_accepted: receipt.rows_accepted,
    sha256_matches_prediction: receipt.sha256_matches_prediction, training_requested: false, receipt: `${path}.upload.json` }, null, 2));
} catch (error) {
  console.error(`Dataset upload failed: ${error.message}`);
  process.exitCode = 1;
}
