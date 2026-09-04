import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTED, scrub, scrubText } from '../src/scrub.js';

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
