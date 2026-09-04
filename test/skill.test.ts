/**
 * The skill and the docs are only worth anything if they describe THIS server. These tests are the guard: a tool
 * renamed, added or removed breaks them, and so does a credential pasted into an example.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fullEnv, harness } from './harness.js';
import { MCP_ERROR_CODES } from '../src/errors.js';
// @ts-expect-error - the validator is plain ESM JavaScript, deliberately: a judge can run it with bare node
import { validate, parseFrontmatter, registeredToolNames, estimateTokens } from '../scripts/validate-skill.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skill = readFileSync(join(root, 'SKILL.md'), 'utf8');
const readme = readFileSync(join(root, 'README.md'), 'utf8');

test('SKILL.md passes its own validator', () => {
  const problems = validate(root) as string[];
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the body fits the skill budget, and the frontmatter says when to use it', () => {
  const { front, body } = parseFrontmatter(skill) as { front: Record<string, string>; body: string };
  assert.equal(front.name, 'ainize');
  assert.ok(estimateTokens(body) < 5000, `body is ~${estimateTokens(body)} tokens`);
  assert.match(front.description, /use when/i);
  // the triggers a client routes on
  for (const trigger of ['wrong', 'buy', 'teach', 'prove', 'quote']) {
    assert.match(front.description.toLowerCase(), new RegExp(trigger), `the description should name "${trigger}" as a trigger`);
  }
});

test('every tool this server registers is documented in the README, with a call and an answer', async (t) => {
  const h = await harness(fullEnv({ AINIZE_MCP_ALLOW_PUBLISH: '1' }));
  t.after(h.stop);
  const documented = readme.slice(readme.indexOf('## Every tool, with an example call and answer'));
  assert.ok(documented.length > 1000, 'the README must carry the per-tool reference');
  for (const name of h.names) {
    assert.ok(readme.includes(`\`${name}\``), `${name} is registered but never named in the README`);
    assert.ok(documented.includes(name), `${name} has no example call and answer in the README`);
  }
});

test('every tool the skill names is a tool the server really registers', async (t) => {
  const h = await harness(fullEnv({ AINIZE_MCP_ALLOW_PUBLISH: '1' }));
  t.after(h.stop);
  const real = new Set(h.names);
  const scanned = registeredToolNames(root) as Set<string>;
  for (const name of real) assert.ok(scanned.has(name), `the validator's source scan missed ${name}`);
  const errorCodes = new Set<string>(MCP_ERROR_CODES as readonly string[]);
  for (const m of skill.matchAll(/`([a-z][a-z_]{3,40})`/g)) {
    const word = m[1] as string;
    if (real.has(word) || errorCodes.has(word) || word.startsWith('quota_')) continue;
    if (/^(search|family|node_status|my_library|knowledge_signals|teacher_profile|live_test|job_|create_training|teach|download_lesson|publish_knowledge|apply_knowledge|remove_knowledge|reconcile_)/.test(word)) {
      assert.fail(`SKILL.md names \`${word}\`, which is not a registered tool`);
    }
  }
});

test('the skill states the two hard rules and the tiers, in words a reader cannot miss', () => {
  assert.match(skill, /Never print or pass along a session token, teaching key, password or signature/);
  assert.match(skill, /Never background-poll a human decision/);
  assert.match(skill, /Read freely/);
  assert.match(skill, /Spending or mutating/);
  // the five jobs this skill exists to do
  for (const job of ['Find knowledge that answers X', 'Prove a knowledge works', 'Buy knowledge within a budget',
    'Teach the model these facts', 'Teach the model from a subgraph']) {
    assert.ok(skill.includes(job), `SKILL.md is missing the "${job}" workflow`);
  }
});

test('the validator actually fails on a skill that is wrong', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-'));
  cpSync(join(root, 'references'), join(dir, 'references'), { recursive: true });
  cpSync(join(root, '.claude-plugin'), join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(dir, 'src', 'tools'), { recursive: true });
  writeFileSync(join(dir, 'src', 'tools', 'read.ts'), "    name: 'search_knowledge',\n");
  writeFileSync(join(dir, 'EVAL.md'), '# eval\n');

  const front = skill.slice(0, skill.indexOf('\n---\n', 4) + 5);
  const write = (body: string) => writeFileSync(join(dir, 'SKILL.md'), front + body);
  const links = ['money', 'live-test', 'teach-and-lineage', 'verification', 'errors', 'subgraph-to-dataset', 'cli']
    .map((n) => `[x](references/${n}.md)`).join(' ');

  write(`${links}\n\`no_such_tool\` is called first.\n`);
  assert.ok((validate(dir) as string[]).some((p) => p.includes('no_such_tool')), 'an unregistered tool must be caught');

  write(`${links}\nthe key is 4c0883a69102937d6231471b5dbb6204fe512961708279f2c9e1a1b0b8b4f0a1\n`);
  assert.ok((validate(dir) as string[]).some((p) => p.includes('secret-shaped')), 'a pasted key must be caught');

  write(`${links}\n${'a sha256 is fine: 67c1b685259a898c9f92ff6a8deedbfa9a2900e8bc3ca016d66840433a143890\n'}`);
  assert.deepEqual(validate(dir) as string[], [], 'a sha256 shown as evidence is not a secret');

  write(`${links}\n${'x'.repeat(5000 * 4 + 100)}\n`);
  assert.ok((validate(dir) as string[]).some((p) => p.includes('budget')), 'an over-budget body must be caught');

  write('nothing links anywhere\n');
  assert.ok((validate(dir) as string[]).some((p) => p.includes('never links to it')), 'an unlinked reference must be caught');
});

test('the UX scenarios for the MCP work name evidence that exists', () => {
  const repo = join(root, '..', '..');
  const scenarios = JSON.parse(readFileSync(join(repo, 'docs', 'ux-test-scenarios.json'), 'utf8')) as {
    id: string; area: string; automation: string; evidence: string[];
  }[];
  const mine = scenarios.filter((s) => s.area === 'mcp');
  assert.ok(mine.length >= 10, `expected the MCP scenarios to be in docs/ux-test-scenarios.json, found ${mine.length}`);
  const ids = mine.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'scenario ids must be unique');
  for (const s of mine) {
    for (const ev of s.evidence) {
      const path = ev.split(/[ :(]/)[0] as string;
      if (!path.startsWith('packages/') && !path.startsWith('docs/') && !path.startsWith('graph/')) continue;
      assert.ok(readFileSync(join(repo, path), 'utf8').length > 0, `${s.id} names ${path}, which does not exist`);
    }
  }
});
