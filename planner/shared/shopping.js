/**
 * Shopping-list aggregation: a week of assigned recipes -> one de-duplicated,
 * summed list.
 *
 * Like week.js this runs in both places — the CLI prints the list, the built
 * page recomputes it live as recipes are dragged onto days — so it is inlined
 * into planner.html with its `import`/`export` lines stripped. Keep it
 * dependency-free; scaledAmountWithUnit comes from src/shared/format.js, which
 * is inlined alongside it.
 *
 * Merging rules, in order of how much they can go wrong:
 *
 *   1. Ingredients are grouped by a normalised name ("Garlic," and "garlic" are
 *      the same shopping-list line).
 *   2. Within a name, quantities merge only when their units are convertible:
 *      grams with kilograms, millilitres with cups, but never grams with cups —
 *      the density of flour is not this tool's business. Unconvertible units
 *      stay as separate quantities on the same line ("soy sauce — 3 tbsp + 50 ml")
 *      rather than being dropped or silently added together.
 *   3. Amounts that never parsed ("to taste", "a pinch") are carried through as
 *      text, so nothing a recipe asked for disappears from the list.
 */

import { scaledAmountWithUnit } from '../../src/shared/format.js';

/** Unit spellings -> a canonical unit, per measurement family. */
const MASS_UNITS = {
  mg: 0.001,
  g: 1,
  gram: 1, grams: 1,
  kg: 1000, kilogram: 1000, kilograms: 1000,
  oz: 28.349523125, ounce: 28.349523125, ounces: 28.349523125,
  lb: 453.59237, lbs: 453.59237, pound: 453.59237, pounds: 453.59237
};

const VOLUME_UNITS = {
  ml: 1, milliliter: 1, milliliters: 1, millilitre: 1, millilitres: 1,
  cl: 10,
  dl: 100,
  l: 1000, liter: 1000, liters: 1000, litre: 1000, litres: 1000,
  tsp: 4.92892159375, tsps: 4.92892159375, teaspoon: 4.92892159375, teaspoons: 4.92892159375,
  tbsp: 14.78676478125, tbsps: 14.78676478125, tbs: 14.78676478125, tb: 14.78676478125,
  tablespoon: 14.78676478125, tablespoons: 14.78676478125,
  cup: 236.5882365, cups: 236.5882365, c: 236.5882365,
  floz: 29.5735295625, 'fl oz': 29.5735295625,
  'fluid ounce': 29.5735295625, 'fluid ounces': 29.5735295625,
  pt: 473.176473, pint: 473.176473, pints: 473.176473,
  qt: 946.352946, quart: 946.352946, quarts: 946.352946,
  gal: 3785.411784, gallon: 3785.411784, gallons: 3785.411784
};

/** The spelling each canonical unit is displayed with. */
const CANONICAL_SPELLING = {
  mg: 'mg', g: 'g', gram: 'g', grams: 'g',
  kg: 'kg', kilogram: 'kg', kilograms: 'kg',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  ml: 'ml', milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
  cl: 'cl', dl: 'dl',
  l: 'l', liter: 'l', liters: 'l', litre: 'l', litres: 'l',
  tsp: 'tsp', tsps: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  tbsp: 'tbsp', tbsps: 'tbsp', tbs: 'tbsp', tb: 'tbsp',
  tablespoon: 'tbsp', tablespoons: 'tbsp',
  cup: 'cup', cups: 'cup', c: 'cup',
  floz: 'fl oz', 'fl oz': 'fl oz', 'fluid ounce': 'fl oz', 'fluid ounces': 'fl oz',
  pt: 'pint', pint: 'pint', pints: 'pint',
  qt: 'quart', quart: 'quart', quarts: 'quart',
  gal: 'gallon', gallon: 'gallon', gallons: 'gallon'
};

/** Countable units that only ever merge with themselves, normalised to singular. */
const COUNT_UNITS = [
  'clove', 'slice', 'stick', 'sprig', 'pinch', 'dash', 'can', 'packet', 'package',
  'scoop', 'handful', 'bunch', 'fillet', 'stem', 'leaf', 'head', 'bulb', 'stalk',
  'piece', 'sheet', 'strip', 'rib', 'ear', 'jar', 'bottle', 'tin', 'bag', 'box',
  'wedge', 'square', 'drop', 'knob', 'spray', 'egg', 'rasher', 'link'
];

const COUNT_PLURALS = { leaves: 'leaf', boxes: 'box', bunches: 'bunch', dashes: 'dash', pinches: 'pinch' };

const EPSILON = 1e-9;

function clean(text) {
  return String(text == null ? '' : text).trim();
}

/**
 * Resolve a unit to { unit, family, factor }.
 *
 * `factor` converts the amount into the family's base unit (g for mass, ml for
 * volume, 1 for counts). Unknown units become their own single-member family,
 * so "2 sachets" still merges with "1 sachet" but never with anything else.
 */
