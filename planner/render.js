/**
 * Rendering: recipes + committed plans -> one self-contained planner page.
 *
 * Same principle as the recipe cards (src/render.js): every style and script is
 * inlined, so planner.html works from a GitHub Pages URL, from a file:// path
 * on a phone with no signal, and from a printout.
 */

import { readFileSync } from 'node:fs';

import { escapeHtml, jsonForScript } from '../src/util.js';
import { weekLabel } from './shared/week.js';

const readAsset = (name) => readFileSync(new URL(`./shared/${name}`, import.meta.url), 'utf8');
const readCardAsset = (name) => readFileSync(new URL(`../src/shared/${name}`, import.meta.url), 'utf8');

/**
 * Turn an ES module into a classic script: drop its imports (everything it
 * needs is inlined alongside it) and its `export` keywords.
 */
export function inlineModule(source) {
  return source
    .replace(/^import\s[^;]*;[ \t]*$/gm, '')
    .replace(/^export\s+/gm, '');
}

const CARD_CSS = readCardAsset('card.css');
const PLANNER_CSS = readAsset('planner.css');
const FORMAT_JS = inlineModule(readCardAsset('format.js'));
const THEME_JS = inlineModule(readCardAsset('theme.js'));
const WEEK_JS = inlineModule(readAsset('week.js'));
const SYNC_JS = inlineModule(readAsset('sync.js'));
const SHOPPING_JS = inlineModule(readAsset('shopping.js'));
const CLIENT_JS = readAsset('planner-client.js');

/** Only what the page actually uses — the full card stays in its own file. */
function recipeForPage(recipe) {
  return {
    slug: recipe.slug,
    title: recipe.title,
    description: recipe.description || '',
    base_servings: recipe.base_servings,
    servings_unit: recipe.servings_unit || 'servings',
    ingredients: (recipe.ingredients || []).map((ingredient) => ({
      name: ingredient.name,
      amount: ingredient.amount,
      amount_max: ingredient.amount_max,
      amount_text: ingredient.amount_text,
      unit: ingredient.unit,
      note: ingredient.note,
      scalable: ingredient.scalable
    })),
    meta: {
      total_time: recipe.meta?.total_time || '',
      cook_time: recipe.meta?.cook_time || '',
      difficulty: recipe.meta?.difficulty || ''
    }
  };
}

/**
 * Render the planner page.
 *
 * @param {{recipes: Array, plans: Array, week: string, plansDir?: string,
 *          generatedAt?: string, title?: string, backLink?: string}} options
 */
