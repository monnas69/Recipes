/**
 * Normalisation: turn the many shapes a "recipe card" block can take into one
 * canonical recipe object that the renderer can rely on.
 */

import { slugify, toArray, pickString, pickNumber, decodeHtmlEntities } from './util.js';
import { parseAmount, parseIngredientLine, inferTimerSeconds } from './quantity.js';
import { formatDuration } from './shared/format.js';

const TITLE_KEYS = ['title', 'name', 'recipe_name', 'recipeName', 'heading', 'dish'];
const DESCRIPTION_KEYS = ['description', 'summary', 'subtitle', 'blurb', 'intro', 'tagline'];
const SERVINGS_KEYS = [
  'base_servings', 'baseServings', 'servings', 'serves', 'serving_count',
  'servingCount', 'portions', 'yield_servings', 'makes', 'recipeYield'
];
// recipeIngredient / recipeInstructions: schema.org Recipe, embedded by
// virtually every recipe blog (WordPress recipe plugins, NYT Cooking, etc.)
// for SEO — see src/transcript.js, which exposes that JSON-LD for scanning.
const INGREDIENT_KEYS = ['ingredients', 'ingredient_list', 'ingredientList', 'items', 'recipeIngredient'];
const STEP_KEYS = ['steps', 'instructions', 'directions', 'method', 'procedure', 'recipeInstructions'];
const NOTE_KEYS = ['notes', 'note', 'tips', 'tip', 'chef_notes', 'chefNotes', 'footnotes'];
const TIMER_KEYS = [
  'timer_seconds', 'timerSeconds', 'timer', 'duration_seconds', 'durationSeconds',
  'seconds', 'time_seconds', 'timeSeconds'
];

/** Does this object look like a recipe card payload? */
export function isRecipeCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const hasIngredients = INGREDIENT_KEYS.some((k) => Array.isArray(value[k]));
  const hasSteps = STEP_KEYS.some((k) => Array.isArray(value[k]));
  if (!hasIngredients && !hasSteps) return false;
  // A card with neither a title nor both lists is probably not a recipe.
  const hasTitle = TITLE_KEYS.some((k) => typeof value[k] === 'string' && value[k].trim());
  return hasTitle || (hasIngredients && hasSteps);
}

/** "PT1H30M" -> 5400. Returns null for anything that isn't an ISO 8601 duration. */
function parseIsoDuration(text) {
  const match = String(text || '').match(
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i
  );
  if (!match || !/^PT?\d/i.test(String(text).trim())) return null;
  const [, days, hours, minutes, seconds] = match;
  const total = (Number(days) || 0) * 86400 + (Number(hours) || 0) * 3600
    + (Number(minutes) || 0) * 60 + (Number(seconds) || 0);
  return total > 0 ? total : null;
}

/** Human-readable time text, converting an ISO 8601 duration if that's what was given. */
function humanDuration(value) {
  const iso = parseIsoDuration(value);
  return iso != null ? formatDuration(iso) : value;
}

/** recipeYield is often ["2", "2 - 3 people"] or "4 servings" — pull the first number out. */
function firstServingsNumber(value) {
  for (const candidate of toArray(value)) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === 'string') {
      const match = candidate.match(/\d+/);
      if (match) return Number(match[0]);
    }
  }
  return null;
}

/** A leading "Label: rest of the instruction" becomes a step title, generically —
 * not just for schema.org sources. Only used when no explicit title was given. */
function splitLeadingLabel(text) {
  const match = String(text || '').match(/^([A-Z][^.:]{2,48}):\s+([\s\S]+)$/);
  return match ? { title: match[1].trim(), content: match[2].trim() } : null;
}

/** schema.org HowToSection nests its steps in itemListElement; flatten it,
 * carrying the section name forward as each step's group. */
function flattenSteps(rawSteps) {
  const out = [];
  for (const entry of rawSteps) {
    if (entry && typeof entry === 'object' && Array.isArray(entry.itemListElement)) {
      const groupName = pickString(entry, ['name', 'title']).replace(/:\s*$/, '');
      for (const child of flattenSteps(entry.itemListElement)) {
        out.push(groupName && !child.group ? { ...child, group: groupName } : child);
      }
    } else {
      out.push(entry);
    }
  }
  return out;
}

function normalizeIngredient(entry, index) {
  if (typeof entry === 'string') {
    const parsed = parseIngredientLine(decodeHtmlEntities(entry));
    if (!parsed) return null;
    return {
      id: `ing-${index + 1}`,
      name: parsed.name,
      amount: parsed.amount,
      amount_max: parsed.amount_max,
      amount_text: parsed.amount_text,
      unit: parsed.unit,
      note: parsed.note,
      group: '',
      scalable: parsed.amount != null
    };
  }
  if (!entry || typeof entry !== 'object') return null;

  const name = pickString(entry, ['name', 'ingredient', 'item', 'label', 'text', 'title']);
  const rawAmount = entry.amount ?? entry.quantity ?? entry.qty ?? entry.value ?? '';
  const parsed = parseAmount(rawAmount);
  const amountMax = pickNumber(entry, ['amount_max', 'amountMax', 'quantity_max', 'max_amount']);
  const unit = pickString(entry, ['unit', 'units', 'measure', 'measurement']);
  const note = pickString(entry, ['note', 'notes', 'prep', 'preparation', 'detail']);
  const group = pickString(entry, ['group', 'section', 'category', 'component', 'for']);

  if (!name && !parsed.text) return null;

  // A bare string amount that could not be parsed ("to taste") is kept as text.
  return {
    id: pickString(entry, ['id', 'key', 'slug']) || `ing-${index + 1}`,
    name: name || parsed.text,
    amount: parsed.amount,
    amount_max: amountMax ?? parsed.amount_max,
    amount_text: parsed.amount == null ? parsed.text : '',
    unit,
    note,
    group,
    scalable: entry.scalable === false ? false : parsed.amount != null
  };
}

