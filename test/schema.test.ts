/**
 * Structural guards. The money and secrecy rules are only real if the SCHEMA enforces them — a sentence in a skill
 * file does not override model posture — so these assertions are shaped like a grep that fails the build.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fullEnv, harness } from './harness.js';

/** Field names are matched WORD by word: `max_tokens` is fine, a field with a `token` word in it is not. */
const CREDENTIAL_WORDS = new Set([
  'password', 'token', 'secret', 'private', 'privatekey', 'bearer', 'mnemonic', 'signature', 'sig', 'key', 'apikey',
  'auth', 'session', 'credential', 'cookie', 'url', 'endpoint', 'node', 'host',
]);
const FIELD_EXCEPTIONS = new Set(['idempotency_key']);   // a replay guard, not a credential

const credentialish = (field: string): string | null => {
  if (FIELD_EXCEPTIONS.has(field)) return null;
  return field.toLowerCase().split(/[_-]/).find((w) => CREDENTIAL_WORDS.has(w)) ?? null;
};

test('no tool anywhere takes a credential or a node URL', async (t) => {
  const h = await harness(fullEnv({ AINIZE_MCP_ALLOW_PUBLISH: '1' }));
  t.after(h.stop);
  for (const def of h.tools.values()) {
    for (const field of Object.keys(def.inputSchema)) {
      const word = credentialish(field);
      assert.equal(word, null, `${def.name} takes a field named ${field} ("${word}") — secrets and the node URL are server configuration, never tool arguments (design §8.2)`);
    }
  }
});

test('buy has no id: what gets bought is whatever the quote named', async (t) => {
  const h = await harness(fullEnv());
  t.after(h.stop);
  const buy = h.tools.get('buy');
  assert.ok(buy);
  assert.deepEqual(Object.keys(buy.inputSchema).sort(), ['apply', 'confirm', 'confirm_total', 'dry_run', 'idempotency_key', 'max_price', 'quote_id']);
  assert.equal(buy.annotations?.destructiveHint, true);
  assert.equal(buy.annotations?.idempotentHint, false);
  assert.equal(buy.tier, 'MONEY');
});

test('every tool has a description that says what it costs or that it is free', async (t) => {
  const h = await harness(fullEnv());
  t.after(h.stop);
  for (const def of h.tools.values()) {
    assert.ok(def.description.length > 80, `${def.name} needs a description an agent can route on`);
    assert.ok(def.title.length > 0);
    assert.ok(['READ', 'MODEL', 'MONEY'].includes(def.tier));
    if (def.tier === 'READ') assert.equal(def.annotations?.readOnlyHint, true, `${def.name} is READ and must be annotated read-only`);
  }
});

test('the tool set is the one the design names, and nothing operator-administrative leaked in', async (t) => {
  const h = await harness(fullEnv({ AINIZE_MCP_ALLOW_PUBLISH: '1' }));
  t.after(h.stop);
  assert.deepEqual(h.names.sort(), [
    'apply_knowledge', 'buy', 'family_tree', 'get_knowledge', 'get_training_set', 'job_cancel', 'job_list',
    'job_status', 'knowledge_signals', 'live_test', 'my_library', 'node_status', 'quote', 'reconcile_purchase',
    'remove_knowledge', 'search_knowledge', 'teacher_profile',
  ]);
  for (const forbidden of ['verify', 'challenge', 'announce', 'forget', 'runtime_complete', 'peers', 'chain_setup', 'ban']) {
    assert.ok(!h.names.includes(forbidden), `${forbidden} must not be exposed over MCP`);
  }
});

test('the instructions resource states the rules the schemas enforce', async (t) => {
  const h = await harness(fullEnv());
  t.after(h.stop);
  const { instructionsText } = await import('../src/server.js');
  const text = instructionsText(h.ctx);
  for (const rule of ['PROVE IT', 'QUOTE', 'JOB', 'Never print', 'Never background-poll']) {
    assert.ok(text.includes(rule), `the instructions must state: ${rule}`);
  }
  assert.ok(!text.includes(process.env.AINIZE_TEACH_KEY ?? 'no-key-here'));
});
