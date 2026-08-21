import test from 'node:test';
import assert from 'node:assert/strict';

import { parseNumberToken, parseAmount, parseIngredientLine, inferTimerSeconds } from '../src/quantity.js';

test('parses whole numbers, decimals and fractions', () => {
  assert.equal(parseNumberToken('2'), 2);
  assert.equal(parseNumberToken('2.5'), 2.5);
  assert.equal(parseNumberToken('3/4'), 0.75);
  assert.equal(parseNumberToken('1 1/2'), 1.5);
  assert.equal(parseNumberToken('1½'), 1.5);
  assert.equal(parseNumberToken('¾'), 0.75);
  assert.equal(parseNumberToken('to taste'), null);
});

test('parses ranges into amount + amount_max', () => {
  assert.deepEqual(parseAmount('2-3'), { amount: 2, amount_max: 3, text: '2-3' });
  assert.deepEqual(parseAmount('1 to 2'), { amount: 1, amount_max: 2, text: '1 to 2' });
  assert.equal(parseAmount('a pinch').amount, null);
  assert.equal(parseAmount('a pinch').text, 'a pinch');
  assert.equal(parseAmount(3).amount, 3);
});

test('splits free-text ingredient lines', () => {
  assert.deepEqual(parseIngredientLine('- 1 1/2 cups all-purpose flour, sifted'), {
    amount: 1.5, amount_max: null, unit: 'cups', name: 'all-purpose flour', amount_text: '', note: 'sifted'
  });
  assert.deepEqual(parseIngredientLine('200 g spaghetti'), {
    amount: 200, amount_max: null, unit: 'g', name: 'spaghetti', amount_text: '', note: ''
  });
  const noAmount = parseIngredientLine('Salt, to taste');
  assert.equal(noAmount.amount, null);
  assert.equal(noAmount.name, 'Salt, to taste');
});

test('keeps commas that are part of the ingredient name', () => {
  const parsed = parseIngredientLine('6 anchovy fillets, in oil');
  assert.equal(parsed.amount, 6);
  assert.equal(parsed.name, 'anchovy fillets, in oil');
});

test('infers timers from step text', () => {
  assert.equal(inferTimerSeconds('Simmer for 12 minutes'), 720);
  assert.equal(inferTimerSeconds('Bake 1 hour'), 3600);
  assert.equal(inferTimerSeconds('Rest 30 seconds'), 30);
  assert.equal(inferTimerSeconds('Rest 10-15 minutes'), 900, 'ranges use the longer end');
  assert.equal(inferTimerSeconds('Serve immediately'), null);
});

test('does not mistake a fraction denominator for a whole number', () => {
  // "1/2 minutes" contains the literal substring "2 minutes" — a naive scan
  // for "<number> <unit>" latches onto that "2" and reports 2 minutes for a
  // step that actually says one-and-a-half.
  assert.equal(inferTimerSeconds('about 1 to 1 1/2 minutes'), 90);
  assert.equal(inferTimerSeconds('Marinate for 1 1/2 hours'), 5400);
  assert.equal(inferTimerSeconds('Rest for 3/4 hour'), 2700);
});
