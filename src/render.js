/**
 * Rendering: canonical recipe -> a single self-contained HTML file.
 *
 * The stylesheet and the two client scripts are inlined from src/shared, so the
 * exported file has no external references at all: open it on a plane, print it,
 * or AirDrop it to a phone and every feature still works.
 */

import { readFileSync } from 'node:fs';
import { escapeHtml, jsonForScript } from './util.js';
import { scaledAmountWithUnit, formatClock, formatDuration } from './shared/format.js';

const readAsset = (name) => readFileSync(new URL(`./shared/${name}`, import.meta.url), 'utf8');

const CSS = readAsset('card.css');
// `export` keywords are stripped so the module doubles as a classic script.
const FORMAT_JS = readAsset('format.js').replace(/^export\s+/gm, '');
const CLIENT_JS = readAsset('card-client.js');

/** The toolbar label for the scaling control: "Servings" by default, but a
 * batch-style unit (e.g. "kg batch") reads better as "Batch size". */
function servingsLabel(unit) {
  const clean = String(unit || 'servings').trim();
  if (/batch/i.test(clean)) return 'Batch size';
  if (/^(servings?|portions?)$/i.test(clean)) return 'Servings';
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

const META_LABELS = {
  prep_time: 'Prep',
  cook_time: 'Cook',
  total_time: 'Total',
  difficulty: 'Difficulty',
  cuisine: 'Cuisine',
  course: 'Course',
  equipment: 'Equipment',
  yield: 'Yield'
};

function ingredientAmountHtml(ingredient) {
  const display = ingredient.scalable
    ? scaledAmountWithUnit(ingredient, 1)
    : [ingredient.amount_text, ingredient.unit].filter(Boolean).join(' ');
  return `<span class="amount">${escapeHtml(display)}</span>`;
}

function renderIngredients(recipe) {
  const groups = new Map();
  recipe.ingredients.forEach((ingredient, index) => {
    const key = ingredient.group || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ingredient, index });
  });

  const chunks = [];
  for (const [group, entries] of groups) {
    if (group) chunks.push(`<h3 class="group-title">${escapeHtml(group)}</h3>`);
    const items = entries.map(({ ingredient, index }) => {
      const amount = ingredientAmountHtml(ingredient);
      const note = ingredient.note ? `<span class="ingredient-note">(${escapeHtml(ingredient.note)})</span>` : '';
      const id = `ing-${index + 1}`;
      return `        <li class="ingredient" data-ingredient data-index="${index}">
          <input type="checkbox" id="${id}" data-key="${escapeHtml(ingredient.id)}" data-kind="ingredient">
          <label class="ingredient-body" for="${id}">
            ${amount}
            <span class="ingredient-name">${escapeHtml(ingredient.name)}</span>
            ${note}
          </label>
        </li>`;
    });
    chunks.push(`      <ul class="list">\n${items.join('\n')}\n      </ul>`);
  }
  return chunks.join('\n');
}

function renderStep(step, index) {
  const id = `step-${index + 1}`;
  const title = step.title
    ? `<p class="step-title">${escapeHtml(step.title)}</p>`
    : '';
  const content = step.content && step.content !== step.title
    ? `<p class="step-content">${escapeHtml(step.content)}</p>`
    : '';
  const timer = step.timer_seconds
    ? `
            <div class="timer-wrap">
              <button type="button" class="timer" data-timer="${id}" data-seconds="${step.timer_seconds}" data-step="${index + 1}" aria-label="Step ${index + 1} timer, ${escapeHtml(formatDuration(step.timer_seconds))}, tap to start">
                <span class="timer-icon" aria-hidden="true">⏱</span>
                <span class="timer-time">${escapeHtml(formatClock(step.timer_seconds))}</span>
                <span class="timer-hint">tap to start</span>
              </button>
              <button type="button" class="timer-reset no-print" data-timer-reset="${id}" hidden>reset</button>
            </div>`
    : '';
  return `        <li class="step">
          <span class="step-index" aria-hidden="true">${index + 1}</span>
          <div class="step-main">
            ${title}
            ${content}${timer}
          </div>
          <input type="checkbox" id="${id}-check" data-key="${escapeHtml(step.id)}" data-kind="step" aria-label="Mark step ${index + 1} done">
        </li>`;
}

// A recipe with distinct stages ("Preparation" / "Cooking", "Sauce" /
// "Assembly" — schema.org's HowToSection, or a hand-written step.group) gets
// those as dividers. Numbering stays continuous across groups so the
// checklist and progress bar don't have to think about sections at all.
function renderSteps(recipe) {
  const groups = new Map();
  recipe.steps.forEach((step, index) => {
    const key = step.group || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ step, index });
  });

  const chunks = [];
  for (const [group, entries] of groups) {
    if (group) chunks.push(`<h3 class="group-title">${escapeHtml(group)}</h3>`);
    const items = entries.map(({ step, index }) => renderStep(step, index));
    chunks.push(`      <ul class="list">\n${items.join('\n')}\n      </ul>`);
  }
  return chunks.join('\n');
}

