import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyMessage } from '@ainize/core';
// the node's own re-export — client.ts and the server now resolve to the same definition in core, and this
// test is what catches it if either ever stops doing so
import { teachAuthMessage as nodeMessage, teachAuthHeaderFor } from '@ainize/node';
import { teachAuthHeader, teachAuthMessage } from '../src/client.js';
import { parseTeachKey } from '../src/config.js';
import { TEST_TEACH_KEY } from './harness.js';

const NODE = '0x1111111111111111111111111111111111111111';

test('the v2 signing string is byte-for-byte the node\'s', () => {
  const ts = 1788000000000;
  for (const body of [null, '{"a":1}']) {
    assert.equal(
      teachAuthMessage({ node: NODE, method: 'post', path: '/api/teach/jobs?x=1', ts, body }),
      nodeMessage({ node: NODE, method: 'post', path: '/api/teach/jobs?x=1', ts, body }),
    );
  }
});

test('a header signs the exact request and verifies against the teaching key address', () => {
  const key = parseTeachKey(TEST_TEACH_KEY);
  const ts = 1788000000000;
  const header = teachAuthHeader(key, { node: NODE, method: 'GET', path: '/api/teach/jobs', body: null }, ts);
  const [address, tsStr, sig, ver] = header.split(':');
  assert.equal(address, key.address);
  assert.equal(ver, 'v2');
  assert.equal(Number(tsStr), ts);
  assert.ok(verifyMessage(nodeMessage({ node: NODE, method: 'GET', path: '/api/teach/jobs', ts, body: null }), sig as string, key.address));
  assert.equal(header, teachAuthHeaderFor(key, { node: NODE, method: 'GET', path: '/api/teach/jobs', body: null }, ts));
});

test('a header is never reused: two calls at different instants produce different signatures', () => {
  const key = parseTeachKey(TEST_TEACH_KEY);
  const a = teachAuthHeader(key, { node: NODE, method: 'GET', path: '/api/teach/jobs' }, 1788000000000);
  const b = teachAuthHeader(key, { node: NODE, method: 'GET', path: '/api/teach/jobs' }, 1788000000001);
  assert.notEqual(a, b, 'the node refuses a replayed header by design — sign per attempt');
});

test('the same key on a different route or node signs differently', () => {
  const key = parseTeachKey(TEST_TEACH_KEY);
  const ts = 1788000000000;
  const base = teachAuthHeader(key, { node: NODE, method: 'GET', path: '/api/teach/jobs' }, ts);
  assert.notEqual(base, teachAuthHeader(key, { node: NODE, method: 'GET', path: '/api/teach/datasets' }, ts));
  assert.notEqual(base, teachAuthHeader(key, { node: '0x2222222222222222222222222222222222222222', method: 'GET', path: '/api/teach/jobs' }, ts));
});
