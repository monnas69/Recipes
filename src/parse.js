/**
 * Extraction: find recipe cards inside conversation text.
 *
 * Four strategies, tried in order and merged:
 *   1. Fenced code blocks tagged ```recipe-card / ```recipe / ```json
 *   2. <recipe-card> ... </recipe-card> style tagged blocks
 *   3. Bare JSON objects embedded in prose (balanced-brace scan)
 *   4. Markdown fallback: "## Title / Ingredients / Instructions" prose
 */

import { isRecipeCandidate, normalizeRecipe } from './normalize.js';
import { looseJsonParse } from './transcript.js';
import { inferTimerSeconds, parseAmount } from './quantity.js';
import { slugify } from './util.js';

const RECIPE_FENCE_LANGS = /^(recipe[-_]?card|recipe|json5?|jsonc)$/i;
const SECTION_PATTERNS = {
  ingredients: /^(ingredients?|you(?:'|’)?ll need|shopping list|what you need)\b/i,
  steps: /^(instructions?|steps?|method|directions?|preparation|how to (?:make|cook) it)\b/i,
  notes: /^(notes?|tips?|chef(?:'|’)?s notes?|storage|make ahead|variations?)\b/i
};

/** ```lang ... ``` blocks. */
export function extractFencedBlocks(text) {
  const blocks = [];
  const re = /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*([\w-]*)[ \t]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    blocks.push({ lang: (match[3] || '').trim(), body: match[4] });
  }
  return blocks;
}

/** <recipe-card>…</recipe-card> / <recipe>…</recipe> blocks. */
export function extractTaggedBlocks(text) {
  const blocks = [];
  const re = /<(recipe[-_]?card|recipe)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = re.exec(text)) !== null) blocks.push({ tag: match[1], body: match[2] });
  return blocks;
}

/** Every balanced top-level {...} region in a string, ignoring braces in strings. */
export function extractJsonObjects(text) {
  const results = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          results.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return results;
}

/** Walk a parsed JSON tree and collect everything that looks like a card. */
export function scanJsonTree(node, found = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return found;
  if (Array.isArray(node)) {
    for (const item of node) scanJsonTree(item, found, depth + 1);
    return found;
  }
  if (isRecipeCandidate(node)) {
    found.push(node);
    return found; // Don't descend into a card's own ingredient/step objects.
  }
  for (const value of Object.values(node)) scanJsonTree(value, found, depth + 1);
  return found;
}

/** Structured (JSON-ish) cards found in one text blob. */
export function findStructuredCards(text) {
  const cards = [];
  const push = (payload, format) => {
    const parsed = typeof payload === 'string' ? looseJsonParse(payload) : payload;
    if (parsed === undefined) return;
    for (const card of scanJsonTree(parsed)) cards.push({ card, format });
  };

  for (const block of extractFencedBlocks(text)) {
    if (block.lang && !RECIPE_FENCE_LANGS.test(block.lang)) continue;
    push(block.body, block.lang ? `fence:${block.lang.toLowerCase()}` : 'fence');
  }
  for (const block of extractTaggedBlocks(text)) push(block.body, `tag:${block.tag.toLowerCase()}`);

  // Bare JSON in prose — only when no fenced/tagged card was found, and with a
  // cheap pre-filter before the balanced-brace scan.
  if (!cards.length && /"(ingredients|steps|instructions)"\s*:/.test(text)) {
    for (const candidate of extractJsonObjects(text)) {
      if (!/"(ingredients|steps|instructions)"\s*:/.test(candidate)) continue;
      push(candidate, 'inline-json');
    }
  }
  return cards;
}

/* ------------------------------------------------------------------ */
/* Markdown fallback                                                   */
/* ------------------------------------------------------------------ */

function headingInfo(line) {
  const hash = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
  if (hash) return { level: hash[1].length, title: hash[2].trim() };
  const bold = line.match(/^\s*\*\*(.+?)\*\*:?\s*$/);
  if (bold) return { level: 4, title: bold[1].trim() };
  const plain = line.match(/^([A-Z][^:\n]{2,60}):\s*$/);
  if (plain) return { level: 5, title: plain[1].trim() };
  return null;
}

function sectionKind(title) {
  for (const [kind, pattern] of Object.entries(SECTION_PATTERNS)) {
    if (pattern.test(title)) return kind;
  }
  return null;
}

function listItems(lines) {
  const items = [];
  let current = null;
  for (const line of lines) {
    const bullet = line.match(/^\s*(?:[-*+•]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      if (current) items.push(current);
      current = bullet[1].trim();
      continue;
    }
    if (current && /^\s{2,}\S/.test(line)) {
      current += ' ' + line.trim();
      continue;
    }
    if (current) { items.push(current); current = null; }
  }
  if (current) items.push(current);
  return items;
}

function paragraphs(lines) {
  return lines
    .join('\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function stepFromText(text) {
  const cleaned = text.replace(/^\*\*Step\s*\d+[:.]?\s*/i, '**').trim();
  const bold = cleaned.match(/^\*\*(.+?)\*\*[:.—-]*\s*([\s\S]*)$/);
  if (bold && bold[2].trim()) {
    return { title: bold[1].trim(), content: bold[2].trim() };
  }
  const colon = cleaned.match(/^([A-Z][^.:]{2,48}):\s+([\s\S]+)$/);
  if (colon) return { title: colon[1].trim(), content: colon[2].trim() };
  return { title: '', content: cleaned.replace(/\*\*/g, '').trim() };
}

function findServings(text) {
  const patterns = [
    /\b(?:base[_\s-]?servings|servings?|serves|portions|makes|yields?)\s*[:=]?\s*(\d+)/i,
    /\bfor\s+(\d+)\s+(?:people|servings?)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0 && value <= 200) return value;
    }
  }
  return null;
}

/**
 * Parse Markdown-style recipes ("## Title", "### Ingredients", "### Steps").
 * Used when a blob carries no structured card.
 */
export function parseMarkdownRecipes(text) {
  const lines = String(text).split(/\r?\n/);
  const headings = [];
  lines.forEach((line, index) => {
    const info = headingInfo(line);
    if (info) headings.push({ ...info, index, kind: sectionKind(info.title) });
  });

  const ingredientMarkers = headings.filter((h) => h.kind === 'ingredients');
  const recipes = [];

  ingredientMarkers.forEach((marker, markerIndex) => {
    const titleHeading = [...headings]
      .filter((h) => h.index < marker.index && !h.kind)
      .pop();
    const startIndex = titleHeading ? titleHeading.index : marker.index;
    const nextMarker = ingredientMarkers[markerIndex + 1];
    let endIndex = lines.length;
    if (nextMarker) {
      const nextTitle = [...headings].filter((h) => h.index < nextMarker.index && !h.kind).pop();
      endIndex = nextTitle && nextTitle.index > marker.index ? nextTitle.index : nextMarker.index;
    }

    const body = lines.slice(startIndex, endIndex);
    const bodyHeadings = headings
      .filter((h) => h.index >= startIndex && h.index < endIndex)
      .map((h) => ({ ...h, offset: h.index - startIndex }));

    const sliceFor = (kind) => {
      const start = bodyHeadings.find((h) => h.kind === kind);
      if (!start) return [];
      const after = bodyHeadings.find((h) => h.offset > start.offset && (h.kind || h.level <= start.level));
      return body.slice(start.offset + 1, after ? after.offset : body.length);
    };

    const ingredientLines = listItems(sliceFor('ingredients'));
    const stepSource = sliceFor('steps');
    const stepItems = listItems(stepSource);
    const steps = (stepItems.length ? stepItems : paragraphs(stepSource)).map((item) => {
      const { title, content } = stepFromText(item);
      return { title, content, timer_seconds: inferTimerSeconds(content) };
    });
    const noteLines = sliceFor('notes');
    const notes = listItems(noteLines).length ? listItems(noteLines) : paragraphs(noteLines);

    if (!ingredientLines.length || !steps.length) return;

    const title = titleHeading ? titleHeading.title.replace(/\*\*/g, '').trim() : 'Untitled recipe';
    const descriptionLines = titleHeading
      ? body.slice(1, bodyHeadings.find((h) => h.kind)?.offset ?? 1)
      : [];
    const description = paragraphs(descriptionLines)
      .filter((p) => !/^(serves|servings|makes|prep time|cook time|total time)\b/i.test(p))
      .join(' ');

    recipes.push({
      title,
      description,
      base_servings: findServings(body.join('\n')),
      ingredients: ingredientLines,
      steps,
      notes
    });
  });

  return recipes;
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Identity of a card for de-duplication. Everything a cook would notice is in
 * here, so a revised card (different servings, tweaked note) survives as its
 * own recipe while a verbatim repeat is dropped.
 */
function signature(recipe) {
  return JSON.stringify({
    t: recipe.title.toLowerCase(),
    d: recipe.description.toLowerCase(),
    v: recipe.base_servings,
    i: recipe.ingredients.map((x) => [x.name.toLowerCase(), x.amount, x.amount_max, x.unit, x.note]),
    s: recipe.steps.map((x) => `${x.title}|${x.content}|${x.timer_seconds}`.toLowerCase()),
    n: recipe.notes.map((x) => x.toLowerCase())
  });
}

/**
 * Extract every recipe from a loaded source.
 *
 * @param {{blobs: Array, data?: any, origin?: string}} source
 * @param {{markdownFallback?: boolean, keep?: 'all'|'latest'}} options
 * @returns {{recipes: Array, stats: object}}
 */
export function extractRecipes(source, options = {}) {
  const { markdownFallback = true, keep = 'all' } = options;
  const origin = source.origin || 'input';
  const found = [];
  const stats = { structured: 0, markdown: 0, duplicates: 0, blobs: source.blobs?.length || 0 };

  const add = (card, context) => {
    const recipe = normalizeRecipe(card, context);
    if (recipe) found.push(recipe);
    return Boolean(recipe);
  };

  // Cards sitting directly in the JSON tree (artifact payloads, API responses).
  if (source.data !== undefined) {
    for (const card of scanJsonTree(source.data)) {
      if (add(card, { origin, index: found.length, format: 'json-tree' })) stats.structured += 1;
    }
  }

  for (const blob of source.blobs || []) {
    const structured = findStructuredCards(blob.text);
    for (const { card, format } of structured) {
      if (add(card, { origin, index: found.length, message: blob.label, format })) stats.structured += 1;
    }
    if (!structured.length && markdownFallback) {
      for (const card of parseMarkdownRecipes(blob.text)) {
        if (add(card, { origin, index: found.length, message: blob.label, format: 'markdown' })) {
          stats.markdown += 1;
        }
      }
    }
  }

  // Drop exact duplicates (the same card re-sent later in the conversation).
  const seen = new Map();
  const unique = [];
  for (const recipe of found) {
    const key = signature(recipe);
    if (seen.has(key)) { stats.duplicates += 1; continue; }
    seen.set(key, true);
    unique.push(recipe);
  }

  let recipes = unique;
  if (keep === 'latest') {
    const bySlug = new Map();
    for (const recipe of unique) bySlug.set(recipe.slug, recipe);
    recipes = [...bySlug.values()];
    stats.superseded = unique.length - recipes.length;
  }

  // Make slugs unique so batch exports never collide on disk.
  const usedSlugs = new Map();
  recipes.forEach((recipe, index) => {
    const base = recipe.slug || slugify(recipe.title, `recipe-${index + 1}`);
    const count = usedSlugs.get(base) || 0;
    usedSlugs.set(base, count + 1);
    recipe.slug = count === 0 ? base : `${base}-${count + 1}`;
    recipe.index = index;
  });

  stats.total = recipes.length;
  return { recipes, stats };
}

export { parseAmount };
