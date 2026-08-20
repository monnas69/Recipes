/** Pipeline: load a source, extract recipe cards, write HTML (and PDF) files. */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadSource } from './transcript.js';
import { extractRecipes } from './parse.js';
import { renderCard, renderIndex } from './render.js';
import { htmlFileToPdf } from './pdf.js';

/**
 * Find every recipe in a source without writing anything.
 * @returns {Promise<{recipes: Array, stats: object, origin: string}>}
 */
export async function collectRecipes(source, options = {}) {
  const loaded = await loadSource(source, {
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

  if (!recipes.length) return { recipes, files, stats, origin, outDir };

  await mkdir(outDir, { recursive: true });
  const wantIndex = options.index !== false && recipes.length > 1;

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
    await writeFile(indexPath, renderIndex(recipes, { generatedAt, sourceLabel: options.sourceLabel ?? origin }), 'utf8');
    files.push({ type: 'index', path: indexPath });
  }

  if (options.json) {
    const jsonPath = path.join(outDir, 'recipes.json');
    await writeFile(jsonPath, `${JSON.stringify({ origin, generatedAt, recipes }, null, 2)}\n`, 'utf8');
    files.push({ type: 'json', path: jsonPath });
  }

  return { recipes, files, stats, origin, outDir };
}
