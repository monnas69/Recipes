import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildPlanner, loadRecipes } from '../planner/build.js';
import { renderPlanner, inlineModule } from '../planner/render.js';
import { writePlan, normalizePlan } from '../planner/plan-store.js';
import { normalizeRecipe } from '../src/normalize.js';
import { readCardHtml } from '../src/library.js';
import { main } from '../planner/cli.js';

const tmp = (prefix) => mkdtemp(path.join(tmpdir(), prefix));

const RECIPE = normalizeRecipe({
  title: 'Chilli <Crisp> Noodles',
  description: 'Spicy & fast',
  base_servings: 2,
  ingredients: [{ name: 'noodles', amount: 200, unit: 'g' }],
  steps: ['Boil the noodles.']
}, {});

function captureIo() {
  const out = [];
  const err = [];
  return { io: { log: (m) => out.push(String(m)), error: (m) => err.push(String(m)) }, out, err };
}

test('strips module syntax so shared code can be inlined as a classic script', () => {
  const source = [
    "import { scaledAmountWithUnit } from '../../src/shared/format.js';",
    'export const X = 1;',
    'export function go() { return "export me"; }'
  ].join('\n');
  const inlined = inlineModule(source);
  assert.ok(!/^import\s/m.test(inlined), 'imports are gone');
  assert.ok(!/^export\s/m.test(inlined), 'export keywords are gone');
  assert.ok(inlined.includes('const X = 1;'));
  assert.ok(inlined.includes('return "export me";'), 'only leading keywords are touched');
});