function normalizeStep(entry, index) {
  if (typeof entry === 'string') {
    const raw = decodeHtmlEntities(entry).trim();
    if (!raw) return null;
    const split = splitLeadingLabel(raw);
    return {
      id: `step-${index + 1}`,
      title: split ? split.title : '',
      content: split ? split.content : raw,
      group: '',
      timer_seconds: inferTimerSeconds(raw)
    };
  }
  if (!entry || typeof entry !== 'object') return null;

  let title = pickString(entry, ['title', 'name', 'heading', 'label', 'step_title']);
  let content = pickString(entry, [
    'content', 'text', 'instruction', 'instructions', 'description', 'body', 'detail', 'step'
  ]);
  if (!title && !content) return null;
  // schema.org HowToStep often duplicates its text into `name` — a title
  // identical to the content isn't a title, it's noise.
  if (title && title === content) title = '';
  if (!title) {
    const split = splitLeadingLabel(content);
    if (split) ({ title, content } = split);
  }

  let timer = pickNumber(entry, TIMER_KEYS);
  if (timer == null) {
    const timerText = pickString(entry, ['timer', 'duration', 'time', 'timer_text']);
    if (timerText) timer = inferTimerSeconds(timerText);
  }
  if (timer == null && (entry.timer === true || entry.has_timer === true)) {
    timer = inferTimerSeconds(content);
  }
  if (timer != null && (!isFinite(timer) || timer <= 0)) timer = null;

  return {
    id: pickString(entry, ['id', 'key', 'slug']) || `step-${index + 1}`,
    title,
    content: content || title,
    group: pickString(entry, ['group', 'section']),
    timer_seconds: timer == null ? null : Math.round(timer)
  };
}

function collectNotes(card) {
  const notes = [];
  for (const key of NOTE_KEYS) {
    for (const value of toArray(card?.[key])) {
      if (typeof value === 'string' && value.trim()) notes.push(decodeHtmlEntities(value.trim()));
      else if (value && typeof value === 'object') {
        const text = pickString(value, ['text', 'content', 'note', 'body', 'title']);
        if (text) notes.push(text);
      }
    }
  }
  return notes;
}

/** Like pickString, but also accepts an array of strings (schema.org
 * recipeCuisine/recipeCategory are often ["Thai"] rather than "Thai"). */
function pickStringOrArray(card, keys) {
  for (const key of keys) {
    const value = card?.[key];
    const found = pickString(card, [key]);
    if (found) return found;
    if (Array.isArray(value)) {
      const joined = value.filter((v) => typeof v === 'string' && v.trim()).join(', ');
      if (joined) return joined;
    }
  }
  return '';
}

const TIME_KEYS = new Set(['prep_time', 'cook_time', 'total_time']);

function collectMeta(card) {
  const meta = {};
  const map = {
    prep_time: ['prep_time', 'prepTime', 'prep'],
    cook_time: ['cook_time', 'cookTime', 'cook'],
    total_time: ['total_time', 'totalTime', 'time'],
    difficulty: ['difficulty', 'level'],
    cuisine: ['cuisine', 'style', 'recipeCuisine'],
    course: ['course', 'meal', 'category', 'recipeCategory'],
    yield: ['yield', 'makes_text', 'output'],
    equipment: ['equipment', 'appliance', 'device', 'tool']
  };
  for (const [key, aliases] of Object.entries(map)) {
    const value = pickStringOrArray(card, aliases);
    if (value) meta[key] = TIME_KEYS.has(key) ? humanDuration(value) : value;
  }
  const tags = toArray(card?.tags ?? card?.keywords).filter((t) => typeof t === 'string' && t.trim());
  if (tags.length) meta.tags = tags.map((t) => t.trim());
  return meta;
}

function firstArray(card, keys) {
  for (const key of keys) {
    if (Array.isArray(card[key])) return card[key];
  }
  return [];
}

/**
 * Normalise one raw card object into the canonical recipe shape.
 * Returns null when the object does not carry enough to be a recipe.
 */
export function normalizeRecipe(rawCard, context = {}) {
  if (!rawCard || typeof rawCard !== 'object') return null;
  const card = rawCard.recipe && typeof rawCard.recipe === 'object' ? rawCard.recipe : rawCard;

  const ingredients = firstArray(card, INGREDIENT_KEYS)
    .map(normalizeIngredient)
    .filter(Boolean)
    .map((ing, i) => ({ ...ing, id: ing.id || `ing-${i + 1}` }));

  const steps = flattenSteps(firstArray(card, STEP_KEYS))
    .map(normalizeStep)
    .filter(Boolean)
    .map((step, i) => ({ ...step, id: step.id || `step-${i + 1}`, number: i + 1 }));

  if (!ingredients.length && !steps.length) return null;

  const title = pickString(card, TITLE_KEYS) || context.fallbackTitle || 'Untitled recipe';
  const servings = firstServingsNumber(card.recipeYield) ?? pickNumber(card, SERVINGS_KEYS);
  const baseServings = servings && servings > 0 ? Math.round(servings) : 4;

  return {
    title,
    slug: slugify(title, `recipe-${(context.index ?? 0) + 1}`),
    description: pickString(card, DESCRIPTION_KEYS),
    base_servings: baseServings,
    servings_unit: pickString(card, ['servings_unit', 'servingsUnit', 'serving_label']) || 'servings',
    ingredients,
    steps,
    notes: collectNotes(card),
    meta: collectMeta(card),
    source: {
      index: context.index ?? 0,
      origin: context.origin || 'unknown',
      message: context.message ?? null,
      format: context.format || 'json'
    }
  };
}
