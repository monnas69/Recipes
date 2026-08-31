import test from 'node:test';
import assert from 'node:assert/strict';

import { buildShoppingList, canonicalUnit, ingredientKey, shoppingListToText } from '../planner/shared/shopping.js';
import { normalizeRecipe } from '../src/normalize.js';

const recipe = (title, ingredients, servings = 2) => normalizeRecipe({
  title,
  base_servings: servings,
  ingredients,
  steps: ['Cook it.']
}, {});

const at = (recipeCard, servings) => ({ recipe: recipeCard, servings, date: '2026-08-31' });

function find(list, name) {
  return list.items.find((item) => item.name.toLowerCase() === name.toLowerCase());
}

test('canonicalises units into convertible families', () => {
  assert.deepEqual(canonicalUnit('grams'), { unit: 'g', family: 'mass', factor: 1 });
  assert.deepEqual(canonicalUnit('Kilograms'), { unit: 'kg', family: 'mass', factor: 1000 });
  assert.deepEqual(canonicalUnit('tablespoons'), canonicalUnit('tbsp'));
  assert.equal(canonicalUnit('cups').unit, 'cup');
  assert.equal(canonicalUnit('cloves').family, canonicalUnit('clove').family, 'plurals meet their singular');
  assert.equal(canonicalUnit('').family, 'count');
  assert.notEqual(canonicalUnit('g').family, canonicalUnit('ml').family, 'mass never merges with volume');
});

test('normalises ingredient names for grouping', () => {
  assert.equal(ingredientKey('  Garlic, '), 'garlic');
  assert.equal(ingredientKey('flour (plain)'), 'flour');
  assert.equal(ingredientKey('a pinch'), 'pinch');
  assert.equal(ingredientKey(''), '');
});

test('sums the same ingredient across recipes', () => {
  const list = buildShoppingList([
    at(recipe('A', [{ name: 'flour', amount: 1, unit: 'cup' }])),
    at(recipe('B', [{ name: 'Flour', amount: 1, unit: 'cup' }]))
  ]);
  const flour = find(list, 'flour');
  assert.equal(list.itemCount, 1, 'case differences do not split the line');
  assert.equal(flour.quantities[0].text, '2 cups');
  assert.deepEqual(flour.recipes, ['A', 'B'], 'the line remembers where it came from');
});

test('converts within a family and picks a readable unit', () => {
  const list = buildShoppingList([
    at(recipe('A', [{ name: 'beef', amount: 500, unit: 'g' }])),
    at(recipe('B', [{ name: 'beef', amount: 1, unit: 'kg' }]))
  ]);
  assert.equal(find(list, 'beef').quantities[0].text, '1.5 kg');

  const small = buildShoppingList([
    at(recipe('A', [{ name: 'salt', amount: 200, unit: 'g' }])),
    at(recipe('B', [{ name: 'salt', amount: 0.3, unit: 'kg' }]))
  ]);
  assert.equal(find(small, 'salt').quantities[0].text, '500 g', 'stays in grams below a kilo');

  const spoons = buildShoppingList([
    at(recipe('A', [{ name: 'soy sauce', amount: 1, unit: 'tbsp' }])),
    at(recipe('B', [{ name: 'soy sauce', amount: 3, unit: 'tsp' }]))
  ]);
  assert.equal(find(spoons, 'soy sauce').quantities[0].text, '2 tbsp', 'teaspoons fold into tablespoons');
});

test('keeps unconvertible units apart instead of adding or dropping them', () => {
  const list = buildShoppingList([
    at(recipe('A', [{ name: 'butter', amount: 200, unit: 'g' }])),
    at(recipe('B', [{ name: 'butter', amount: 2, unit: 'cups' }]))
  ]);
  const butter = find(list, 'butter');
  assert.equal(butter.quantities.length, 2, 'grams and cups are not the same measurement');
  assert.equal(butter.split, true, 'the line is flagged for a second look');
  const texts = butter.quantities.map((q) => q.text).sort();
  assert.deepEqual(texts, ['2 cups', '200 g']);
});

test('carries unparseable amounts through as text', () => {
  const list = buildShoppingList([
    at(recipe('A', [{ name: 'salt', amount: 'to taste' }])),
    at(recipe('B', [{ name: 'salt', amount: 1, unit: 'tsp' }]))
  ]);
  const salt = find(list, 'salt');
  assert.equal(salt.quantities[0].text, '1 tsp');
  assert.deepEqual(salt.extras, ['to taste'], 'nothing a recipe asked for disappears');
});

test('scales each recipe to the servings it was planned for', () => {
  const shrimp = recipe('Shrimp', [{ name: 'shrimp', amount: 450, unit: 'g' }], 2);
  assert.equal(find(buildShoppingList([at(shrimp, 4)]), 'shrimp').quantities[0].text, '900 g');
  assert.equal(find(buildShoppingList([at(shrimp, 1)]), 'shrimp').quantities[0].text, '225 g');
  assert.equal(find(buildShoppingList([at(shrimp)]), 'shrimp').quantities[0].text, '450 g', 'defaults to the base');
});

test('does not scale ingredients marked unscalable', () => {
  const card = recipe('Brine', [
    { name: 'water', amount: 1, unit: 'l' },
    { name: 'curing salt', amount: 10, unit: 'g', scalable: false }
  ], 2);
  const list = buildShoppingList([at(card, 4)]);
  assert.equal(find(list, 'water').quantities[0].text, '2 l');
  assert.equal(find(list, 'curing salt').quantities[0].text, '10 g');
});