test('renders a self-contained page with no external references', () => {
  const html = renderPlanner({
    recipes: [RECIPE], plans: [], week: '2026-W36', generatedAt: '2026-08-30T12:00:00.000Z'
  });

  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes('</html>'));
  assert.ok(html.includes('function buildShoppingList'), 'aggregation is inlined');
  assert.ok(html.includes('function weekDates'), 'week maths is inlined');
  assert.ok(html.includes('function formatAmount'), 'formatting is inlined');
  assert.ok(html.includes('window.PLANNER_DATA'));
  assert.ok(!/^import\s/m.test(html) && !/^export\s/m.test(html), 'no module syntax survives');

  const external = (html.match(/(?:src|href)="(?!#)[^"]*"/g) || [])
    .filter((ref) => /https?:|\/\//.test(ref));
  assert.deepEqual(external, []);
  assert.ok(!/<link\b/i.test(html), 'no stylesheet links');
});

test('escapes recipe content and cannot break out of the JSON payload', () => {
  const html = renderPlanner({ recipes: [RECIPE], plans: [], week: '2026-W36' });
  assert.ok(html.includes('Chilli &lt;Crisp&gt; Noodles') || !html.includes('<Crisp>'));
  const payload = html.split('<script type="application/json" id="planner-json">')[1].split('</script>')[0];
  assert.ok(!payload.includes('</'), 'the payload cannot close the script tag early');
  const parsed = JSON.parse(payload);
  assert.equal(parsed.recipes[0].title, 'Chilli <Crisp> Noodles');
  assert.equal(parsed.week, '2026-W36');
});

test('the payload carries what the planner needs and nothing more', () => {
  const html = renderPlanner({ recipes: [RECIPE], plans: [], week: '2026-W36' });
  const parsed = JSON.parse(html.split('id="planner-json">')[1].split('</script>')[0]);
  const recipe = parsed.recipes[0];
  assert.deepEqual(Object.keys(recipe).sort(), [
    'base_servings', 'description', 'ingredients', 'meta', 'servings_unit', 'slug', 'title'
  ]);
  assert.equal(recipe.steps, undefined, 'method text stays in the recipe card');
  assert.equal(recipe.ingredients[0].amount, 200);
});

test('the planner page is not mistaken for a recipe card by the library scanner', async () => {
  // Both live in docs/, and the index is rebuilt from every card it finds
  // there — the planner must not turn up as a recipe.
  const html = renderPlanner({ recipes: [RECIPE], plans: [], week: '2026-W36' });
  assert.equal(readCardHtml(html), null);
});

test('builds from the real recipe library and the committed plans', async () => {
  const outDir = await tmp('meal-planner-build-');
  const plansDir = await tmp('meal-planner-plans-');
  await writePlan(plansDir, normalizePlan({
    week: '2026-W36', days: { '2026-08-31': [{ slug: 'lemon-garlic-butter-shrimp', servings: 4 }] }
  }, '2026-W36'));

  const result = await buildPlanner({ outDir, plansDir, week: '2026-W36' });
  assert.equal(result.file, path.join(outDir, 'planner.html'));
  assert.ok(result.recipes.length >= 1);
  assert.deepEqual(result.plans.map((p) => p.week), ['2026-W36']);

  const html = await readFile(result.file, 'utf8');
  const parsed = JSON.parse(html.split('id="planner-json">')[1].split('</script>')[0]);
  assert.equal(parsed.plans['2026-W36'].days['2026-08-31'][0].servings, 4);
  assert.ok(parsed.recipes.some((r) => r.slug === 'lemon-garlic-butter-shrimp'));
  assert.ok(html.includes('href="index.html"'), 'links back to the recipe index');
});

test('always opens on an editable week, even with nothing committed', async () => {
  const outDir = await tmp('meal-planner-build-');
  const plansDir = await tmp('meal-planner-plans-');
  const result = await buildPlanner({ outDir, plansDir, week: '2026-W40' });
  assert.deepEqual(result.plans.map((p) => p.week), ['2026-W40']);
});

test('loads the recipe library keyed by slug', async () => {
  const { recipes, bySlug } = await loadRecipes('recipes');
  assert.ok(recipes.length >= 1);
  assert.equal(bySlug.size, recipes.length, 'slugs are unique');
  assert.equal(bySlug.get(recipes[0].slug).title, recipes[0].title);
});

/* ---------------- CLI ---------------- */

test('the CLI builds, shows, lists and imports', async () => {
  const outDir = await tmp('meal-planner-cli-');
  const plansDir = await tmp('meal-planner-cli-plans-');
  const base = ['--plans', plansDir, '--out', outDir];

  const build = captureIo();
  assert.equal(await main(['build', ...base, '--week', '2026-W36'], build.io), 0);
  assert.match(build.out.join('\n'), /Built .*planner\.html/);

  // Import the shape the page's download button produces.
  const source = path.join(plansDir, 'incoming.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(source, JSON.stringify({
    week: '2026-W36',
    revision: 1,
    days: { '2026-08-31': [{ slug: 'lemon-garlic-butter-shrimp', servings: 4 }] }
  }), 'utf8');

  const imported = captureIo();
  assert.equal(await main(['import', source, ...base, '--by', 'karen'], imported.io), 0);
  assert.match(imported.out.join('\n'), /Imported 2026-W36/);
  assert.match(imported.out.join('\n'), /revision 2/, 'importing supersedes the committed revision');

  const shown = captureIo();
  assert.equal(await main(['show', '2026-W36', ...base], shown.io), 0);
  assert.match(shown.out.join('\n'), /Mon 31 Aug Lemon Garlic Butter Shrimp\s+\[4 servings\]/);
  assert.match(shown.out.join('\n'), /Tue 1 Sep\s+—/);

  const shopping = captureIo();
  assert.equal(await main(['shopping', '2026-W36', ...base], shopping.io), 0);
  assert.match(shopping.out.join('\n'), /- large shrimp {2}— {2}900 g/, 'scaled to the planned servings');
});

test('the CLI refuses bad weeks, unknown commands and unknown recipes', async () => {
  const plansDir = await tmp('meal-planner-cli-plans-');
  const base = ['--plans', plansDir];

  const badWeek = captureIo();
  assert.equal(await main(['show', 'last-tuesday', ...base], badWeek.io), 2);
  assert.match(badWeek.err.join('\n'), /not an ISO week id/);

  const unknown = captureIo();
  assert.equal(await main(['frobnicate', ...base], unknown.io), 2);
  assert.match(unknown.err.join('\n'), /Unknown command/);

  const { writeFile } = await import('node:fs/promises');
  const source = path.join(plansDir, 'bad.json');
  await writeFile(source, JSON.stringify({
    week: '2026-W36', days: { '2026-08-31': [{ slug: 'no-such-recipe' }] }
  }), 'utf8');

  const badImport = captureIo();
  assert.equal(await main(['import', source, ...base], badImport.io), 1);
  assert.match(badImport.err.join('\n'), /Refusing to import.*no-such-recipe/s);

  const help = captureIo();
  assert.equal(await main(['--help'], help.io), 0);
  assert.match(help.out.join('\n'), /import <file> \[week\]/);
});
