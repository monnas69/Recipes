/**
 * Pipeline: recipe sources + committed plans -> docs/planner.html.
 *
 * The recipes come from the exporter's own parser (src/export.js), not from a
 * second copy of the parsing rules, so a card that renders on the site is
 * exactly the card the planner can schedule.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { collectRecipes } from '../src/export.js';
import { renderPlanner } from './render.js';
import { readAllPlans, readPlan, DEFAULT_PLANS_DIR } from './plan-store.js';
import { currentWeekId } from './shared/week.js';

export const DEFAULTS = {
  source: 'recipes',
  outDir: 'docs',
  fileName: 'planner.html',
  plansDir: DEFAULT_PLANS_DIR,
  title: 'Meal planner'
};

/** Load every recipe the planner can schedule, indexed by slug. */
export async function loadRecipes(source = DEFAULTS.source) {
  const { recipes } = await collectRecipes([source], { keep: 'latest' });
  const bySlug = new Map();
  for (const recipe of recipes) bySlug.set(recipe.slug, recipe);
  return { recipes, bySlug };
}

/**
 * Build the planner page.
 * @returns {Promise<{file: string, recipes: Array, plans: Array, week: string}>}
 */
export async function buildPlanner(options = {}) {
  const source = options.source || DEFAULTS.source;
  const outDir = path.resolve(options.outDir || DEFAULTS.outDir);
  const plansDir = options.plansDir || DEFAULTS.plansDir;
  const week = options.week || currentWeekId(options.now);

  const { recipes } = await loadRecipes(source);
  const plans = await readAllPlans(plansDir);

  // The current week is always present, even before anyone has committed a
  // plan for it, so the page opens on an editable grid rather than an error.
  if (!plans.some((plan) => plan.week === week)) {
    plans.push(await readPlan(plansDir, week));
  }

  const html = renderPlanner({
    recipes,
    plans,
    week,
    plansDir,
    title: options.title || DEFAULTS.title,
    backLink: options.backLink ?? 'index.html',
    generatedAt: options.generatedAt
  });

  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, options.fileName || DEFAULTS.fileName);
  await writeFile(file, html, 'utf8');

  return { file, recipes, plans, week };
}