export function canonicalUnit(unit) {
  const raw = clean(unit).toLowerCase().replace(/\.$/, '').replace(/\s+/g, ' ');
  if (!raw) return { unit: '', family: 'count', factor: 1 };

  if (Object.prototype.hasOwnProperty.call(MASS_UNITS, raw)) {
    return { unit: CANONICAL_SPELLING[raw], family: 'mass', factor: MASS_UNITS[raw] };
  }
  if (Object.prototype.hasOwnProperty.call(VOLUME_UNITS, raw)) {
    return { unit: CANONICAL_SPELLING[raw], family: 'volume', factor: VOLUME_UNITS[raw] };
  }

  // Counts: singularise so "2 cloves" and "1 clove" land in the same bucket.
  let singular = COUNT_PLURALS[raw] || raw;
  if (COUNT_UNITS.indexOf(singular) === -1 && /s$/.test(singular) && singular.length > 3) {
    const stripped = singular.slice(0, -1);
    if (COUNT_UNITS.indexOf(stripped) !== -1) singular = stripped;
  }
  return { unit: singular, family: 'count:' + singular, factor: 1 };
}

/** Grouping key for an ingredient name — case, padding and parentheticals removed. */
export function ingredientKey(name) {
  return clean(name)
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[.,;:!?"']+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:the|a|an|some)\s+/, '');
}

/** Display unit for a merged bucket, given every unit that fed into it. */
function displayUnitFor(family, contributions, totalBase) {
  // Metric mass and volume get a readability pass: 1500 g reads better as
  // 1.5 kg, and 0.5 l as 500 ml.
  if (family === 'mass' || family === 'volume') {
    const metric = family === 'mass' ? ['mg', 'g', 'kg'] : ['ml', 'cl', 'dl', 'l'];
    const usesMetricOnly = contributions.every((c) => metric.indexOf(c.unit) !== -1);
    if (usesMetricOnly) {
      if (family === 'mass') {
        if (totalBase >= 1000) return 'kg';
        if (totalBase >= 1) return 'g';
        return 'mg';
      }
      return totalBase >= 1000 ? 'l' : 'ml';
    }
  }

  // Otherwise show the unit the recipes mostly used; ties go to the unit
  // carrying the largest share, so "1 cup + 1 tbsp" reads in cups.
  const tally = new Map();
  for (const c of contributions) {
    const entry = tally.get(c.unit) || { count: 0, base: 0 };
    entry.count += 1;
    entry.base += c.base;
    tally.set(c.unit, entry);
  }
  let best = null;
  let bestUnit = contributions.length ? contributions[0].unit : '';
  for (const [unit, entry] of tally) {
    if (!best || entry.count > best.count || (entry.count === best.count && entry.base > best.base)) {
      best = entry;
      bestUnit = unit;
    }
  }
  return bestUnit;
}

function factorFor(family, unit) {
  if (family === 'mass') return MASS_UNITS[unit] || 1;
  if (family === 'volume') return VOLUME_UNITS[unit] || 1;
  return 1;
}

function pushUnique(list, value, limit) {
  const text = clean(value);
  if (!text || list.indexOf(text) !== -1) return;
  if (limit && list.length >= limit) return;
  list.push(text);
}

/**
 * Aggregate a week's assignments into a shopping list.
 *
 * @param {Array<{recipe: object, servings?: number, date?: string}>} assignments
 * @returns {{items: Array, recipeCount: number, itemCount: number, mergedCount: number}}
 */
export function buildShoppingList(assignments) {
  const groups = new Map();
  let recipeCount = 0;

  for (const assignment of assignments || []) {
    const recipe = assignment && assignment.recipe;
    if (!recipe || !Array.isArray(recipe.ingredients)) continue;
    recipeCount += 1;

    const base = Number(recipe.base_servings) || 1;
    const wanted = Number(assignment.servings);
    const factor = wanted > 0 ? wanted / base : 1;

    for (const ingredient of recipe.ingredients) {
      const key = ingredientKey(ingredient.name);
      if (!key) continue;

      if (!groups.has(key)) {
        groups.set(key, { key: key, names: new Map(), buckets: new Map(), extras: [], notes: [], sources: [] });
      }
      const group = groups.get(key);

      const displayName = clean(ingredient.name);
      group.names.set(displayName, (group.names.get(displayName) || 0) + 1);
      pushUnique(group.notes, ingredient.note, 4);
      group.sources.push({
        slug: recipe.slug,
        title: recipe.title,
        date: assignment.date || null
      });

      const scalable = ingredient.scalable !== false;
      const amount = typeof ingredient.amount === 'number' && isFinite(ingredient.amount)
        ? ingredient.amount
        : null;

      if (amount === null) {
        // "to taste", "a pinch" — nothing to sum, but it still belongs on the list.
        pushUnique(group.extras, [clean(ingredient.amount_text), clean(ingredient.unit)].filter(Boolean).join(' '), 4);
        continue;
      }

      const scale = scalable ? factor : 1;
      const unit = canonicalUnit(ingredient.unit);
      const max = typeof ingredient.amount_max === 'number' && isFinite(ingredient.amount_max)
        ? ingredient.amount_max
        : amount;

      if (!group.buckets.has(unit.family)) {
        group.buckets.set(unit.family, { family: unit.family, base: 0, baseMax: 0, contributions: [] });
      }
      const bucket = group.buckets.get(unit.family);
      const baseAmount = amount * scale * unit.factor;
      bucket.base += baseAmount;
      bucket.baseMax += max * scale * unit.factor;
      bucket.contributions.push({ unit: unit.unit, base: baseAmount });
    }
  }

  mergePluralNames(groups);

  const items = [];
  let mergedCount = 0;

  for (const group of groups.values()) {
    const quantities = [];
    for (const bucket of group.buckets.values()) {
      const family = bucket.family.indexOf('count:') === 0 ? 'count' : bucket.family;
      const unit = displayUnitFor(family, bucket.contributions, bucket.base);
      const divisor = factorFor(family, unit) || 1;
      const low = bucket.base / divisor;
      const high = bucket.baseMax / divisor;
      quantities.push({
        unit: unit,
        family: family,
        amount: low,
        amount_max: high > low + EPSILON ? high : null,
        text: scaledAmountWithUnit(
          { amount: low, amount_max: high > low + EPSILON ? high : null, unit: unit },
          1
        ),
        parts: bucket.contributions.length
      });
      if (bucket.contributions.length > 1) mergedCount += 1;
    }

    quantities.sort((a, b) => b.parts - a.parts);

    // Usually the spelling the recipes used most; but where a singular and a
    // plural were folded together, always show the plural.
    let name = group.key;
    let bestCount = -1;
    for (const [candidate, count] of group.names) {
      if (count > bestCount) { bestCount = count; name = candidate; }
    }
    if (group.merged) {
      for (const candidate of group.names.keys()) {
        if (ingredientKey(candidate) === group.key) { name = candidate; break; }
      }
    }

    items.push({
      key: group.key,
      name: name,
      quantities: quantities,
      extras: group.extras,
      notes: group.notes,
      recipes: uniqueTitles(group.sources),
      sources: group.sources,
      // True when this line needed more than one quantity because its units
      // could not be reconciled — the UI marks these so they get a second look.
      split: quantities.length > 1
    });
  }

  items.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return { items: items, recipeCount: recipeCount, itemCount: items.length, mergedCount: mergedCount };
}

/**
 * Fold "egg" and "eggs" into one line — but only when both spellings actually
 * occur. Stripping plurals unconditionally would merge unrelated words ("oats"
 * is not "oat"); requiring both forms to be present makes the merge safe.
 *
 * The plural is the survivor: a shopping list is a list of things to buy
 * several of, so "4 eggs" reads right where "4 egg" does not.
 */
function mergePluralNames(groups) {
  for (const key of [...groups.keys()]) {
    if (!/s$/.test(key)) continue;
    const singular = key.slice(0, -1);
    if (!groups.has(singular) || !groups.has(key)) continue;
    const from = groups.get(singular);
    const into = groups.get(key);
    into.merged = true;

    for (const [name, count] of from.names) into.names.set(name, (into.names.get(name) || 0) + count);
    for (const [family, bucket] of from.buckets) {
      if (!into.buckets.has(family)) {
        into.buckets.set(family, bucket);
        continue;
      }
      const target = into.buckets.get(family);
      target.base += bucket.base;
      target.baseMax += bucket.baseMax;
      target.contributions = target.contributions.concat(bucket.contributions);
    }
    for (const extra of from.extras) pushUnique(into.extras, extra, 4);
    for (const note of from.notes) pushUnique(into.notes, note, 4);
    into.sources = into.sources.concat(from.sources);
    groups.delete(singular);
  }
}

function uniqueTitles(sources) {
  const titles = [];
  for (const source of sources) pushUnique(titles, source.title);
  return titles;
}

/** Plain-text rendering of a list, for the CLI and the page's "copy" button. */
export function shoppingListToText(list, heading) {
  const lines = [];
  if (heading) {
    lines.push(heading);
    lines.push('');
  }
  if (!list.items.length) {
    lines.push('Nothing planned yet.');
    return lines.join('\n');
  }
  for (const item of list.items) {
    const amounts = item.quantities.map((q) => q.text).filter(Boolean);
    for (const extra of item.extras) amounts.push(extra);
    lines.push('- ' + item.name + (amounts.length ? '  —  ' + amounts.join(' + ') : ''));
  }
  return lines.join('\n');
}
