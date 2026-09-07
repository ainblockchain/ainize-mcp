#!/usr/bin/env node
/**
 * Validate SKILL.md the way the two reference skill repos validate theirs
 * (graphprotocol/subgraphs-skills · streamingfast/substreams-skills), plus the checks this product needs:
 * a skill that names a tool the server does not register, or that pastes a credential into an example, is worse
 * than no skill at all.
 *
 * Run:  node packages/mcp/scripts/validate-skill.mjs
 * Also imported by test/skill.test.ts, so `npm test -w packages/mcp` fails when the skill drifts.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Frontmatter is a fixed, tiny shape here — a YAML dependency for six keys would be worse than this parser. */
export function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) return { front: null, body: text };
  const front = {};
  const lines = m[1].split('\n');
  let key = null;
  for (const line of lines) {
    if (/^[A-Za-z_][\w.-]*:/.test(line)) {
      const i = line.indexOf(':');
      key = line.slice(0, i).trim();
      const value = line.slice(i + 1).trim();
      front[key] = value === '>-' || value === '>' || value === '|' || value === '' ? '' : value;
    } else if (key && /^\s+\S/.test(line)) {
      const nested = /^\s+([A-Za-z_][\w.-]*):\s*(.*)$/.exec(line);
      if (nested && front[key] === '') front[`${key}.${nested[1]}`] = nested[2].trim();
      else front[key] = `${front[key]} ${line.trim()}`.trim();
    }
  }
  return { front, body: m[2] };
}

/** ~4 characters per token: the budget is an order-of-magnitude guard, not an exact count. */
export const estimateTokens = (text) => Math.ceil(text.length / 4);

/** The tools the server can register, read straight out of the sources so the list cannot go stale. */
export function registeredToolNames(root = ROOT) {
  const dir = join(root, 'src', 'tools');
  const names = new Set();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(dir, file), 'utf8');
    // both the literal form (`name: 'quote',`) and the computed one (`name: kind === 'apply' ? 'apply_knowledge' : …`)
    for (const line of src.split('\n')) {
      if (!/\bname:/.test(line)) continue;
      for (const m of line.matchAll(/'([a-z][a-z_]{2,40})'/g)) names.add(m[1]);
    }
  }
  return names;
}

/** A sha256 is public evidence and belongs in the docs; a bare 64-hex anywhere else is a key until proven otherwise. */
const HASH_CONTEXT = /sha256|sha_256|hash|merkle|digest|checksum|0x[0-9a-fA-F]{64}/i;