function renderMeta(recipe) {
  const entries = Object.entries(recipe.meta || {}).filter(([key]) => META_LABELS[key]);
  const chips = entries.map(([key, value]) =>
    `<li><span class="meta-label">${escapeHtml(META_LABELS[key])}</span> ${escapeHtml(value)}</li>`);
  const timed = recipe.steps.filter((s) => s.timer_seconds).length;
  if (timed) {
    chips.push(`<li><span class="meta-label">Timers</span> ${timed}</li>`);
  }
  if (!chips.length) return '';
  return `      <ul class="meta">\n        ${chips.join('\n        ')}\n      </ul>`;
}

function renderNotes(recipe) {
  if (!recipe.notes?.length) return '';
  const items = recipe.notes.map((note) => `        <li>${escapeHtml(note)}</li>`).join('\n');
  return `    <section class="notes-section">
      <h2>Notes</h2>
      <ul class="notes">
${items}
      </ul>
    </section>`;
}

/** schema.org Recipe metadata — helps other apps import the card later. */
function structuredData(recipe) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    name: recipe.title,
    description: recipe.description || undefined,
    recipeYield: `${recipe.base_servings} ${recipe.servings_unit}`,
    recipeIngredient: recipe.ingredients.map((ingredient) => {
      const amount = ingredient.scalable
        ? scaledAmountWithUnit(ingredient, 1)
        : [ingredient.amount_text, ingredient.unit].filter(Boolean).join(' ');
      return [amount, ingredient.name].filter(Boolean).join(' ').trim();
    }),
    recipeInstructions: recipe.steps.map((step) => ({
      '@type': 'HowToStep',
      name: step.title || undefined,
      text: step.content
    }))
  };
}

/**
 * Render one recipe card to a complete HTML document.
 * @param {object} recipe canonical recipe
 * @param {{generatedAt?: string, sourceLabel?: string, backLink?: string}} options
 */
