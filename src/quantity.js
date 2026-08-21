/** Parsing of free-text quantities into structured amounts. */

const UNICODE_FRACTIONS = {
  '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75,
  '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8, '⅙': 1 / 6, '⅚': 5 / 6,
  '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875
};

/** Units recognised when splitting a free-text ingredient line. */
export const KNOWN_UNITS = [
  'cups', 'cup', 'c',
  'tablespoons', 'tablespoon', 'tbsps', 'tbsp', 'tbs', 'tb',
  'teaspoons', 'teaspoon', 'tsps', 'tsp',
  'grams', 'gram', 'g', 'kilograms', 'kilogram', 'kg', 'mg',
  'milliliters', 'milliliter', 'millilitres', 'millilitre', 'ml',
  'liters', 'liter', 'litres', 'litre', 'l', 'dl', 'cl',
  'ounces', 'ounce', 'oz', 'fl oz', 'floz',
  'pounds', 'pound', 'lbs', 'lb',
  'pinches', 'pinch', 'dashes', 'dash', 'sprigs', 'sprig',
  'cloves', 'clove', 'slices', 'slice', 'sticks', 'stick',
  'cans', 'can', 'packets', 'packet', 'packages', 'package', 'pkg',
  'scoops', 'scoop', 'handfuls', 'handful', 'bunches', 'bunch',
  'quarts', 'quart', 'qt', 'pints', 'pint', 'pt', 'gallons', 'gallon', 'gal'
];

const NUMBER_TOKEN = '(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d*[.,]?\\d+|[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])';
const RANGE_SEPARATOR = '(?:\\s*(?:-|–|—|to|or)\\s*)';

/** Convert a single numeric token ("1 1/2", "3/4", "1½", "2.5") to a number. */
export function parseNumberToken(token) {
  if (token == null) return null;
  let text = String(token).trim().replace(/,(\d)/g, '.$1');
  if (!text) return null;

  let total = 0;
  let matched = false;

  // Split a trailing unicode fraction off a leading whole number ("1½").
  const unicodeMatch = text.match(/([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])/);
  if (unicodeMatch) {
    const glyph = unicodeMatch[1];
    total += UNICODE_FRACTIONS[glyph];
    matched = true;
    text = text.replace(glyph, ' ').trim();
  }

  const parts = text.split(/\s+/).filter(Boolean);
  for (const part of parts) {
    const fraction = part.match(/^(\d+)\/(\d+)$/);
    if (fraction) {
      const den = Number(fraction[2]);
      if (den === 0) return null;
      total += Number(fraction[1]) / den;
      matched = true;
      continue;
    }
    if (/^\d*\.?\d+$/.test(part)) {
      total += Number(part);
      matched = true;
      continue;
    }
    return matched ? null : null;
  }
  return matched && isFinite(total) ? total : null;
}

/**
 * Parse an amount that may be a number, a fraction, or a range.
 * Returns { amount, amount_max, text } — amount is null when unparseable.
 */
export function parseAmount(input) {
  if (typeof input === 'number' && isFinite(input)) {
    return { amount: input, amount_max: null, text: String(input) };
  }
  const text = String(input ?? '').trim();
  if (!text) return { amount: null, amount_max: null, text: '' };

  const rangeRe = new RegExp('^(' + NUMBER_TOKEN + ')' + RANGE_SEPARATOR + '(' + NUMBER_TOKEN + ')$', 'i');
  const range = text.match(rangeRe);
  if (range) {
    const low = parseNumberToken(range[1]);
    const high = parseNumberToken(range[2]);
    if (low != null && high != null) return { amount: low, amount_max: high, text };
  }

  const single = parseNumberToken(text);
  if (single != null) return { amount: single, amount_max: null, text };
  return { amount: null, amount_max: null, text };
}

/**
 * Split a free-text ingredient line into amount / unit / name / note.
 * Used for the Markdown fallback parser, e.g.
 *   "1 1/2 cups all-purpose flour, sifted"
 */
export function parseIngredientLine(line) {
  const raw = String(line ?? '').trim().replace(/^[-*+•]\s*/, '').replace(/^\d+[.)]\s+/, '');
  if (!raw) return null;

  const unitAlternatives = KNOWN_UNITS
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');

  const re = new RegExp(
    '^(' + NUMBER_TOKEN + '(?:' + RANGE_SEPARATOR + NUMBER_TOKEN + ')?)' +
    '\\s*(' + unitAlternatives + ')?\\.?\\s*(?:of\\s+)?(.*)$',
    'i'
  );

  const match = raw.match(re);
  if (!match) {
    return { amount: null, amount_max: null, unit: '', name: raw, amount_text: '', note: '' };
  }

  const parsed = parseAmount(match[1]);
  const unit = (match[2] || '').toLowerCase();
  let rest = (match[3] || '').trim();
  let note = '';

  const noteMatch = rest.match(/^(.*?),\s*(.+)$/);
  if (noteMatch && /^(chopped|sliced|diced|minced|melted|softened|room temperature|to taste|divided|plus more|finely|roughly|optional|drained|rinsed|grated|crushed|toasted|beaten|peeled|halved|quartered|cubed|thinly|packed|sifted|warmed|cooled|separated)/i.test(noteMatch[2])) {
    rest = noteMatch[1].trim();
    note = noteMatch[2].trim();
  }

  if (!rest) {
    return { amount: null, amount_max: null, unit: '', name: raw, amount_text: '', note: '' };
  }

  return {
    amount: parsed.amount,
    amount_max: parsed.amount_max,
    unit,
    name: rest,
    amount_text: parsed.amount == null ? parsed.text : '',
    note
  };
}

/** Best-effort extraction of a timer from step text ("simmer for 12 minutes"). */
export function inferTimerSeconds(text) {
  const source = String(text ?? '');
  // A negative lookbehind keeps this off the "2" in "1/2" — without it,
  // "about 1 to 1 1/2 minutes" reads as a false "2 minutes" match, because
  // "2 minutes" is a literal substring of "1/2 minutes".
  const re = new RegExp(
    '(?<![\\d/])(' + NUMBER_TOKEN + ')' + RANGE_SEPARATOR + '?(' + NUMBER_TOKEN + ')?' +
    '\\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\\b',
    'i'
  );
  const match = source.match(re);
  if (!match) return null;
  const value = parseNumberToken(match[2] ?? match[1]);
  if (value == null || !isFinite(value) || value <= 0) return null;
  const unit = match[3].toLowerCase();
  if (/^h/.test(unit)) return Math.round(value * 3600);
  if (/^m/.test(unit)) return Math.round(value * 60);
  return Math.round(value);
}
