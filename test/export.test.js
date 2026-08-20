import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { exportRecipes, collectRecipes } from '../src/export.js';
import { fetchConversation, detectFormat, htmlToText, looseJsonParse } from '../src/transcript.js';
import { main } from '../src/cli.js';

const EXAMPLE = new URL('../examples/claude-conversation.json', import.meta.url).pathname;
const MARKDOWN_EXAMPLE = new URL('../examples/transcript.md', import.meta.url).pathname;

const tmp = () => mkdtemp(path.join(tmpdir(), 'ninja-recipes-test-'));

function captureIo() {
  const out = [];
  const err = [];
  return { io: { log: (m) => out.push(String(m)), error: (m) => err.push(String(m)) }, out, err };
}

test('exports every card in the example conversation', async () => {
  const outDir = await tmp();
  const result = await exportRecipes(EXAMPLE, { outDir, json: true });

  assert.deepEqual(result.recipes.map((r) => r.title), [
    'Ninja Creami Vanilla Bean Ice Cream',
    'Ninja Foodi Crispy Chilli Chicken Thighs',
    'Smashed Cucumber Salad'
  ]);

  const files = (await readdir(outDir)).sort();
  assert.deepEqual(files, [
    'index.html',
    'ninja-creami-vanilla-bean-ice-cream.html',
    'ninja-foodi-crispy-chilli-chicken-thighs.html',
    'recipes.json',
    'smashed-cucumber-salad.html'
  ]);

  const card = await readFile(path.join(outDir, 'ninja-creami-vanilla-bean-ice-cream.html'), 'utf8');
  assert.ok(card.includes('Ninja Creami Vanilla Bean Ice Cream'));
  assert.ok(card.includes('href="index.html"'), 'batch exports link back to the index');

  const data = JSON.parse(await readFile(path.join(outDir, 'recipes.json'), 'utf8'));
  assert.equal(data.recipes.length, 3);
});

test('reads a Markdown transcript and skips the index for a single card', async () => {
  const outDir = await tmp();
  const result = await exportRecipes(MARKDOWN_EXAMPLE, { outDir });
  assert.equal(result.recipes.length, 1);
  assert.deepEqual(await readdir(outDir), ['spaghetti-with-anchovy-breadcrumbs.html']);
  const html = await readFile(path.join(outDir, 'spaghetti-with-anchovy-breadcrumbs.html'), 'utf8');
  assert.ok(!html.includes('href="index.html"'));
});

test('--title filters the export', async () => {
  const { recipes } = await collectRecipes(EXAMPLE, { titleFilter: 'cucumber' });
  assert.deepEqual(recipes.map((r) => r.title), ['Smashed Cucumber Salad']);
});

test('--no-markdown-fallback only keeps structured cards', async () => {
  const { recipes } = await collectRecipes(EXAMPLE, { markdownFallback: false });
  assert.equal(recipes.length, 2);
  assert.ok(recipes.every((r) => r.source.format !== 'markdown'));
});

test('detects input formats', () => {
  assert.equal(detectFormat('{"a":1}'), 'json');
  assert.equal(detectFormat('<!doctype html><html></html>'), 'html');
  assert.equal(detectFormat('# Recipe', { filename: 'chat.md' }), 'markdown');
  assert.equal(detectFormat('plain notes'), 'text');
  assert.equal(htmlToText('<p>1 &amp; 2</p><li>three</li>').replace(/\s+/g, ' ').trim(), '1 & 2 - three');
  assert.equal(looseJsonParse('{"a":1,}').a, 1, 'trailing commas are tolerated');
});

test('finds cards in a saved HTML page', async () => {
  const outDir = await tmp();
  const file = path.join(outDir, 'chat.html');
  await writeFile(file, `<!doctype html><html><body><div class="message"><p>Sure:</p>
<pre><code>{"title": "Saved Page Soup", "servings": 2,
"ingredients": [{"name": "stock", "amount": 2, "unit": "cups"}],
"steps": [{"title": "Heat", "content": "Heat it", "timer_seconds": 300}]}</code></pre></div></body></html>`);
  const { recipes } = await collectRecipes(file);
  assert.deepEqual(recipes.map((r) => r.title), ['Saved Page Soup']);
  assert.equal(recipes[0].steps[0].timer_seconds, 300);
});

test('fetchConversation explains what to do without a session cookie', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    text: async () => 'forbidden',
    headers: { get: () => 'text/html' }
  });
  await assert.rejects(
    () => fetchConversation('https://claude.ai/chat/1111aaaa-2222-bbbb-3333-cccc4444dddd', { fetchImpl }),
    /HTTP 403[\s\S]*--cookie/
  );
});

test('fetchConversation parses an authenticated JSON response', async () => {
  const conversation = {
    chat_messages: [{
      sender: 'assistant',
      text: '```recipe-card\n{"title":"Fetched Cake","servings":8,"ingredients":[{"name":"flour","amount":2,"unit":"cups"}],"steps":["Bake it"]}\n```'
    }]
  };
  const fetchImpl = async (url) => {
    assert.match(url, /api\/organizations\/current\/chat_conversations/);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(conversation),
      headers: { get: () => 'application/json' }
    };
  };
  const fetched = await fetchConversation('https://claude.ai/chat/1111aaaa-2222-bbbb-3333-cccc4444dddd', {
    fetchImpl,
    sessionKey: 'sk-test'
  });
  assert.equal(fetched.format, 'json');
  assert.ok(fetched.raw.includes('Fetched Cake'));
});

test('CLI lists cards without writing files', async () => {
  const { io, out } = captureIo();
  const code = await main([EXAMPLE, '--list'], io);
  assert.equal(code, 0);
  assert.match(out.join('\n'), /Found 3 recipe cards/);
  assert.match(out.join('\n'), /Smashed Cucumber Salad/);
});

test('CLI --stdout prints one card and writes nothing', async () => {
  const { io, out } = captureIo();
  const code = await main([EXAMPLE, '--stdout'], io);
  assert.equal(code, 0);
  assert.match(out[0], /^<!doctype html>/);
});

test('CLI exits 1 with guidance when nothing is found', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'chat.txt');
  await writeFile(file, 'We mostly talked about the weather.');
  const { io, err } = captureIo();
  assert.equal(await main([file], io), 1);
  assert.match(err.join('\n'), /No recipe cards found/);
});

test('CLI rejects bad flags', async () => {
  const { io, err } = captureIo();
  assert.equal(await main([EXAMPLE, '--keep', 'sideways'], io), 2);
  assert.match(err.join('\n'), /--keep must be/);
  assert.equal(await main([], captureIo().io), 2);
});

test('CLI writes cards to --out', async () => {
  const outDir = await tmp();
  const { io } = captureIo();
  assert.equal(await main([EXAMPLE, '-o', outDir, '--title', 'Creami', '-q'], io), 0);
  assert.deepEqual(await readdir(outDir), ['ninja-creami-vanilla-bean-ice-cream.html']);
});
