/**
 * Library support: read previously exported cards back out of an output
 * folder, so the index can be rebuilt from everything that is there rather
 * than only from the run that happens to be writing right now.
 *
 * Every exported card embeds its own recipe as JSON, so the folder is its own
 * database — delete a card file and it leaves the index on the next run.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const PAYLOAD_OPEN = '<script type="application/json" id="recipe-json">';
const PAYLOAD_CLOSE = '</script>';

/** Pull the embedded recipe payload out of an exported card. */
export function readCardHtml(html) {
  const start = html.indexOf(PAYLOAD_OPEN);
  if (start === -1) return null;
  const from = start + PAYLOAD_OPEN.length;
  const end = html.indexOf(PAYLOAD_CLOSE, from);
  if (end === -1) return null;
  try {
    const payload = JSON.parse(html.slice(from, end));
    if (!payload || !Array.isArray(payload.ingredients) || !Array.isArray(payload.steps)) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Every card already sitting in `dir`, newest file first.
 * Missing directories simply yield an empty library.
 */
export async function scanLibrary(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const cards = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.html') || entry === 'index.html') continue;
    const file = path.join(dir, entry);
    let html;
    let stats;
    try {
      [html, stats] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    } catch {
      continue;
    }
    const payload = readCardHtml(html);
    if (!payload) continue;
    cards.push({
      ...payload,
      slug: payload.slug || entry.replace(/\.html$/, ''),
      file: entry,
      updated_at: stats.mtime.toISOString()
    });
  }
  return cards;
}

/**
 * Merge this run's recipes over whatever the folder already holds.
 * A freshly exported card wins over its older copy of the same slug.
 */
export function mergeLibrary(existing, fresh) {
  const bySlug = new Map();
  for (const card of existing) bySlug.set(card.slug, card);
  for (const recipe of fresh) {
    bySlug.set(recipe.slug, { ...bySlug.get(recipe.slug), ...recipe, updated_at: new Date().toISOString() });
  }
  return [...bySlug.values()].sort((a, b) => a.title.localeCompare(b.title));
}
