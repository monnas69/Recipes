/** Small shared helpers used across the parser, normaliser and renderer. */

/** Turn arbitrary text into a filesystem- and URL-safe slug. */
export function slugify(text, fallback = 'recipe') {
  const slug = String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'"
};

/**
 * Decode HTML entities in plain text (&#39; &quot; &nbsp; etc). Many recipe
 * sites embed schema.org Recipe data whose ingredient/step text is raw,
 * HTML-escaped CMS content rather than plain text, so this runs on every
 * string pulled out of a source card, not just HTML pages.
 */
export function decodeHtmlEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    if (HTML_ENTITIES[key] != null) return HTML_ENTITIES[key];
    if (key.startsWith('#x')) return String.fromCodePoint(parseInt(key.slice(2), 16));
    if (key.startsWith('#')) return String.fromCodePoint(parseInt(key.slice(1), 10));
    return match;
  });
}

/** Escape text for interpolation into HTML element content or attributes. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape a JSON payload so it can be embedded inside a <script> tag without
 * the closing tag (or a line separator) terminating the script early.
 */
export function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Make `name` unique against the names already present in `taken`. */
export function uniqueName(name, taken) {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  let n = 2;
  while (taken.has(`${name}-${n}`)) n += 1;
  const unique = `${name}-${n}`;
  taken.add(unique);
  return unique;
}

/** Coerce anything vaguely list-shaped into an array. */
export function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** First non-empty string among the given object keys. */
export function pickString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'string' && value.trim()) return decodeHtmlEntities(value.trim());
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

/** First finite number among the given object keys. */
export function pickNumber(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}
