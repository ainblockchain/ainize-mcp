import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, Kind } from 'graphql';
import { pinQuery, assertGraphResult } from '../src/examples/graph-query.js';
import type { McpCallResult } from '../src/datasource.js';

test('pinning constrains metadata and every root entity, including aliases and existing pins', () => {
  const pinned = pinQuery('{ _meta { block { number } } picked: tokens(first: 2, block: {number: 4}) { id } pools(first: 1) { id } }', 123);
  const operation = parse(pinned).definitions[0];
  assert.equal(operation.kind, Kind.OPERATION_DEFINITION);
  if (operation.kind !== Kind.OPERATION_DEFINITION) return;
  for (const selection of operation.selectionSet.selections) {
    assert.equal(selection.kind, Kind.FIELD);
    if (selection.kind !== Kind.FIELD) continue;
    assert.equal(selection.arguments?.filter((argument) => argument.name.value === 'block').length, 1);
  }
  assert.equal((pinned.match(/number: 123/g) ?? []).length, 3);
  assert.equal(pinQuery(pinned, 123), pinned);
});

test('pinning refuses unsupported queries and invalid blocks', () => {
  for (const block of [NaN, 0, -1, 1.5, Infinity]) assert.throws(() => pinQuery('{ _meta { block { number } } }', block));
  for (const query of ['{ tokens { id } }', 'mutation { update }', 'query($first: Int) { tokens(first: $first) { id } }', '{ ...Root } fragment Root on Query { tokens { id } }']) {
    assert.throws(() => pinQuery(query, 123));
  }
});

test('Graph errors, indexing errors and block drift cannot become successful datasets', () => {
  const result = (json: unknown, isError = false) => ({ json, isError, text: JSON.stringify(json) }) as McpCallResult;
  assert.equal(assertGraphResult(result({ data: { _meta: { block: { number: 123 } } } }), 123), 123);
  assert.throws(() => assertGraphResult(result({ data: { _meta: { block: { number: 124 } } } }), 123), /expected 123/);
  assert.throws(() => assertGraphResult(result({ errors: [{ message: 'bad query' }], data: {} })), /Graph query failed/);
  assert.throws(() => assertGraphResult(result({ data: {} })), /no valid/);
  assert.throws(() => assertGraphResult(result({ data: { _meta: { block: { number: 123 }, hasIndexingErrors: true } } })), /indexing errors/);
});