test('sums ranges as ranges', () => {
  const list = buildShoppingList([
    at(recipe('A', [{ name: 'chilli', amount: '1-2', unit: 'tsp' }])),
    at(recipe('B', [{ name: 'chilli', amount: '1-2', unit: 'tsp' }]))
  ]);
  assert.equal(find(list, 'chilli').quantities[0].text, '2–4 tsp');
});

test('agrees the unit with the total', () => {
  const one = buildShoppingList([at(recipe('A', [{ name: 'garlic', amount: 1, unit: 'clove' }]))]);
  assert.equal(find(one, 'garlic').quantities[0].text, '1 clove');
  const many = buildShoppingList([
    at(recipe('A', [{ name: 'garlic', amount: 4, unit: 'cloves' }])),
    at(recipe('B', [{ name: 'garlic', amount: 2, unit: 'clove' }]))
  ]);
  assert.equal(find(many, 'garlic').quantities[0].text, '6 cloves');
});

test('merges a plural spelling only when the singular is also on the list', () => {
  const both = buildShoppingList([
    at(recipe('A', [{ name: 'egg', amount: 2 }])),
    at(recipe('B', [{ name: 'eggs', amount: 3 }]))
  ]);
  assert.equal(both.itemCount, 1);
  assert.equal(both.items[0].quantities[0].text, '5');

  // "oats" must not be folded into "oat" — that group does not exist.
  const alone = buildShoppingList([at(recipe('A', [{ name: 'oats', amount: 100, unit: 'g' }]))]);
  assert.equal(alone.items[0].name, 'oats');
});

test('a merged line is labelled with the plural, whichever spelling dominates', () => {
  const list = buildShoppingList([
    at(recipe('A', [{ name: 'egg', amount: 1 }])),
    at(recipe('B', [{ name: 'egg', amount: 1 }])),
    at(recipe('C', [{ name: 'eggs', amount: 2 }]))
  ]);
  assert.equal(list.itemCount, 1);
  assert.equal(list.items[0].name, 'eggs', 'you are buying four of them, not four egg');
  assert.equal(list.items[0].quantities[0].text, '4');

  // A lone singular stays singular.
  const one = buildShoppingList([at(recipe('A', [{ name: 'egg', amount: 1 }]))]);
  assert.equal(one.items[0].name, 'egg');
});

test('an empty week produces an empty list, not an error', () => {
  const list = buildShoppingList([]);
  assert.deepEqual(list.items, []);
  assert.equal(list.recipeCount, 0);
  assert.match(shoppingListToText(list), /Nothing planned/);
  assert.deepEqual(buildShoppingList(null).items, []);
});

test('renders as plain text for the terminal and the clipboard', () => {
  const list = buildShoppingList([
    at(recipe('A', [{ name: 'flour', amount: 2, unit: 'cups' }, { name: 'salt', amount: 'to taste' }]))
  ]);
  const text = shoppingListToText(list, 'Shopping list');
  assert.match(text, /^Shopping list\n\n/);
  assert.ok(text.includes('- flour  —  2 cups'));
  assert.ok(text.includes('- salt  —  to taste'));
});

/* ---------------- free-text meals ---------------- */

test('a meal that is just a name adds nothing to the list', () => {
  const list = buildShoppingList([
    at(recipe('Soup', [{ name: 'stock', amount: 1, unit: 'l' }]), 2),
    { recipe: null, text: 'Bangers and mash', note: 'gravy', date: '2026-09-01' },
    { recipe: null, text: '   ', date: '2026-09-02' }
  ]);

  assert.equal(list.itemCount, 1, 'only the recipe contributes ingredients');
  assert.equal(list.recipeCount, 1, 'free-text meals do not inflate the meal count');
  assert.deepEqual(list.freeText, [
    { date: '2026-09-01', text: 'Bangers and mash', note: 'gravy' }
  ], 'a nameless entry is not a meal');
});

test('the text list names the meals it could not account for', () => {
  const list = buildShoppingList([
    at(recipe('Soup', [{ name: 'stock', amount: 1, unit: 'l' }]), 2),
    { recipe: null, text: 'Leftovers', date: '2026-09-01' }
  ]);

  const text = shoppingListToText(list, 'Shopping list');
  assert.match(text, /- stock/);
  assert.match(text, /Not on this list \(no recipe\):/);
  assert.match(text, /- Leftovers {2}— {2}Tue 1 Sep/);
});

test('a week of nothing but free-text meals still says so', () => {
  const only = shoppingListToText(
    buildShoppingList([{ recipe: null, text: 'Leftovers', date: '2026-09-01' }])
  );
  assert.doesNotMatch(only, /Nothing planned yet/,
    'something was planned — it just has no ingredients');
  assert.match(only, /- Leftovers/);

  assert.match(shoppingListToText(buildShoppingList([])), /Nothing planned yet/);
  assert.doesNotMatch(
    shoppingListToText(buildShoppingList([at(recipe('Soup', [{ name: 'stock', amount: 1, unit: 'l' }]), 2)])),
    /Not on this list/,
    'no free-text meals, no extra block'
  );
});
