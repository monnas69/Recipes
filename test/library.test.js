import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { exportRecipes } from '../src/export.js';
import { readCardHtml, scanLibrary, mergeLibrary } from '../src/library.js';

const CONVERSATION = new URL('../examples/claude-conversation.json', import.meta.url).pathname;
const TRANSCRIPT = new URL('../examples/transcript.md', import.meta.url).pathname;
const EXAMPLES_DIR = new URL('../examples/', import.meta.url).pathname;

const tmp = () => mkdtemp(path.join(tmpdir(), 'ninja-recipes-library-'));
const indexLinks = async (dir) => {
  const html = await readFile(path.join(dir, 'index.html'), 'utf8');
  return (html.match(/href="([^"]*\.html)"/g) || []).map((m) => m.slice(6, -1)).sort();
};

test('a card can be read back out of its own HTML', async () => {
  const outDir = await tmp();
  await exportRecipes(TRANSCRIPT, { outDir });
  const html = await readFile(path.join(outDir, 'spaghetti-with-anchovy-breadcrumbs.html'), 'utf8');
  const payload = readCardHtml(html);
  assert.equal(payload.title, 'Spaghetti with Anchovy Breadcrumbs');
  assert.equal(payload.base_servings, 2);
  assert.equal(payload.ingredients.length, 8);
  assert.ok(payload.description, 'the description survives the round trip');
});

test('the index carries over cards from earlier runs', async () => {
  const outDir = await tmp();
  await exportRecipes(CONVERSATION, { outDir });
  assert.equal((await indexLinks(outDir)).length, 3);

  const second = await exportRecipes(TRANSCRIPT, { outDir });
  assert.equal(second.recipes.length, 1, 'only the new card is exported');
  assert.equal(second.stats.carried_over, 3);
  assert.deepEqual(await indexLinks(outDir), [
    'ninja-creami-vanilla-bean-ice-cream.html',
    'ninja-foodi-crispy-chilli-chicken-thighs.html',
    'smashed-cucumber-salad.html',
    'spaghetti-with-anchovy-breadcrumbs.html'
  ]);
});

test('deleting a card file removes it from the index on the next build', async () => {
  const outDir = await tmp();
  await exportRecipes(CONVERSATION, { outDir });
  await rm(path.join(outDir, 'smashed-cucumber-salad.html'));
  await exportRecipes(TRANSCRIPT, { outDir });
  const links = await indexLinks(outDir);
  assert.ok(!links.includes('smashed-cucumber-salad.html'));
  assert.equal(links.length, 3);
});

test('re-exporting a recipe updates its card instead of duplicating it', async () => {
  const outDir = await tmp();
  await exportRecipes(TRANSCRIPT, { outDir });
  await exportRecipes(TRANSCRIPT, { outDir });
  const files = (await readdir(outDir)).filter((f) => f !== 'index.html');
  assert.deepEqual(files, ['spaghetti-with-anchovy-breadcrumbs.html']);
  assert.equal((await indexLinks(outDir)).length, 1);
});

test('--no-library builds the index from the current run only', async () => {
  const outDir = await tmp();
  await exportRecipes(CONVERSATION, { outDir });
  await exportRecipes(TRANSCRIPT, { outDir, library: false });
  assert.deepEqual(await indexLinks(outDir), ['spaghetti-with-anchovy-breadcrumbs.html']);
});

test('stray HTML in the folder is ignored', async () => {
  const outDir = await tmp();
  await writeFile(path.join(outDir, 'notes.html'), '<html><body>not a card</body></html>');
  await exportRecipes(TRANSCRIPT, { outDir });
  assert.deepEqual(await indexLinks(outDir), ['spaghetti-with-anchovy-breadcrumbs.html']);
  assert.equal((await scanLibrary(outDir)).length, 1);
});

test('scanning a folder that does not exist yields an empty library', async () => {
  assert.deepEqual(await scanLibrary('/definitely/not/a/folder'), []);
});

test('merge prefers the fresh card and sorts by title', () => {
  const merged = mergeLibrary(
    [{ slug: 'a', title: 'Apple', base_servings: 2 }, { slug: 'z', title: 'Zucchini', base_servings: 1 }],
    [{ slug: 'a', title: 'Apple', base_servings: 6 }, { slug: 'm', title: 'Miso', base_servings: 4 }]
  );
  assert.deepEqual(merged.map((c) => c.title), ['Apple', 'Miso', 'Zucchini']);
  assert.equal(merged[0].base_servings, 6);
});

test('a directory source exports every file in it', async () => {
  const outDir = await tmp();
  const { recipes } = await exportRecipes(EXAMPLES_DIR, { outDir });
  assert.deepEqual(recipes.map((r) => r.title).sort(), [
    'Ninja Creami Vanilla Bean Ice Cream',
    'Ninja Foodi Crispy Chilli Chicken Thighs',
    'Smashed Cucumber Salad',
    'Spaghetti with Anchovy Breadcrumbs'
  ]);
});

test('several sources can be exported in one run', async () => {
  const outDir = await tmp();
  const { recipes } = await exportRecipes([TRANSCRIPT, CONVERSATION], { outDir });
  assert.equal(recipes.length, 4);
  assert.equal((await indexLinks(outDir)).length, 4);
});

test('the index page carries a working filter and search metadata', async () => {
  const outDir = await tmp();
  await exportRecipes(CONVERSATION, { outDir, siteTitle: 'My Recipes' });
  const html = await readFile(path.join(outDir, 'index.html'), 'utf8');
  assert.ok(html.includes('<title>My Recipes</title>'));
  assert.ok(html.includes('id="search"'));
  assert.match(html, /data-search="[^"]*cream cheese[^"]*"/, 'ingredients are searchable');
  assert.equal((html.match(/class="card-row"/g) || []).length, 3);
});