export function renderPlanner(options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const heading = options.title || 'Meal planner';
  const week = options.week;
  const plansDir = options.plansDir || 'planner/data/plans';

  const recipes = (options.recipes || [])
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title))
    .map(recipeForPage);

  const plans = {};
  for (const plan of options.plans || []) plans[plan.week] = plan;

  // `sync` carries an endpoint and never a key — see planner/shared/sync.js.
  const payload = { week, recipes, plans, plansDir, generatedAt, sync: options.sync || null };
  const backLink = options.backLink
    ? `<a class="back-link" href="${escapeHtml(options.backLink)}">← All recipes</a>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(heading)}</title>
<meta name="description" content="Weekly meal plan and shopping list, built from the recipe library.">
<meta name="generator" content="ninja-recipe-card-exporter">
<style>
${CARD_CSS}
${PLANNER_CSS}
</style>
</head>
<body>
<main class="planner">
  <header class="card-header">
    <div class="eyebrow">
      <span>Meal planner</span>
      ${backLink}
    </div>
    <h1>${escapeHtml(heading)}</h1>
    <p class="description">Assign recipes to days, then take the shopping list to the shops. Everything is stored in this repo — no account, no server.</p>
  </header>

  <div class="week-bar no-print">
    <div class="week-nav">
      <button type="button" class="round" id="prev-week" aria-label="Previous week">‹</button>
      <button type="button" class="round" id="next-week" aria-label="Next week">›</button>
    </div>
    <div class="week-title">
      <strong id="week-name">${escapeHtml(week)}</strong>
      <span id="week-range">${escapeHtml(weekLabel(week))}</span>
    </div>
    <span class="chip-today" id="today-chip" hidden>This week</span>
    <span class="spacer"></span>
    <div class="week-actions">
      <button type="button" id="this-week">Today</button>
      <button type="button" class="round" id="theme-toggle" aria-label="Toggle theme">◐</button>
    </div>
  </div>

  <div class="save-bar no-print" id="save-bar" data-state="clean">
    <span id="save-text"></span>
    <div class="save-actions">
      <button type="button" id="download-button" class="primary">Share this plan</button>
      <button type="button" class="round" id="more-toggle" aria-expanded="false"
        aria-controls="save-more" aria-label="More options for this plan">⋯</button>
    </div>
    <div class="save-more" id="save-more" hidden>
      <label class="sr-only" for="author">Your name</label>
      <input type="text" id="author" class="author-input" placeholder="Your name" size="10">
      <button type="button" id="copy-plan">Copy JSON</button>
      <button type="button" id="download-copy" hidden>Download a copy</button>
      <button type="button" id="discard-button" hidden>Discard changes</button>
    </div>
  </div>

  <div class="banner no-print" id="conflict-banner" hidden>
    <p><strong>Someone published a newer plan for this week.</strong> Your unsaved edits were based on an older revision — keep yours and the committed changes are lost, or take theirs and your edits go.</p>
    <div class="banner-actions">
      <button type="button" id="take-published">Use the committed plan</button>
      <button type="button" id="keep-mine">Keep my edits</button>
    </div>
  </div>

  <noscript>
    <p class="banner" style="display:block">The planner needs JavaScript — it is an editor, not a document. The
    committed plans are plain JSON in <code>${escapeHtml(plansDir)}/</code> if you would rather read them directly.</p>
  </noscript>

  <div class="planner-body">
    <div class="planner-grid">
      <section>
        <h2 class="panel-title">The week</h2>
        <ul class="days" id="days"></ul>
      </section>

      <aside class="picker no-print">
        <h2 class="panel-title">Recipes <span class="count">${recipes.length}</span></h2>
        <label class="sr-only" for="recipe-search">Filter recipes</label>
        <input type="search" id="recipe-search" placeholder="Filter recipes…">
        <ul class="recipe-list" id="recipe-list"></ul>
        <button type="button" class="freeform-add" id="freeform-add" hidden></button>
        <p class="picker-hint" id="picker-hint"></p>
      </aside>
    </div>

    <section class="shopping">
      <h2 class="panel-title">Shopping list <span class="count" id="shopping-count"></span></h2>
      <p class="shopping-empty" id="shopping-empty">Assign a recipe to a day and the list builds itself.</p>
      <ul class="shopping-list" id="shopping-list"></ul>
      <div class="shopping-freeform" id="shopping-freeform" hidden></div>
      <div class="shopping-actions no-print" id="shopping-actions" hidden>
        <button type="button" id="copy-shopping">Copy list</button>
        <button type="button" id="print-shopping">Print</button>
        <button type="button" id="clear-ticks">Untick all</button>
      </div>
    </section>
  </div>

  <footer class="card-footer">
    <span>Rebuilt ${escapeHtml(generatedAt.slice(0, 10))} with ninja-recipe-card-exporter</span>
    <span>Plans live in ${escapeHtml(plansDir)}/</span>
  </footer>
</main>

<p class="toast" id="toast" role="status" aria-live="polite" hidden></p>

<script type="application/json" id="planner-json">${jsonForScript(payload)}</script>
<script>
try {
  window.PLANNER_DATA = JSON.parse(document.getElementById('planner-json').textContent);
} catch (err) {
  window.PLANNER_DATA = null;
}
</script>
<script>
${FORMAT_JS}
${THEME_JS}
${WEEK_JS}
${SYNC_JS}
${SHOPPING_JS}
${CLIENT_JS}
</script>
</body>
</html>
`;
}
