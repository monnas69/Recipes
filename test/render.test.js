import test from 'node:test';
import assert from 'node:assert/strict';

import { renderCard, renderIndex } from '../src/render.js';
import { normalizeRecipe } from '../src/normalize.js';

const recipe = normalizeRecipe({
  title: 'Chilli <Crisp> Noodles',
  description: 'Spicy & fast',
  base_servings: 2,
  ingredients: [
    { name: 'noodles', amount: 200, unit: 'g' },
    { name: 'chilli crisp', amount: '1-2', unit: 'tbsp' },
    { name: 'salt', amount: 'to taste' }
  ],
  steps: [
    { title: 'Boil', content: 'Boil the noodles', timer_seconds: 480 },
    { title: 'Toss', content: 'Toss everything together' }
  ],
  notes: ['Use "good" chilli crisp']
}, { origin: 'test-conversation' });

const html = renderCard(recipe, { generatedAt: '2026-08-20T12:00:00.000Z' });

test('renders a complete, self-contained document', () => {
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<html lang="en">/);
  assert.ok(html.includes('</html>'));
  assert.ok(html.includes('<style>'), 'CSS is inlined');
  assert.ok(html.includes('function formatAmount'), 'formatting helpers are inlined');
  assert.ok(html.includes('window.RECIPE_DATA'), 'recipe data is embedded');
});

test('has no external references', () => {
  const external = html.match(/(?:src|href)="(?!#)[^"]*"/g) || [];
  const remote = external.filter((ref) => /https?:|\/\//.test(ref));
  assert.deepEqual(remote, [], `unexpected external references: ${remote.join(', ')}`);
  assert.ok(!/<link\b/i.test(html), 'no stylesheet links');
});

test('escapes user content everywhere it lands', () => {
  assert.ok(html.includes('Chilli &lt;Crisp&gt; Noodles'));
  assert.ok(html.includes('Use &quot;good&quot; chilli crisp'));
  assert.ok(!html.includes('<Crisp>'));
  const payload = html.split('<script type="application/json" id="recipe-json">')[1].split('</script>')[0];
  assert.ok(!payload.includes('</'), 'the embedded JSON cannot close the script tag early');
  assert.equal(JSON.parse(payload).title, 'Chilli <Crisp> Noodles');
});

test('server-rendered amounts match the base servings', () => {
  assert.ok(html.includes('>200 g<'));
  assert.ok(html.includes('>1–2 tbsp<'));
  assert.ok(html.includes('>to taste<'));
});

test('renders timers only for steps that have one', () => {
  assert.equal((html.match(/class="timer"/g) || []).length, 1);
  assert.ok(html.includes('data-seconds="480"'));
  assert.ok(html.includes('>8:00<'));
});

test('includes servings controls, checkboxes and print affordances', () => {
  assert.ok(html.includes('id="servings-range"'));
  assert.ok(html.includes('max="12"'));
  assert.equal((html.match(/data-kind="ingredient"/g) || []).length, 3);
  assert.equal((html.match(/data-kind="step"/g) || []).length, 2);
  assert.ok(html.includes('id="print-button"'));
  assert.ok(html.includes('@media print'));
  assert.ok(html.includes('prefers-color-scheme: dark'), 'dark mode support');
});

test('embeds schema.org data for other recipe apps', () => {
  const json = html.split('<script type="application/ld+json">')[1].split('</script>')[0];
  const data = JSON.parse(json);
  assert.equal(data['@type'], 'Recipe');
  assert.equal(data.recipeYield, '2 servings');
  assert.equal(data.recipeIngredient[0], '200 g noodles');
  assert.equal(data.recipeInstructions[0]['@type'], 'HowToStep');
});

test('index page links every card', () => {
  const index = renderIndex([recipe, { ...recipe, slug: 'other', title: 'Other' }], { generatedAt: '2026-08-20T12:00:00.000Z' });
  assert.ok(index.includes('href="chilli-crisp-noodles.html"'));
  assert.ok(index.includes('href="other.html"'));
  assert.ok(index.includes('2 cards'));
});

test('the index links to sibling pages only when asked', () => {
  const plain = renderIndex([recipe], {});
  assert.ok(!plain.includes('<nav class="index-nav'), 'a plain export links to nothing that may not exist');

  const linked = renderIndex([recipe], {
    links: [{ label: 'Meal planner', href: 'planner.html' }, { label: '', href: 'skip.html' }]
  });
  assert.ok(linked.includes('<nav class="index-nav no-print">'));
  assert.ok(linked.includes('href="planner.html"'));
  assert.ok(linked.includes('>Meal planner<'));
  assert.ok(!linked.includes('skip.html'), 'links without a label are dropped');
});

test('the servings label reflects the unit for batch-style recipes', () => {
  const batch = normalizeRecipe({
    title: 'Bulk Mix',
    base_servings: 10,
    servings_unit: 'kg batch',
    ingredients: [{ name: 'salt', amount: 100, unit: 'grams' }],
    steps: ['Mix everything.']
  }, {});
  const batchHtml = renderCard(batch);
  assert.ok(batchHtml.includes('id="servings-caption">Batch size<'));

  const normal = normalizeRecipe({
    title: 'Weeknight Soup',
    base_servings: 4,
    ingredients: [{ name: 'stock', amount: 1, unit: 'l' }],
    steps: ['Simmer.']
  }, {});
  assert.ok(renderCard(normal).includes('id="servings-caption">Servings<'));
});