export function renderCard(recipe, options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const maxServings = Math.max(12, recipe.base_servings * 4);
  const sourceLabel = options.sourceLabel || recipe.source?.origin || '';
  const backLink = options.backLink
    ? `<a class="back-link" href="${escapeHtml(options.backLink)}">← All recipes</a>`
    : '';

  const payload = {
    title: recipe.title,
    slug: recipe.slug,
    description: recipe.description,
    exported_at: generatedAt,
    base_servings: recipe.base_servings,
    servings_unit: recipe.servings_unit,
    ingredients: recipe.ingredients,
    steps: recipe.steps,
    notes: recipe.notes,
    meta: recipe.meta
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(recipe.title)}</title>
${recipe.description ? `<meta name="description" content="${escapeHtml(recipe.description)}">\n` : ''}<meta name="generator" content="ninja-recipe-card-exporter">
<style>
${CSS}
</style>
</head>
<body>
<main class="card">
  <header class="card-header">
    <div class="eyebrow">
      <span>Recipe card</span>
      ${backLink}
    </div>
    <h1>${escapeHtml(recipe.title)}</h1>
    ${recipe.description ? `<p class="description">${escapeHtml(recipe.description)}</p>` : ''}
${renderMeta(recipe)}
  </header>

  <div class="toolbar">
    <div class="servings">
      <span class="servings-label" id="servings-caption">${escapeHtml(servingsLabel(recipe.servings_unit))}</span>
      <div class="stepper">
        <button type="button" class="round" id="servings-minus" aria-label="Fewer servings">−</button>
        <span class="servings-value" id="servings-value" aria-live="polite">${recipe.base_servings}</span>
        <button type="button" class="round" id="servings-plus" aria-label="More servings">+</button>
      </div>
      <input type="range" id="servings-range" min="1" max="${maxServings}" step="1" value="${recipe.base_servings}" aria-labelledby="servings-caption">
      <span class="scale-note" id="scale-note" hidden></span>
    </div>
    <div class="toolbar-actions no-print">
      <button type="button" id="theme-toggle" class="round" aria-label="Toggle theme">◐</button>
      <button type="button" id="reset-button" title="Reset servings, checkboxes and timers">Reset</button>
      <button type="button" id="print-button">Print</button>
    </div>
  </div>

  <section class="ingredients-section">
    <h2>Ingredients <span class="sr-only">for <span id="servings-echo">${recipe.base_servings}</span> ${escapeHtml(recipe.servings_unit)}</span></h2>
${renderIngredients(recipe)}
  </section>

  <section class="steps-section">
    <h2>Method</h2>
    <div class="progress">
      <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="Steps completed">
        <div class="progress-bar" id="progress-bar"></div>
      </div>
      <span id="progress-label">0 of ${recipe.steps.length} steps done</span>
    </div>
${renderSteps(recipe)}
  </section>

${renderNotes(recipe)}

  <footer class="card-footer">
    <span>Exported ${escapeHtml(generatedAt.slice(0, 10))} with ninja-recipe-card-exporter</span>
    ${sourceLabel ? `<span>Source: ${escapeHtml(sourceLabel)}</span>` : ''}
  </footer>
</main>

<p class="sr-only" id="timer-live" role="status" aria-live="assertive"></p>

<script type="application/json" id="recipe-json">${jsonForScript(payload)}</script>
<script>
try {
  window.RECIPE_DATA = JSON.parse(document.getElementById('recipe-json').textContent);
} catch (err) {
  window.RECIPE_DATA = null;
}
</script>
<script>
${FORMAT_JS}
${CLIENT_JS}
</script>
<script type="application/ld+json">${jsonForScript(structuredData(recipe))}</script>
</body>
</html>
`;
}

/**
 * Library index: the front page of a folder of cards.
 *
 * Rendered from every card in the folder (see src/library.js), with a
 * client-side filter so a growing collection stays navigable. Like the cards
 * themselves it is one self-contained file — which is all GitHub Pages needs.
 */
export function renderIndex(recipes, options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const sourceLabel = options.sourceLabel || '';
  const heading = options.title || 'Recipe cards';

  const items = recipes.map((recipe) => {
    const timers = (recipe.steps || []).filter((step) => step.timer_seconds).length;
    const bits = [
      `${(recipe.ingredients || []).length} ingredients`,
      `${(recipe.steps || []).length} steps`,
      timers ? `${timers} timer${timers === 1 ? '' : 's'}` : null,
      `serves ${recipe.base_servings}`
    ].filter(Boolean);
    const haystack = [
      recipe.title,
      recipe.description,
      ...(recipe.ingredients || []).map((ingredient) => ingredient.name)
    ].filter(Boolean).join(' ').toLowerCase();

    return `        <li class="card-row" data-search="${escapeHtml(haystack)}">
          <a class="index-link" href="${escapeHtml(recipe.file || `${recipe.slug}.html`)}">
            <strong>${escapeHtml(recipe.title)}</strong>
            ${recipe.description ? `<span class="row-note">${escapeHtml(recipe.description)}</span>` : ''}
            <span class="row-meta">${escapeHtml(bits.join(' · '))}</span>
          </a>
        </li>`;
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(heading)}</title>
<meta name="generator" content="ninja-recipe-card-exporter">
<style>
${CSS}
.search-row { display: flex; gap: 10px; align-items: center; margin: 0 0 16px; }
#search {
  flex: 1 1 auto;
  font: inherit;
  color: inherit;
  padding: 9px 14px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface);
}
#search:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
#search-count { color: var(--muted); font-size: 13px; white-space: nowrap; }
.card-row { border-bottom: 1px dashed var(--border); }
.card-row:last-child { border-bottom: 0; }
.card-row[hidden] { display: none; }
.index-link {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 12px 0;
  text-decoration: none;
  color: inherit;
}
.index-link:hover strong { color: var(--accent); }
.index-link strong { font-size: 1.05rem; }
.row-note { color: var(--muted); }
.row-meta { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.empty { color: var(--muted); padding: 18px 0; }
.empty[hidden] { display: none; }
</style>
</head>
<body>
<main class="card">
  <header class="card-header">
    <div class="eyebrow">
      <span>Recipe library</span>
      <span>${recipes.length} card${recipes.length === 1 ? '' : 's'}</span>
    </div>
    <h1>${escapeHtml(heading)}</h1>
    ${sourceLabel ? `<p class="description">Last built from ${escapeHtml(sourceLabel)}</p>` : ''}
  </header>
  <section>
    <div class="search-row no-print">
      <input type="search" id="search" placeholder="Filter by name or ingredient…" aria-label="Filter recipes">
      <span id="search-count"></span>
    </div>
    <ul class="list" id="card-list">
${items.join('\n')}
    </ul>
    <p class="empty" id="empty" hidden>Nothing matches that.</p>
  </section>
  <footer class="card-footer">
    <span>Rebuilt ${escapeHtml(generatedAt.slice(0, 10))} with ninja-recipe-card-exporter</span>
    <span>${recipes.length} card${recipes.length === 1 ? '' : 's'} in this folder</span>
  </footer>
</main>
<script>
(function () {
  var input = document.getElementById('search');
  var rows = Array.prototype.slice.call(document.querySelectorAll('.card-row'));
  var count = document.getElementById('search-count');
  var empty = document.getElementById('empty');

  function apply() {
    var query = input.value.trim().toLowerCase();
    var shown = 0;
    for (var i = 0; i < rows.length; i += 1) {
      var match = !query || rows[i].getAttribute('data-search').indexOf(query) !== -1;
      rows[i].hidden = !match;
      if (match) shown += 1;
    }
    count.textContent = query
      ? shown + ' of ' + rows.length
      : rows.length + (rows.length === 1 ? ' recipe' : ' recipes');
    empty.hidden = shown !== 0;
  }

  input.addEventListener('input', apply);
  apply();
})();
</script>
</body>
</html>
`;
}
