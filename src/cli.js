/** Command-line interface for the recipe card exporter. */

import { parseArgs } from 'node:util';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { collectRecipes, exportRecipes } from './export.js';
import { renderCard } from './render.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const OPTIONS = {
  out: { type: 'string', short: 'o' },
  format: { type: 'string', short: 'f' },
  pdf: { type: 'boolean', default: false },
  index: { type: 'boolean', default: true },
  json: { type: 'boolean', default: false },
  keep: { type: 'string', default: 'all' },
  title: { type: 'string' },
  cookie: { type: 'string' },
  'markdown-fallback': { type: 'boolean', default: true },
  list: { type: 'boolean', default: false },
  stdout: { type: 'boolean', default: false },
  quiet: { type: 'boolean', short: 'q', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false }
};

const HELP = `
ninja-recipes — export Claude.ai recipe cards to self-contained HTML

Usage
  ninja-recipes <source> [options]

Source
  <file>                 conversation export: .json, .md, .txt or saved .html
  <url>                  https://claude.ai/chat/<id>  (needs --cookie, see below)
  -                      read the transcript from stdin

Options
  -o, --out <dir>        output directory                 (default: recipe-cards)
  -f, --format <fmt>     auto | json | markdown | text | html   (default: auto)
      --pdf              also write a PDF per card (puppeteer or local Chrome)
      --no-index         skip index.html when exporting several cards
      --json             also write recipes.json (the normalised data)
      --keep <mode>      all | latest  — latest keeps only the newest card per
                         title, useful when a chat revised a recipe   (default: all)
      --title <text>     only export cards whose title contains <text>
      --no-markdown-fallback
                         only accept structured cards, never prose recipes
      --cookie <value>   Claude.ai session cookie for URL fetches
                         (or set CLAUDE_SESSION_KEY)
      --list             list what was found, write nothing
      --stdout           print the first card's HTML to stdout, write nothing
  -q, --quiet            only print errors
  -h, --help             show this help
  -v, --version          print the version

Examples
  ninja-recipes chat-export.json -o cards
  ninja-recipes transcript.md --pdf --keep latest
  pbpaste | ninja-recipes - --stdout > card.html
  CLAUDE_SESSION_KEY=sk-... ninja-recipes https://claude.ai/chat/<id> -o cards
`;

function describe(recipe) {
  const timers = recipe.steps.filter((step) => step.timer_seconds).length;
  const bits = [
    `${recipe.ingredients.length} ingredients`,
    `${recipe.steps.length} steps`,
    timers ? `${timers} timers` : null,
    `serves ${recipe.base_servings}`,
    recipe.source?.format ? `via ${recipe.source.format}` : null
  ].filter(Boolean);
  return `${recipe.title}  (${bits.join(', ')})`;
}

export async function main(argv = process.argv.slice(2), io = console) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    io.error(`${error.message}\nRun \`ninja-recipes --help\` for usage.`);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.help) { io.log(HELP.trim()); return 0; }
  if (values.version) { io.log(pkg.version); return 0; }

  const source = positionals[0];
  if (!source) {
    io.error('Missing source. Pass a file, a Claude.ai URL, or `-` for stdin.\n' + HELP.trim());
    return 2;
  }
  if (!['all', 'latest'].includes(values.keep)) {
    io.error(`--keep must be "all" or "latest" (got "${values.keep}").`);
    return 2;
  }

  const log = values.quiet ? () => {} : (message) => io.log(message);
  const shared = {
    format: values.format,
    sessionKey: values.cookie || process.env.CLAUDE_SESSION_KEY,
    keep: values.keep,
    titleFilter: values.title,
    markdownFallback: values['markdown-fallback']
  };

  try {
    if (values.list || values.stdout) {
      const { recipes, stats, origin } = await collectRecipes(source, shared);
      if (!recipes.length) {
        io.error(noRecipesMessage(origin, stats));
        return 1;
      }
      if (values.stdout) {
        io.log(renderCard(recipes[0], { sourceLabel: origin }));
        return 0;
      }
      log(`Found ${recipes.length} recipe card${recipes.length === 1 ? '' : 's'} in ${origin}:`);
      recipes.forEach((recipe, index) => log(`  ${index + 1}. ${describe(recipe)}`));
      log(summary(stats));
      return 0;
    }

    const result = await exportRecipes(source, {
      ...shared,
      outDir: values.out,
      pdf: values.pdf,
      index: values.index,
      json: values.json
    });

    if (!result.recipes.length) {
      io.error(noRecipesMessage(result.origin, result.stats));
      return 1;
    }

    log(`Exported ${result.recipes.length} recipe card${result.recipes.length === 1 ? '' : 's'} to ${result.outDir}`);
    for (const recipe of result.recipes) log(`  • ${describe(recipe)}`);
    for (const file of result.files) {
      if (file.type === 'index') log(`  ↳ index: ${path.relative(process.cwd(), file.path)}`);
      if (file.type === 'json') log(`  ↳ data:  ${path.relative(process.cwd(), file.path)}`);
      if (file.type === 'pdf') log(`  ↳ pdf:   ${path.relative(process.cwd(), file.path)} [${file.backend}]`);
    }
    log(summary(result.stats));
    return 0;
  } catch (error) {
    io.error(`Export failed: ${error.message}`);
    return 1;
  }
}

function summary(stats) {
  const bits = [`${stats.structured || 0} structured`, `${stats.markdown || 0} from markdown`];
  if (stats.duplicates) bits.push(`${stats.duplicates} duplicate${stats.duplicates === 1 ? '' : 's'} skipped`);
  if (stats.superseded) bits.push(`${stats.superseded} superseded`);
  if (stats.filtered) bits.push(`${stats.filtered} filtered out`);
  return `  (${bits.join(', ')})`;
}

function noRecipesMessage(origin, stats) {
  return [
    `No recipe cards found in ${origin}.`,
    `Scanned ${stats.blobs || 0} message${stats.blobs === 1 ? '' : 's'}.`,
    'Cards are recognised as ```recipe-card JSON fences, <recipe-card> blocks,',
    'inline JSON with "ingredients"/"steps", or Markdown recipes with an',
    'Ingredients and an Instructions heading.'
  ].join('\n');
}
