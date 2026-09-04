import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addAmounts, cmpAmounts, normalizeAmount, parseAmount, subAmounts, AmountError } from '../src/dec.js';

test('decimal money never goes through a float', () => {
  assert.equal(addAmounts('0.1', '0.2'), '0.3');
  assert.equal(addAmounts('25', '5', '0.5'), '30.5');
  assert.equal(subAmounts('10', '2.5'), '7.5');
  assert.equal(normalizeAmount('25.000'), '25');
  assert.equal(normalizeAmount('0.100'), '0.1');
  assert.equal(cmpAmounts('5', '5.0'), 0);
  assert.equal(cmpAmounts('5.01', '5'), 1);
  assert.equal(cmpAmounts('4.999999', '5'), -1);
});

test('a price that is not a price is refused, not coerced', () => {
  for (const bad of ['', 'free', '-1', '1e3', 'NaN', '5 AIN']) {
    assert.throws(() => parseAmount(bad), AmountError, `should refuse ${JSON.stringify(bad)}`);
  }
});
