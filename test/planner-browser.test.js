/**
 * End-to-end checks of the planner page in a real browser. Like
 * test/browser.test.js these skip themselves when Playwright is not installed:
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

import { buildPlanner } from '../planner/build.js';
import { writePlan, normalizePlan } from '../planner/plan-store.js';

const run = promisify(execFile);
const WEEK = '2026-W36';
const MONDAY = '2026-08-31';

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

test('the planner plans a week and builds a shopping list in a real browser', async (t) => {
  const playwright = await loadPlaywright();
  if (!playwright) return t.skip('playwright is not installed');

  const outDir = await mkdtemp(path.join(tmpdir(), 'meal-planner-browser-'));
  const plansDir = await mkdtemp(path.join(tmpdir(), 'meal-planner-browser-plans-'));
  await writePlan(plansDir, normalizePlan({
    week: WEEK,
    days: {
      [MONDAY]: [{ slug: 'lemon-garlic-butter-shrimp', servings: 4 }],
      '2026-09-06': [{ text: 'Leftovers' }]
    }
  }, WEEK), { updatedBy: 'shayne' });

  const { file } = await buildPlanner({ outDir, plansDir, week: WEEK });
  const url = pathToFileURL(file).href;

  let browser;
  try {
    browser = await playwright.chromium.launch({ args: ['--no-sandbox'] });
  } catch (error) {
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
    // Nothing here should ever prompt; a stray confirm() would hang the run.
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(url);

    // Just the quantity and the name — not the "which recipes" footnote.
    const shoppingLines = () => page.$$eval('.shopping-item label', (els) => els.map((el) => {
      const clone = el.cloneNode(true);
      for (const extra of clone.querySelectorAll('.from, .split-flag')) extra.remove();
      return clone.textContent.replace(/\s+/g, ' ').trim();
    }));

    await t.test('opens on the committed plan', async () => {
      assert.equal(await page.textContent('#week-name'), WEEK);
      assert.equal(await page.textContent('#week-range'), '31 Aug – 6 Sep 2026');
      assert.equal(await page.locator('.day').count(), 7);
      assert.match(await page.textContent('#save-text'), /Saved — revision 1.*by shayne/);
      assert.match(await page.textContent(`.day[data-date="${MONDAY}"]`), /Lemon Garlic Butter Shrimp/);
      assert.match(await page.textContent(`.day[data-date="${MONDAY}"]`), /4 servings/);
      assert.equal(await page.locator('.day[data-date="2026-09-06"] .freeform-input').inputValue(),
        'Leftovers', 'a committed meal with no recipe is part of the week');
    });

    await t.test('the shopping list reflects the planned servings', async () => {
      const lines = await shoppingLines();
      // 450 g at 2 servings, planned for 4.
      assert.ok(lines.some((line) => line.startsWith('900 g large shrimp')), lines.join(' | '));
      assert.ok(lines.some((line) => /to taste salt and pepper/.test(line)), 'unmeasured items survive');
      assert.match(await page.textContent('#shopping-count'), /from 1 meal/);
    });

    await t.test('clicking a recipe assigns it and updates the list', async () => {
      await page.click(`.day[data-date="2026-09-02"] [data-add]`);
      await page.click('.recipe-option[data-slug="pad-see-ew-thai-stir-fried-noodles"]');
      assert.match(await page.textContent('.day[data-date="2026-09-02"]'), /Pad See Ew/);
      assert.match(await page.textContent('#shopping-count'), /from 2 meals/);
      assert.match(await page.textContent('#save-text'), /Unsaved changes/);

      // Garlic is in both recipes, so the two lines must have become one.
      const garlic = (await shoppingLines()).filter((line) => /garlic$/.test(line));
      assert.equal(garlic.length, 1, 'garlic is one line, not two');
      assert.equal(garlic[0], '10 cloves garlic');
    });

    await t.test('changing servings rescales that recipe only', async () => {
      await page.fill(`.day[data-date="${MONDAY}"] .servings-input`, '2');
      await page.dispatchEvent(`.day[data-date="${MONDAY}"] .servings-input`, 'change');
      const lines = await shoppingLines();
      assert.ok(lines.some((line) => line.startsWith('450 g large shrimp')), lines.join(' | '));
      // Pad See Ew is still at its own base servings.
      assert.ok(lines.some((line) => line === '200 g dried wide rice stick noodles'),
        'the other recipe is untouched');
    });

    await t.test('the filter narrows the recipe list', async () => {
      await page.fill('#recipe-search', 'jerky');
      const visible = await page.$$eval('#recipe-list li', (els) =>
        els.filter((el) => !el.hidden).map((el) => el.textContent));
      assert.ok(visible.length >= 1);
      assert.ok(visible.every((text) => /jerky/i.test(text)));
      await page.fill('#recipe-search', '');
    });

    await t.test('ticking an item survives a reload, and so does the draft', async () => {
      await page.locator('.shopping-item input[type="checkbox"]').first().check();
      await page.reload();
      assert.equal(await page.locator('.shopping-item input[type="checkbox"]').first().isChecked(), true);
      assert.match(await page.textContent('.day[data-date="2026-09-02"]'), /Pad See Ew/,
        'the unsaved draft is still there');
      assert.match(await page.textContent('#save-text'), /Unsaved changes/);
    });

    await t.test('removing an assignment empties the day', async () => {
      await page.click('.day[data-date="2026-09-02"] [data-remove]');
      assert.match(await page.textContent('.day[data-date="2026-09-02"]'), /Nothing planned/);
    });

    await t.test('discarding restores the committed plan', async () => {
      await page.click('#discard-button');
      assert.match(await page.textContent('#save-text'), /Saved — revision 1/);
      assert.match(await page.textContent(`.day[data-date="${MONDAY}"]`), /4 servings/,
        'the committed servings are back');
    });

    await t.test('week navigation moves and comes back', async () => {
      await page.click('#next-week');
      assert.equal(await page.textContent('#week-name'), '2026-W37');
      assert.match(await page.textContent('#save-text'), /No plan committed/);
      assert.equal(await page.locator('.shopping-item').count(), 0);

      await page.click('#prev-week');
      assert.equal(await page.textContent('#week-name'), WEEK);
      assert.match(await page.textContent(`.day[data-date="${MONDAY}"]`), /Lemon Garlic Butter Shrimp/);
    });

    await t.test('a meal that is just a name goes on the day, not the shopping list', async () => {
      const before = await page.locator('.shopping-item').count();

      await page.click('.day[data-date="2026-09-03"] [data-add]');
      await page.fill('#recipe-search', 'Bangers and mash');
      assert.match(await page.textContent('#freeform-add'), /Add “Bangers and mash” to Thu 3 Sep/);
      await page.press('#recipe-search', 'Enter');

      assert.equal(await page.locator('.day[data-date="2026-09-03"] .freeform-input').inputValue(),
        'Bangers and mash');
      assert.equal(await page.inputValue('#recipe-search'), '', 'the box clears for the next thing');
      assert.equal(await page.locator('.shopping-item').count(), before,
        'a meal with no recipe adds nothing to buy');
      assert.match(await page.textContent('#shopping-freeform'), /Bangers and mash/);
      assert.match(await page.textContent('#shopping-count'), /2 without recipes/);
      assert.match(await page.textContent('#save-text'), /Unsaved changes/);
    });

    await t.test('renaming a free-text meal registers as an edit', async () => {
      // The regression this guards: every free-text meal on a day looks alike
      // unless the text itself is in daysSignature, so a rename would read as
      // "no change", clear the draft, and come back as the old name.
      const sunday = page.locator('.day[data-date="2026-09-06"] .freeform-input');
      await sunday.fill('Fish and chips');
      await sunday.dispatchEvent('change');
      assert.match(await page.textContent('#save-text'), /Unsaved changes/);

      await page.reload();
      assert.equal(await page.locator('.day[data-date="2026-09-06"] .freeform-input').inputValue(),
        'Fish and chips', 'the draft kept the new name');
    });

    await t.test('clearing the name removes the meal', async () => {
      const thursday = page.locator('.day[data-date="2026-09-03"] .freeform-input');
      await thursday.fill('   ');
      await thursday.dispatchEvent('change');
      assert.match(await page.textContent('.day[data-date="2026-09-03"]'), /Nothing planned/);
    });

    await t.test('the downloaded plan is the JSON the CLI expects', async () => {
      await page.fill('#author', 'karen');
      await page.click(`.day[data-date="2026-09-04"] [data-add]`);
      await page.click('.recipe-option[data-slug="ninja-ol650-chicken-wings"]');

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.click('#download-button')
      ]);
      assert.equal(download.suggestedFilename(), `${WEEK}.json`);

      const stream = await download.createReadStream();
      let text = '';
      for await (const chunk of stream) text += chunk;
      const plan = JSON.parse(text);
      assert.equal(plan.week, WEEK);
      assert.equal(plan.revision, 2, 'the download supersedes the committed revision');
      assert.equal(plan.updated_by, 'karen');
      assert.equal(plan.days['2026-09-04'][0].slug, 'ninja-ol650-chicken-wings');
      assert.deepEqual(plan.days['2026-09-06'], [{ text: 'Fish and chips', note: '' }],
        'free-text meals travel in the file the CLI imports');
    });

    await t.test('warns when the other cook published while this draft was open', async () => {
      // A draft based on revision 0, against a committed revision 1: exactly
      // what Karen sees if Shayne commits while her page holds unsaved edits.
      const seedStaleDraft = () => page.evaluate((week) => {
        window.localStorage.setItem('meal-planner:draft:' + week, JSON.stringify({
          plan: {
            week,
            revision: 0,
            days: { '2026-09-05': [{ slug: 'pad-see-ew-thai-stir-fried-noodles', servings: null, note: '' }] }
          },
          base_revision: 0,
          saved_at: new Date().toISOString()
        }));
      }, WEEK);

      await seedStaleDraft();
      await page.reload();
      assert.equal(await page.locator('#conflict-banner').isVisible(), true);
      assert.match(await page.textContent('.day[data-date="2026-09-05"]'), /Pad See Ew/);

      await page.click('#keep-mine');
      assert.equal(await page.locator('#conflict-banner').isVisible(), false, 'the choice sticks');
      assert.match(await page.textContent('.day[data-date="2026-09-05"]'), /Pad See Ew/);
      assert.match(await page.textContent('#save-text'), /Unsaved changes/);

      await seedStaleDraft();
      await page.reload();
      await page.click('#take-published');
      assert.equal(await page.locator('#conflict-banner').isVisible(), false);
      assert.match(await page.textContent('#save-text'), /Saved — revision 1/);
      assert.match(await page.textContent('.day[data-date="2026-09-05"]'), /Nothing planned/);
      assert.match(await page.textContent(`.day[data-date="${MONDAY}"]`), /Lemon Garlic Butter Shrimp/);
    });

    await t.test('print hides the controls but keeps the plan and the list', async () => {
      await page.emulateMedia({ media: 'print' });
      assert.equal(await page.locator('.week-bar').isVisible(), false);
      assert.equal(await page.locator('#days').isVisible(), true);
      assert.equal(await page.locator('#shopping-list').isVisible(), true);
      await page.emulateMedia({ media: 'screen' });
    });

    await t.test('nothing loaded from the network and nothing threw', async () => {
      assert.deepEqual(externalRequests, []);
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser.close();
  }
});
