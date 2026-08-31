/**
 * End-to-end checks in a real browser. Playwright is not a dependency of this
 * project, so these tests skip themselves when it is not installed:
 *   npm i -D playwright && npx playwright install chromium
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { exportRecipes } from '../src/export.js';

const run = promisify(execFile);
const EXAMPLE = new URL('../examples/claude-conversation.json', import.meta.url).pathname;

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch { /* not a local dependency */ }
  try {
    const { stdout } = await run('npm', ['root', '-g']);
    const entry = path.join(stdout.trim(), 'playwright', 'index.mjs');
    return await import(pathToFileURL(entry).href);
  } catch { /* not installed globally either */ }
  return null;
}

test('an exported card works offline in a real browser', async (t) => {
  const playwright = await loadPlaywright();
  if (!playwright) return t.skip('playwright is not installed');

  const outDir = await mkdtemp(path.join(tmpdir(), 'ninja-recipes-browser-'));
  const { recipes } = await exportRecipes(EXAMPLE, { outDir, titleFilter: 'Creami' });
  assert.equal(recipes.length, 1);
  const url = pathToFileURL(path.join(outDir, `${recipes[0].slug}.html`)).href;

  let browser;
  try {
    browser = await playwright.chromium.launch({ args: ['--no-sandbox'] });
  } catch (error) {
    // Playwright is present but its browsers are not downloaded (common on CI).
    return t.skip(`chromium is not available: ${error.message.split('\n')[0]}`);
  }
  try {
    const page = await browser.newPage();
    const errors = [];
    const externalRequests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', (request) => {
      if (!request.url().startsWith('file://')) externalRequests.push(request.url());
    });
    await page.goto(url);

    const amounts = () => page.$$eval('.amount', (els) => els.map((el) => el.textContent.trim()));
    assert.deepEqual(await amounts(), ['1 cup', '1½ cups', '½ cup', '2 tsp', '2 tbsp', 'a pinch']);

    await t.test('the servings slider scales every amount', async () => {
      await page.fill('#servings-range', '8');
      await page.dispatchEvent('#servings-range', 'input');
      assert.deepEqual(await amounts(), ['2 cups', '3 cups', '1 cup', '4 tsp', '4 tbsp', 'a pinch']);
      assert.match(await page.textContent('#scale-note'), /scaled 2× from 4/);

      await page.click('#servings-minus');
      assert.equal(await page.textContent('#servings-value'), '7');
    });

    await t.test('checking steps advances the progress bar', async () => {
      await page.check('#step-1-check');
      await page.check('#step-2-check');
      assert.equal(await page.textContent('#progress-label'), '2 of 5 steps done');
      assert.equal(await page.$eval('#progress-bar', (el) => el.style.width), '40%');
    });

    await t.test('state survives a reload', async () => {
      await page.reload();
      assert.equal(await page.textContent('#servings-value'), '7');
      assert.equal(await page.isChecked('#step-1-check'), true);
    });

    await t.test('timers count down, pause and finish', async () => {
      const timer = page.locator('.timer').first();
      assert.match(await timer.textContent(), /2:00/);
      await timer.click();
      await page.waitForTimeout(1300);
      assert.match(await timer.getAttribute('class'), /running/);
      assert.match(await timer.textContent(), /1:5[0-9]/);
      await timer.click();
      assert.match(await timer.getAttribute('class'), /paused/);

      // A timer picks up its length on first use, so shorten a fresh one to
      // reach the finished state without waiting three minutes.
      const quick = page.locator('.timer').nth(2);
      await quick.evaluate((el) => el.setAttribute('data-seconds', '1'));
      await quick.click();
      await page.waitForTimeout(1600);
      assert.match(await quick.getAttribute('class'), /done/);
      assert.match(await quick.textContent(), /0:00/);
      assert.match(await page.textContent('#timer-live'), /Timer finished for step 3/);
    });

    await t.test('the theme toggle cycles auto, light and dark', async () => {
      await page.click('#theme-toggle');
      assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
      await page.click('#theme-toggle');
      assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
      await page.click('#theme-toggle');
      assert.equal(await page.getAttribute('html', 'data-theme'), null);
    });

    await t.test('reset restores servings, checkboxes and timers', async () => {
      await page.click('#reset-button');
      assert.equal(await page.textContent('#servings-value'), '4');
      assert.equal(await page.textContent('#progress-label'), '0 of 5 steps done');
      assert.equal(await page.isChecked('#step-1-check'), false);
    });

    await t.test('the theme follows you from the index onto a card', async () => {
      // The point of sharing the key: picking dark on the index and opening a
      // recipe must not throw you back into light. Before this was shared, the
      // cards kept theme per recipe and the index had no toggle at all.
      const indexUrl = pathToFileURL(path.join(outDir, 'index.html')).href;
      const other = await browser.newPage();
      await other.goto(indexUrl);

      assert.equal(await other.getAttribute('html', 'data-theme'), null, 'starts on auto');
      await other.click('#theme-toggle');
      assert.equal(await other.getAttribute('html', 'data-theme'), 'light');
      await other.click('#theme-toggle');
      assert.equal(await other.getAttribute('html', 'data-theme'), 'dark',
        'the index cycles in the same order as a card');

      await other.goto(url);
      assert.equal(await other.getAttribute('html', 'data-theme'), 'dark',
        'the card opens in the theme chosen on the index');
      assert.equal(await other.textContent('#theme-toggle'), '☾',
        'and its button shows that theme');

      await other.goto(indexUrl);
      assert.equal(await other.getAttribute('html', 'data-theme'), 'dark', 'and back again');
      await other.close();
    });

    await t.test('print hides the controls and nothing loads from the network', async () => {
      await page.emulateMedia({ media: 'print' });
      assert.equal(await page.locator('.toolbar-actions').isVisible(), false);
      assert.equal(await page.locator('.ingredients-section').isVisible(), true);
      await page.emulateMedia({ media: 'screen' });
      assert.deepEqual(externalRequests, []);
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser.close();
  }
});
