import test from 'node:test';
import assert from 'node:assert/strict';

import { extractRecipes, findStructuredCards, parseMarkdownRecipes } from '../src/parse.js';
import { blobsFromJson } from '../src/transcript.js';
import { normalizeRecipe, isRecipeCandidate } from '../src/normalize.js';

const fenced = (payload) => '```recipe-card\n' + JSON.stringify(payload) + '\n```';

const CARD = {
  title: 'Test Chowder',
  description: 'Thick and smoky.',
  base_servings: 4,
  ingredients: [
    { id: 'potato', name: 'potatoes', amount: 2, unit: 'cups' },
    { name: 'salt', amount: 'to taste' }
  ],
  steps: [
    { title: 'Simmer', content: 'Simmer until tender', timer_seconds: 900 },
    'Season and serve'
  ],
  notes: ['Better on day two']
};

test('finds cards in ```recipe-card fences', () => {
  const found = findStructuredCards('Here you go:\n\n' + fenced(CARD));
  assert.equal(found.length, 1);
  assert.equal(found[0].format, 'fence:recipe-card');
  assert.equal(found[0].card.title, 'Test Chowder');
});

test('finds cards in <recipe-card> tags and bare inline JSON', () => {
  const tagged = findStructuredCards('<recipe-card>' + JSON.stringify(CARD) + '</recipe-card>');
  assert.equal(tagged.length, 1);
  assert.equal(tagged[0].format, 'tag:recipe-card');

  const inline = findStructuredCards('The card is ' + JSON.stringify(CARD) + ' — enjoy.');
  assert.equal(inline.length, 1);
  assert.equal(inline[0].format, 'inline-json');
});

test('ignores unrelated JSON and prose', () => {
  assert.equal(findStructuredCards('```json\n{"foo":1,"bar":[1,2]}\n```').length, 0);
  assert.equal(findStructuredCards('Just a chat about dinner plans.').length, 0);
  assert.equal(isRecipeCandidate({ ingredients: 'not an array' }), false);
});

test('normalises mixed-shape cards', () => {
  const recipe = normalizeRecipe(CARD, { origin: 'test' });
  assert.equal(recipe.slug, 'test-chowder');
  assert.equal(recipe.base_servings, 4);
  assert.equal(recipe.ingredients[0].amount, 2);
  assert.equal(recipe.ingredients[1].scalable, false);
  assert.equal(recipe.ingredients[1].amount_text, 'to taste');
  assert.equal(recipe.steps[0].timer_seconds, 900);
  assert.equal(recipe.steps[1].content, 'Season and serve');
  assert.deepEqual(recipe.notes, ['Better on day two']);
});

test('accepts alias keys (servings / instructions / tips)', () => {
  const recipe = normalizeRecipe({
    name: 'Alias Soup',
    serves: 6,
    ingredients: [{ item: 'stock', quantity: '1.5', measure: 'l' }],
    instructions: [{ text: 'Heat the stock', duration: '5 minutes' }],
    tips: 'Use homemade stock'
  }, {});
  assert.equal(recipe.title, 'Alias Soup');
  assert.equal(recipe.base_servings, 6);
  assert.equal(recipe.ingredients[0].name, 'stock');
  assert.equal(recipe.ingredients[0].unit, 'l');
  assert.equal(recipe.steps[0].timer_seconds, 300);
  assert.deepEqual(recipe.notes, ['Use homemade stock']);
});

test('markdown fallback reads prose recipes', () => {
  const markdown = [
    '## Garlic Noodles',
    '',
    'Fast and garlicky.',
    '',
    'Serves 3',
    '',
    '### Ingredients',
    '- 200 g noodles',
    '- 3 cloves garlic, minced',
    '',
    '### Instructions',
    '1. **Boil** Cook the noodles for 8 minutes.',
    '2. Toss with garlic butter.',
    '',
    '### Notes',
    '- Great with chilli oil'
  ].join('\n');

  const [parsed] = parseMarkdownRecipes(markdown);
  assert.equal(parsed.title, 'Garlic Noodles');
  assert.equal(parsed.base_servings, 3);
  assert.equal(parsed.ingredients.length, 2);
  assert.equal(parsed.steps[0].title, 'Boil');
  assert.equal(parsed.steps[0].timer_seconds, 480);
  assert.deepEqual(parsed.notes, ['Great with chilli oil']);
});

test('extracts several recipes from one conversation and drops duplicates', () => {
  const second = { ...CARD, title: 'Test Chowder II' };
  const conversation = {
    chat_messages: [
      { sender: 'human', text: 'give me a chowder card please' },
      { sender: 'assistant', text: 'Sure:\n' + fenced(CARD) },
      { sender: 'assistant', text: 'Here it is again:\n' + fenced(CARD) },
      { sender: 'assistant', text: 'And a variant:\n' + fenced(second) }
    ]
  };
  const source = { blobs: blobsFromJson(conversation), origin: 'test' };
  const { recipes, stats } = extractRecipes(source);
  assert.deepEqual(recipes.map((r) => r.title), ['Test Chowder', 'Test Chowder II']);
  assert.equal(stats.duplicates, 1);
});

test('--keep latest collapses revisions of the same title', () => {
  const revised = { ...CARD, base_servings: 8 };
  const source = {
    blobs: [{ text: fenced(CARD) }, { text: fenced(revised) }],
    origin: 'test'
  };
  const { recipes } = extractRecipes(source, { keep: 'latest' });
  assert.equal(recipes.length, 1);
  assert.equal(recipes[0].base_servings, 8);
});

test('slugs stay unique so batch exports never collide', () => {
  const other = { ...CARD, description: 'A different chowder' };
  const source = { blobs: [{ text: fenced(CARD) }, { text: fenced(other) }], origin: 'test' };
  const { recipes } = extractRecipes(source);
  assert.deepEqual(recipes.map((r) => r.slug), ['test-chowder', 'test-chowder-2']);
});

test('markdown fallback is skipped when a structured card is present', () => {
  const text = fenced(CARD) + '\n\n## Some Dish\n\n### Ingredients\n- 1 thing\n\n### Instructions\n1. Do it.';
  const { recipes } = extractRecipes({ blobs: [{ text }], origin: 'test' });
  assert.deepEqual(recipes.map((r) => r.title), ['Test Chowder']);
});