const CREDENTIAL_PATTERNS = [
  [/\b0x[0-9a-fA-F]{64}\b/, 'a 64-hex private-key-shaped literal'],
  [/\b[0-9a-f]{64}\b/, 'a 64-hex secret-shaped literal', HASH_CONTEXT],
  [/Bearer\s+[A-Za-z0-9._-]{16,}/, 'a bearer token'],
  [/x-ainize-auth:\s*0x[0-9a-fA-F]{40}:\d+:0x[0-9a-fA-F]+/, 'a teaching-key signature'],
  [/[?&]token=[A-Za-z0-9._-]{8,}/, 'a download token'],
  [/AINIZE_OPERATOR_PASSWORD=(?!\$|\{|["']?\$)\S+/, 'a literal operator password'],
];

export function validate(root = ROOT) {
  const problems = [];
  const fail = (m) => problems.push(m);

  const skillPath = join(root, 'SKILL.md');
  if (!existsSync(skillPath)) { fail('SKILL.md is missing'); return problems; }
  const text = readFileSync(skillPath, 'utf8');
  const { front, body } = parseFrontmatter(text);

  if (!front) { fail('SKILL.md has no --- frontmatter block'); return problems; }
  for (const key of ['name', 'description', 'license', 'metadata.version', 'metadata.author', 'metadata.documentation']) {
    if (!front[key]) fail(`frontmatter is missing \`${key}\``);
  }
  if (front.name && !/^[a-z0-9-]{1,64}$/.test(front.name)) fail(`frontmatter name "${front.name}" must be 1-64 lowercase alphanumerics and hyphens`);
  if (front.description && (front.description.length < 1 || front.description.length > 1024)) {
    fail(`frontmatter description is ${front.description.length} characters; the limit is 1024`);
  }
  if (front.description && !/\buse when\b/i.test(front.description)) fail('the description must say WHEN to use the skill ("Use when …")');
  if (!front['compatibility.platforms'] && !/platforms:/.test(text)) fail('frontmatter is missing `compatibility.platforms`');

  const tokens = estimateTokens(body);
  if (tokens > 5000) fail(`the SKILL.md body is ~${tokens} tokens; the budget is 5000 — move detail into references/`);

  // every reference file is linked, and every link resolves
  const refDir = join(root, 'references');
  const refs = existsSync(refDir) ? readdirSync(refDir).filter((f) => f.endsWith('.md')) : [];
  if (!refs.length) fail('references/ has no .md files');
  for (const ref of refs) {
    if (!body.includes(`references/${ref}`)) fail(`references/${ref} exists but SKILL.md never links to it`);
  }
  for (const m of body.matchAll(/\]\((?!https?:)([^)]+)\)/g)) {
    const target = m[1].split('#')[0];
    if (target && !existsSync(join(root, target))) fail(`SKILL.md links to ${target}, which does not exist`);
  }

  // every tool the body names is a tool the server can register
  const known = registeredToolNames(root);
  const named = new Set();
  for (const m of body.matchAll(/`([a-z][a-z_]{3,40})`/g)) named.add(m[1]);
  const toolish = [...named].filter((n) => n.includes('_') && !n.startsWith('ainize_') && !/^(dry_run|job_id|quote_id|confirm_total|max_price|max_tokens|base_ids|context_ids|node_url|already_known|will_train|overlaps_listing|quota_[a-z]+|model_busy|job_not_found|nothing_to_train|teach_quota_consumed|quote_required|quote_expired|quote_mismatch|budget_exceeded|per_purchase_cap_exceeded|confirmation_required|already_purchased|idempotency_replay|permanent_ledger_refused|node_unreachable|capability_disabled|payment_settled_delivery_failed|base_rejected|base_retired|merge_not_available|invalid_request|upstream_error|rate_limited|retry_after_ms|compare_with|skip_preflight|draft_id|verified_on|free_generation|pre_apply|open_challenge|superseded_by|training_set|knowledge_file|no_pii|include_notes|dataset_id|rows_limit|credit_name|consent_[a-z]+|confirm_phrase|payout_address|idempotency_key|request_id|retry_[a-z]+|state_dir|[a-z]+_url|[a-z]+_ms|[a-z]+_at|[a-z]+_id|[a-z]+_s|[a-z]+_note|[a-z]+_ok|[a-z]+_held|[a-z]+_count|[a-z]+_name|[a-z]+_preview|[a-z]+_reasons|[a-z]+_hint)$/.test(n));
  for (const name of toolish) {
    if (!known.has(name)) fail(`SKILL.md names \`${name}\` as a tool, but no tool by that name is registered in src/tools/`);
  }

  // a skill example must never carry a credential
  for (const file of ['SKILL.md', ...refs.map((r) => join('references', r)), 'README.md', 'EVAL.md']) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, 'utf8');
    for (const [pattern, what, exempt] of CREDENTIAL_PATTERNS) {
      for (const line of content.split('\n')) {
        const hit = pattern.exec(line);
        if (!hit) continue;
        if (exempt && exempt.test(line)) continue;   // a sha256 shown as evidence, not a secret
        fail(`${file} contains ${what}: ${hit[0].slice(0, 24)}…`);
        break;
      }
    }
  }

  // the plugin metadata points at a skill that exists
  const pluginPath = join(root, '.claude-plugin', 'plugin.json');
  if (!existsSync(pluginPath)) fail('.claude-plugin/plugin.json is missing');
  else {
    let plugin;
    try { plugin = JSON.parse(readFileSync(pluginPath, 'utf8')); } catch (e) { fail(`.claude-plugin/plugin.json is not valid JSON: ${e.message}`); }
    if (plugin) {
      if (plugin.name !== front.name) fail(`plugin.json name "${plugin.name}" does not match the skill name "${front.name}"`);
      for (const skill of plugin.skills ?? []) {
        if (!existsSync(join(root, skill.path))) fail(`plugin.json points at ${skill.path}, which does not exist`);
      }
    }
  }
  const marketPath = join(root, '.claude-plugin', 'marketplace.json');
  if (!existsSync(marketPath)) fail('.claude-plugin/marketplace.json is missing');
  else { try { JSON.parse(readFileSync(marketPath, 'utf8')); } catch (e) { fail(`marketplace.json is not valid JSON: ${e.message}`); } }

  if (!existsSync(join(root, 'EVAL.md'))) fail('EVAL.md is missing');
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = validate();
  const { body } = parseFrontmatter(readFileSync(join(ROOT, 'SKILL.md'), 'utf8'));
  if (problems.length) {
    console.error(`SKILL.md: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`SKILL.md ok — body ~${estimateTokens(body)} tokens of the 5000 budget, ${readdirSync(join(ROOT, 'references')).length} reference files.`);
}
