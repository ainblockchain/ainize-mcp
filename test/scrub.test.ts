import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTED, scrub, scrubText, echoId } from '../src/scrub.js';

const PRIVATE_KEY = `0x${'a'.repeat(64)}`;
const PASSWORD = 'e2e-pass-a-super-secret';

test('secrets planted anywhere in a result never come back out', () => {
  const out = scrub({
    ok: true,
    manifest: { download_token: 'tok-123456', patch_sha256: 'c'.repeat(64) },
    nested: [{ privateKey: PRIVATE_KEY, note: `signed with ${PRIVATE_KEY}` }],
    headers: { authorization: 'Bearer abcdef0123456789', 'x-ngram-auth': '0x1111111111111111111111111111111111111111:1788000000000:0xdeadbeef:v2' },
    error: `login failed for password ${PASSWORD}`,
    quote: { price: '5', pay_to: '0x2222222222222222222222222222222222222222' },
  }, { secrets: [PASSWORD] });

  const text = JSON.stringify(out);
  assert.ok(!text.includes(PRIVATE_KEY), 'a private key leaked');
  assert.ok(!text.includes(PASSWORD), 'the operator password leaked');
  assert.ok(!text.includes('tok-123456'), 'a download token leaked');
  assert.ok(!text.includes('abcdef0123456789'), 'a bearer token leaked');
  // a purchase manifest is redacted whole: it exists only to carry a download token
  assert.equal(out.manifest, REDACTED);
  assert.equal((out.headers as Record<string, unknown>).authorization, REDACTED);
});

test('public ledger facts survive: a tx hash has the same shape as a key and must still be readable', () => {
  const out = scrub({ tx_hash: `0x${'b'.repeat(64)}`, record_hash: 'e'.repeat(64), sha256: 'f'.repeat(64), address: '0x3333333333333333333333333333333333333333' });
  assert.equal(out.tx_hash, `0x${'b'.repeat(64)}`);
  assert.equal(out.record_hash, 'e'.repeat(64));
  assert.equal(out.address, '0x3333333333333333333333333333333333333333');
});

test('error sentences are scrubbed too, and a cycle does not hang', () => {
  assert.ok(!scrubText(`upstream: ${PRIVATE_KEY}`).includes(PRIVATE_KEY));
  const a: Record<string, unknown> = { name: 'x' };
  a.self = a;
  assert.deepEqual(scrub(a), { name: 'x', self: '[circular]' });
});

test('a download link\'s ?token= is a credential and never survives the scrubber', () => {
  const out = scrub({
    download: {
      npz_url: '/p2p/blob/abc?token=tok-download-secret-0123456789&name=lesson.npz',
      recipe_url: '/api/teach/jobs/lesson-1/recipe?token=tok-download-secret-0123456789',
    },
    prose: 'fetch it from http://localhost:3422/p2p/blob/abc?token=deadbeefdeadbeef',
  });
  const text = JSON.stringify(out);
  assert.ok(!text.includes('tok-download-secret'), text);
  assert.ok(!text.includes('deadbeefdeadbeef'), text);
  assert.ok(text.includes('name=lesson.npz'), 'the rest of the link still reads');
});

test('two fields holding the SAME object are both rendered — only a real cycle is cut', () => {
  // `get_training_set` returns its rows under `preview` and again under `rows`. A visited-set cycle guard turned the
  // second one into the string "[circular]", which is how a caller reading back a training set saw no rows at all.
  const items = [{ prompt: 'Q', answer: 'A', note: 'via MCP subgraph-mcp' }];
  const out = scrub({ preview: items, rows: items }) as { preview: unknown[]; rows: { note: string }[] };
  assert.deepEqual(out.rows, out.preview);
  assert.equal(out.rows[0]?.note, 'via MCP subgraph-mcp');
  const cyclic: Record<string, unknown> = { name: 'x' };
  cyclic.self = cyclic;
  assert.deepEqual(scrub(cyclic), { name: 'x', self: '[circular]' });
});

test('a public fact the answer already states as a field stays readable inside its own sentence', () => {
  // On the AIN chain a tx hash has exactly a private key's shape. "did I already pay?" must not answer
  // "tx 0x[redacted]" when the same answer carries the hash in `tx_hash`.
  const tx = `0x${'9'.repeat(64)}`;
  const out = scrub({
    state: 'complete',
    purchase: { tx_hash: tx },
    explanation: `krx-all-2761 is paid for and recorded on this node (tx ${tx}).`,
  }) as { explanation: string };
  assert.ok(out.explanation.includes(tx), out.explanation);
});

test('a key-shaped value the answer does NOT publish is still redacted in prose', () => {
  const stray = `0x${'a'.repeat(64)}`;
  const out = scrub({ explanation: `the operator signed with ${stray}` }) as { explanation: string };
  assert.ok(!out.explanation.includes(stray), out.explanation);
});

test('echoId quotes an id, elides a credential-shaped one, and truncates a long one', () => {
  assert.equal(echoId('krx-all-2761'), '"krx-all-2761"');
  assert.equal(echoId('q_1ab330a275a0'), '"q_1ab330a275a0"');
  const key = '4c0883a69102937d6231471b5dbb6204fe512961708279f2c9e1a1b0b8b4f0a1';
  const said = echoId(key);
  assert.ok(!said.includes(key) && !said.includes(key.slice(0, 24)), said);
  assert.match(said, /private key/);
  assert.match(echoId(`0x${key}`), /private key/);
  assert.match(echoId('x'.repeat(200)), /truncated from 200 characters/);
});
