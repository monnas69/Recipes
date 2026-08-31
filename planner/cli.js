/** Command-line interface for the meal planner. */

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { buildPlanner, loadRecipes, DEFAULTS } from './build.js';
import {
  readPlan, writePlan, normalizePlan, planAssignments, missingSlugs, isEmptyPlan
} from './plan-store.js';
import { buildShoppingList, shoppingListToText } from './shared/shopping.js';
import { currentWeekId, isWeekId, weekDates, weekLabel, dayName, dayLabel } from './shared/week.js';

const OPTIONS = {
  week: { type: 'string', short: 'w' },
  source: { type: 'string', default: DEFAULTS.source },
  out: { type: 'string', short: 'o', default: DEFAULTS.outDir },
  plans: { type: 'string', default: DEFAULTS.plansDir },
  title: { type: 'string', default: DEFAULTS.title },
  by: { type: 'string' },
  quiet: { type: 'boolean', short: 'q', default: false },
  help: { type: 'boolean', short: 'h', default: false }
};

const HELP = `
meal-planner — weekly meal plans and shopping lists from the recipe library

Usage
  meal-planner <command> [options]

Commands
  build                  rebuild docs/planner.html          (the default)
  show [week]            print a week's plan
  shopping [week]        print a week's shopping list
  import <file> [week]   validate a plan downloaded from the page and save it
                         into the plans folder, ready to commit

Meals without a recipe
  A day can hold a meal that is just a name — "bangers and mash", "leftovers".
  Type it into the filter box on the page and press return. Those meals have no
  ingredients, so they add nothing to the shopping list; the list names them at
  the bottom instead of pretending they are not there.

Options
  -w, --week <id>        ISO week, e.g. 2026-W36            (default: this week)
      --source <path>    recipe sources                     (default: recipes)
  -o, --out <dir>        output directory for build         (default: docs)
      --plans <dir>      plan storage  (default: planner/data/plans)
      --title <text>     heading for the page               (default: Meal planner)
      --by <name>        who saved this plan (import)
  -q, --quiet            only print errors
  -h, --help             show this help

Sharing a plan
  Plans are JSON files committed to the repo — there is no server. Edit the
  week in the page, press "Download plan", then:

    meal-planner import ~/Downloads/2026-W36.json
    git add planner/data/plans && git commit -m "Plan 2026-W36" && git push

  The other cook pulls, and their page picks the new plan up on the next build.
`;

function resolveWeek(values, positional) {
  const candidate = values.week || positional;
  if (!candidate) return { week: currentWeekId() };
  if (!isWeekId(candidate)) {
    return { error: `"${candidate}" is not an ISO week id — expected something like 2026-W36.` };
  }
  return { week: candidate };
}

function formatPlan(plan, recipesBySlug) {
  const lines = [`${plan.week}   ${weekLabel(plan.week)}`];
  if (plan.revision) {
    lines.push(`revision ${plan.revision}${plan.updated_by ? ` by ${plan.updated_by}` : ''}`
      + `${plan.updated_at ? ` on ${plan.updated_at.slice(0, 10)}` : ''}`);
  }
  lines.push('');
  for (const date of weekDates(plan.week)) {
    const entries = plan.days[date] || [];
    const label = `${dayName(date)} ${dayLabel(date)}`.padEnd(11);
    if (!entries.length) {
      lines.push(`  ${label}—`);
      continue;
    }
    entries.forEach((entry, index) => {
      const prefix = index === 0 ? label : ' '.repeat(11);
      if (!entry.slug) {
        lines.push(`  ${prefix}${entry.text}  (no recipe)`);
        return;
      }
      const recipe = recipesBySlug.get(entry.slug);
      const title = recipe ? recipe.title : `${entry.slug} (missing from recipes/)`;
      const servings = entry.servings || recipe?.base_servings;
      const unit = recipe?.servings_unit || 'servings';
      const suffix = servings ? `  [${servings} ${unit}]` : '';
      lines.push(`  ${prefix}${title}${suffix}`);
    });
  }
  return lines.join('\n');
}

function countEntries(plan) {
  let recipes = 0;
  let freeText = 0;
  for (const entries of Object.values(plan.days || {})) {
    for (const entry of entries) {
      if (entry.slug) recipes += 1;
      else freeText += 1;
    }
  }
  return { recipes, freeText };
}

