/**
 * Amount / duration formatting shared by the CLI and the exported cards.
 *
 * This file is imported normally by the Node code AND inlined verbatim into
 * every exported HTML card (with the `export ` keywords stripped), so the
 * numbers a card shows in the browser always match what the CLI computes.
 * Keep it dependency-free and ES5-friendly in its runtime behaviour.
 */

/** Units that read better as decimals than as kitchen fractions. */
export const DECIMAL_UNITS = [
  'g', 'gram', 'grams', 'kg', 'kilogram', 'kilograms',
  'mg', 'ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres',
  'l', 'liter', 'liters', 'litre', 'litres', 'dl', 'cl',
  'oz', 'ounce', 'ounces', 'floz', 'fl oz', 'fluid ounce', 'fluid ounces',
  'lb', 'lbs', 'pound', 'pounds', 'kcal', 'cal', 'c', 'f', 'celsius', 'fahrenheit'
];

const VULGAR = {
  '1/2': '½',
  '1/3': '⅓',
  '2/3': '⅔',
  '1/4': '¼',
  '3/4': '¾',
  '1/8': '⅛',
  '3/8': '⅜',
  '5/8': '⅝',
  '7/8': '⅞'
};

/** True when the unit should be rendered with decimals rather than fractions. */
export function isDecimalUnit(unit) {
  if (!unit) return false;
  return DECIMAL_UNITS.indexOf(String(unit).trim().toLowerCase()) !== -1;
}

/** Round to `places` decimals and drop trailing zeroes. */
export function trimNumber(value, places) {
  const rounded = Number(value.toFixed(places));
  return String(rounded);
}

/** Decimal presentation: coarser as the number grows, so scaling stays sane. */
export function formatDecimal(value) {
  const abs = Math.abs(value);
  if (abs >= 100) return trimNumber(value, 0);
  if (abs >= 10) return trimNumber(value, 1);
  if (abs >= 1) return trimNumber(value, 2);
  return trimNumber(value, 2);
}

/**
 * Format a scaled amount. Kitchen units snap to familiar fractions
 * (1.5 -> 1½, 0.333 -> ⅓); weights and volumes stay decimal.
 */
export function formatAmount(value, unit) {
  if (typeof value !== 'number' || !isFinite(value)) return '';
  if (value === 0) return '0';
  const negative = value < 0;
  const abs = Math.abs(value);
  let out;
  if (isDecimalUnit(unit)) {
    out = formatDecimal(abs);
  } else {
    out = formatFraction(abs);
  }
  return negative ? '-' + out : out;
}

/** Snap to the nearest common kitchen fraction, or fall back to decimals. */
export function formatFraction(abs) {
  const whole = Math.floor(abs + 1e-9);
  const remainder = abs - whole;
  if (remainder < 0.02) return String(whole);
  const denominators = [2, 3, 4, 8];
  for (let i = 0; i < denominators.length; i += 1) {
    const den = denominators[i];
    const num = Math.round(remainder * den);
    if (num <= 0 || num >= den) continue;
    if (Math.abs(remainder - num / den) <= 0.021) {
      const key = num + '/' + den;
      const glyph = VULGAR[key] || key;
      return whole > 0 ? whole + glyph : glyph;
    }
  }
  return formatDecimal(abs);
}

/**
 * Full amount text for an ingredient at a given scale factor.
 * Handles ranges ("2-3 cloves") and non-numeric amounts ("to taste").
 */
export function scaledAmountText(ingredient, factor) {
  if (typeof ingredient.amount !== 'number' || !isFinite(ingredient.amount)) {
    return ingredient.amount_text || '';
  }
  const unit = ingredient.unit || '';
  const low = formatAmount(ingredient.amount * factor, unit);
  if (typeof ingredient.amount_max === 'number' && isFinite(ingredient.amount_max)) {
    const high = formatAmount(ingredient.amount_max * factor, unit);
    if (high && high !== low) return low + '–' + high;
  }
  return low;
}

/** Seconds -> clock display, e.g. 90 -> "1:30", 3725 -> "1:02:05". */
export function formatClock(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = function (n) { return n < 10 ? '0' + n : String(n); };
  if (hrs > 0) return hrs + ':' + pad(mins) + ':' + pad(secs);
  return mins + ':' + pad(secs);
}

/** Seconds -> human label, e.g. 90 -> "1 min 30 sec". */
export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds === 0) return '0 sec';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts = [];
  if (hrs) parts.push(hrs + ' hr');
  if (mins) parts.push(mins + ' min');
  if (secs) parts.push(secs + ' sec');
  return parts.join(' ');
}

/** Word units that read wrong when the scaled amount stops being singular. */
export const COUNTABLE_UNITS = [
  'cup', 'clove', 'slice', 'stick', 'sprig', 'pinch', 'dash', 'can', 'packet',
  'package', 'scoop', 'handful', 'bunch', 'tablespoon', 'teaspoon', 'ounce',
  'pound', 'quart', 'pint', 'gallon', 'liter', 'litre', 'gram', 'kilogram',
  'head', 'ear', 'rib', 'strip', 'fillet', 'sheet', 'piece', 'bulb', 'stalk',
  'leaf', 'wedge', 'square', 'drop', 'knob', 'jar', 'bottle', 'tin', 'bag', 'box', 'stem'
];

const IRREGULAR_PLURALS = { leaf: 'leaves' };

/**
 * Agree a unit with its (scaled) amount: 1 cup / 2 cups, 3 cloves / 1 clove.
 * Abbreviations (tsp, tbsp, g, ml) and unknown units are left untouched.
 */
export function formatUnit(unit, value) {
  const raw = String(unit || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  const candidates = [lower, lower.replace(/s$/, ''), lower.replace(/es$/, ''), lower.replace(/ves$/, 'f')];
  let base = null;
  for (let i = 0; i < candidates.length; i += 1) {
    if (COUNTABLE_UNITS.indexOf(candidates[i]) !== -1) { base = candidates[i]; break; }
  }
  if (!base) return raw;

  const plural = IRREGULAR_PLURALS[base] || (/(?:ch|sh|s|x|z)$/.test(base) ? base + 'es' : base + 's');
  // Recipes write "1 cup" and "½ cup", but "2 cups" — anything at or under one
  // portion stays singular.
  const wantsPlural = !(typeof value === 'number' && value > 0 && value <= 1 + 1e-9);
  const agreed = wantsPlural ? plural : base;
  // Preserve the capitalisation the recipe used.
  return raw[0] === raw[0].toUpperCase() && raw[0] !== raw[0].toLowerCase()
    ? agreed.charAt(0).toUpperCase() + agreed.slice(1)
    : agreed;
}

/** Amount + agreed unit, e.g. "2 cups" / "1 cup" / "180 g". */
export function scaledAmountWithUnit(ingredient, factor) {
  const amount = scaledAmountText(ingredient, factor);
  if (typeof ingredient.amount !== 'number' || !isFinite(ingredient.amount)) {
    const staticUnit = ingredient.unit ? ' ' + ingredient.unit : '';
    return amount ? amount + staticUnit : '';
  }
  const scaled = ingredient.amount * factor;
  const unit = formatUnit(ingredient.unit, ingredient.amount_max ? null : scaled);
  return unit ? amount + ' ' + unit : amount;
}
