/** Pipeline: load a source, extract recipe cards, write HTML (and PDF) files. */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadSources } from './transcript.js';
import { extractRecipes } from './parse.js';
import { renderCard, renderIndex } from './render.js';
import { htmlFileToPdf } from './pdf.js';
import { scanLibrary, mergeLibrary } from './library.js';

/**
 * Find every recipe in one or more sources without writing anything.
 * @returns {Promise<{recipes: Array, stats: object, origin: string}>}
 */
export async function collectRecipes(source, options = {}) {
  const loaded = await loadSources(source, {
    format: options.format,
    sessionKey: options.sessionKey
  });
  const { recipes, stats } = extractRecipes(loaded, {
    markdownFallback: options.markdownFallback !== false,
    keep: options.keep || 'all'
  });

  const filtered = options.titleFilter
    ? recipes.filter((recipe) => recipe.title.toLowerCase().includes(String(options.titleFilter).toLowerCase()))
    : recipes;

  return { recipes: filtered, stats: { ...stats, filtered: recipes.length - filtered.length }, origin: loaded.origin };
}

/**
 * Full export: recipes -> ./out/<slug>.html (+ index.html, + PDFs).
 * @returns {Promise<{recipes: Array, files: Array, stats: object, origin: string}>}
 */
export async function exportRecipes(source, options = {}) {
  const { recipes, stats, origin } = await collectRecipes(source, options);
  const outDir = path.resolve(options.outDir || 'recipe-cards');
  const generatedAt = options.generatedAt || new Date().toISOString();
  const files = [];

  if (!recipes.length) return { recipes, files, stats, origin, outDir, library: [] };

  await mkdir(outDir, { recursive: true });

  // The index is rebuilt from every card in the folder, not just this run's,
  // so exporting one new chat into an existing library keeps the rest listed.
  const existing = options.library === false ? [] : await scanLibrary(outDir);
  const library = options.library === false ? recipes : mergeLibrary(existing, recipes);
  stats.library = library.length;
  stats.carried_over = Math.max(0, library.length - recipes.length);
  // Always written: the output folder is meant to be browsable (and a GitHub
  // Pages site needs a root page even when it holds a single card).
  const wantIndex = options.index !== false;

  for (const recipe of recipes) {
    const html = renderCard(recipe, {
      generatedAt,
      sourceLabel: options.sourceLabel ?? origin,
      backLink: wantIndex ? 'index.html' : null
    });
    const htmlPath = path.join(outDir, `${recipe.slug}.html`);
    await writeFile(htmlPath, html, 'utf8');
    files.push({ type: 'html', path: htmlPath, recipe: recipe.slug });

    if (options.pdf) {
      const pdfPath = path.join(outDir, `${recipe.slug}.pdf`);
      const result = await htmlFileToPdf(htmlPath, pdfPath, { chromePath: options.chromePath });
      files.push({ type: 'pdf', path: pdfPath, recipe: recipe.slug, backend: result.backend });
    }
  }

  if (wantIndex) {
    const indexPath = path.join(outDir, 'index.html');
    const html = renderIndex(library, {
      generatedAt,
      sourceLabel: options.sourceLabel ?? origin,
      title: options.siteTitle
    });
    await writeFile(indexPath, html, 'utf8');
    files.push({ type: 'index', path: indexPath, cards: library.length });
  }

  if (options.json) {
    const jsonPath = path.join(outDir, 'recipes.json');
    await writeFile(jsonPath, `${JSON.stringify({ origin, generatedAt, recipes }, null, 2)}\n`, 'utf8');
    files.push({ type: 'json', path: jsonPath });
  }

  return { recipes, files, stats, origin, outDir, library };
}