export async function main(argv = process.argv.slice(2), io = console) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    io.error(`${error.message}\nRun \`meal-planner --help\` for usage.`);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.help) { io.log(HELP.trim()); return 0; }

  const command = positionals[0] || 'build';
  const log = values.quiet ? () => {} : (message) => io.log(message);

  try {
    if (command === 'build') {
      const result = await buildPlanner({
        source: values.source,
        outDir: values.out,
        plansDir: values.plans,
        title: values.title,
        week: values.week
      });
      log(`Built ${path.relative(process.cwd(), result.file)}`);
      log(`  • ${result.recipes.length} recipe${result.recipes.length === 1 ? '' : 's'}`
        + `, ${result.plans.length} week${result.plans.length === 1 ? '' : 's'} of plans`
        + `, opening on ${result.week}`);
      return 0;
    }

    if (command === 'show' || command === 'shopping') {
      const resolved = resolveWeek(values, positionals[1]);
      if (resolved.error) { io.error(resolved.error); return 2; }

      const { bySlug } = await loadRecipes(values.source);
      const plan = await readPlan(values.plans, resolved.week);

      const missing = missingSlugs(plan, bySlug);
      if (missing.length) {
        io.error(`Warning: ${missing.length} planned recipe${missing.length === 1 ? '' : 's'} `
          + `no longer in ${values.source}: ${missing.join(', ')}`);
      }

      if (command === 'show') {
        io.log(formatPlan(plan, bySlug));
        if (isEmptyPlan(plan)) log('\nNothing planned yet — open docs/planner.html to fill it in.');
        return 0;
      }

      const list = buildShoppingList(planAssignments(plan, bySlug));
      io.log(shoppingListToText(list, `Shopping list — ${plan.week} (${weekLabel(plan.week)})`));
      if (list.items.length) {
        log(`\n${list.itemCount} item${list.itemCount === 1 ? '' : 's'} from `
          + `${list.recipeCount} meal${list.recipeCount === 1 ? '' : 's'}.`);
      }
      return 0;
    }

    if (command === 'import') {
      const file = positionals[1];
      if (!file) {
        io.error('Missing file. Usage: meal-planner import <file> [week]');
        return 2;
      }
      let raw;
      try {
        raw = JSON.parse(await readFile(file, 'utf8'));
      } catch (error) {
        io.error(`Could not read ${file}: ${error.message}`);
        return 1;
      }

      const fallback = values.week || positionals[2] || raw?.week;
      if (!isWeekId(raw?.week) && !isWeekId(fallback)) {
        io.error('That file does not name an ISO week. Pass one: meal-planner import <file> 2026-W36');
        return 2;
      }
      const plan = normalizePlan(raw, fallback);
      if (!plan) { io.error(`${file} is not a plan.`); return 1; }

      const { bySlug } = await loadRecipes(values.source);
      const missing = missingSlugs(plan, bySlug);
      if (missing.length) {
        io.error(`Refusing to import: ${missing.length} recipe${missing.length === 1 ? '' : 's'} `
          + `not in ${values.source} — ${missing.join(', ')}`);
        return 1;
      }

      const { plan: saved, file: written } = await writePlan(values.plans, plan, { updatedBy: values.by });
      log(`Imported ${saved.week} → ${path.relative(process.cwd(), written)} (revision ${saved.revision})`);
      // Free-text meals are the entries an older checkout would silently drop
      // on the next import, so the count goes in the summary where it shows.
      const counts = countEntries(saved);
      log(`  • ${counts.recipes} recipe${counts.recipes === 1 ? '' : 's'}`
        + `, ${counts.freeText} free-text meal${counts.freeText === 1 ? '' : 's'}`);
      log(formatPlan(saved, bySlug));
      log('\nCommit it to share:');
      log(`  git add ${values.plans} && git commit -m "Plan ${saved.week}" && git push`);
      return 0;
    }

    io.error(`Unknown command "${command}".\n${HELP.trim()}`);
    return 2;
  } catch (error) {
    io.error(`${command} failed: ${error.message}`);
    return 1;
  }
}
