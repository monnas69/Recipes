import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatAmount, formatUnit, scaledAmountText, scaledAmountWithUnit, formatClock, formatDuration
} from '../src/shared/format.js';

const ing = (amount, unit, amount_max = null) => ({ amount, unit, amount_max, scalable: true });

test('kitchen units snap to fractions, weights stay decimal', () => {
  assert.equal(formatAmount(1.5, 'cups'), '1½');
  assert.equal(formatAmount(1 / 3, 'cup'), '⅓');
  assert.equal(formatAmount(0.125, 'tsp'), '⅛');
  assert.equal(formatAmount(187.5, 'g'), '188');
  assert.equal(formatAmount(2.25, 'ml'), '2.25');
  assert.equal(formatAmount(3, ''), '3');
});

test('units agree with the scaled amount', () => {
  assert.equal(formatUnit('cup', 2), 'cups');
  assert.equal(formatUnit('cups', 1), 'cup');
  assert.equal(formatUnit('cups', 0.5), 'cup', 'fractions read as singular');
  assert.equal(formatUnit('cloves', 1), 'clove');
  assert.equal(formatUnit('leaves', 3), 'leaves');
  assert.equal(formatUnit('tbsp', 4), 'tbsp', 'abbreviations are left alone');
  assert.equal(formatUnit('g', 400), 'g');
  assert.equal(formatUnit('', 2), '');
});

test('scaling is proportional and keeps ranges', () => {
  assert.equal(scaledAmountWithUnit(ing(1, 'cup'), 2), '2 cups');
  assert.equal(scaledAmountWithUnit(ing(1.5, 'cups'), 1 / 3), '½ cup');
  assert.equal(scaledAmountWithUnit(ing(200, 'g'), 1.5), '300 g');
  assert.equal(scaledAmountText(ing(2, 'tbsp', 3), 2), '4–6');
});

test('unscalable amounts fall back to their text', () => {
  assert.equal(scaledAmountWithUnit({ amount: null, amount_text: 'to taste', unit: '' }, 4), 'to taste');
});

test('clock and duration formatting', () => {
  assert.equal(formatClock(90), '1:30');
  assert.equal(formatClock(3725), '1:02:05');
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatDuration(90), '1 min 30 sec');
  assert.equal(formatDuration(3600), '1 hr');
});
