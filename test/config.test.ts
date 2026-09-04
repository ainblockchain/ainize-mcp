import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, publicSummary, secretsOf } from '../src/config.js';
import { TEST_TEACH_KEY } from './harness.js';

test('config comes from env, and a file fills in what env does not say', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ainize-mcp-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ node_url: 'http://localhost:3499', session_budget: '2', max_teach_jobs: 3 }));
  const cfg = loadConfig({ file, env: { AINIZE_MCP_SESSION_BUDGET: '7' } as NodeJS.ProcessEnv });
  assert.equal(cfg.nodeUrl, 'http://localhost:3499');
  assert.equal(cfg.budget.session, '7', 'env wins over the file');
  assert.equal(cfg.budget.perPurchase, '7', 'the per-purchase cap defaults to the session budget');
  assert.equal(cfg.budget.teachJobs, 3);
  assert.equal(cfg.allow.apply, false);
});

test('a budget default of 0 is what disables buying', () => {
  const cfg = loadConfig({ env: { AINIZE_NODE_URL: 'http://localhost:3422' } as NodeJS.ProcessEnv });
  assert.equal(cfg.budget.session, '0');
  assert.equal(cfg.operatorPassword, null);
  assert.equal(cfg.teachKey, null);
});

test('the teaching key is parsed but never summarised as a value', () => {
  const cfg = loadConfig({ env: { AINIZE_NODE_URL: 'http://x', AINIZE_TEACH_KEY: TEST_TEACH_KEY, AINIZE_OPERATOR_PASSWORD: 'hunter2-hunter2' } as NodeJS.ProcessEnv });
  assert.ok(cfg.teachKey?.address.startsWith('0x'));
  const summary = JSON.stringify(publicSummary(cfg));
  assert.ok(!summary.includes(TEST_TEACH_KEY), 'the teaching key leaked into the public summary');
  assert.ok(!summary.includes('hunter2-hunter2'), 'the operator password leaked into the public summary');
  assert.equal(publicSummary(cfg).teaching_key_configured, true);
  assert.ok(secretsOf(cfg).includes(TEST_TEACH_KEY));
});

test('a node URL that is not a URL is refused at startup, not at the first call', () => {
  assert.throws(() => loadConfig({ env: { AINIZE_NODE_URL: 'localhost:3422' } as NodeJS.ProcessEnv }), /http\(s\) URL/);
  assert.throws(() => loadConfig({ env: { AINIZE_NODE_URL: 'http://x', AINIZE_MCP_SESSION_BUDGET: 'lots' } as NodeJS.ProcessEnv }), /non-negative number/);
});
