/**
 * Live sync: the planner page talking to the meal-plan endpoint.
 *
 * Nothing here touches the real server. The unit tests stub `fetch`, and the
 * browser test stubs the endpoint with an in-memory store shared by two pages —
 * which is the whole point of the feature, so it is worth testing as two cooks
 * rather than as one page and a mock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { syncEnabled, pullPlan, pushPlan } from '../planner/shared/sync.js';
import { buildPlanner, loadSyncConfig } from '../planner/build.js';

const run = promisify(execFile);
const CONFIG = { endpoint: 'https://sync.test/meal-plan' };
const WEEK = '2026-W36';
const MONDAY = '2026-08-31';

const tmp = (prefix) => mkdtemp(path.join(tmpdir(), prefix));

/** Swap in a fake fetch for one call, then put the real one back. */
async function withFetch(impl, body) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

const jsonResponse = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload
});

/* ---------------- the sync module ---------------- */

test('sync is off unless a build has an endpoint', () => {
  assert.equal(syncEnabled(null), false);
  assert.equal(syncEnabled({}), false);
  assert.equal(syncEnabled({ endpoint: '' }), false);
  assert.equal(syncEnabled(CONFIG), true);
});

test('nothing is attempted when sync is off', async () => {
  const never = () => { throw new Error('should not have called the network'); };
  await withFetch(never, async () => {
    assert.deepEqual(await pullPlan(null, WEEK), { ok: false, offline: true });
    assert.deepEqual(await pushPlan(null, WEEK, {}, 0, 'shayne'), { ok: false, offline: true });
  });
});

test('pulls a week, and reports a week nobody has saved as null', async () => {
  const stored = { week: WEEK, days: {}, revision: 3, updated_by: 'karen' };
  await withFetch(async (url) => {
    assert.match(String(url), /\?week=2026-W36$/);
    return jsonResponse(200, { plan: stored });
  }, async () => {
    assert.deepEqual(await pullPlan(CONFIG, WEEK), { ok: true, plan: stored });
  });

  await withFetch(async () => jsonResponse(200, { plan: null }), async () => {
    assert.deepEqual(await pullPlan(CONFIG, WEEK), { ok: true, plan: null });
  });
});

test('a push sends the revision it edited, so the server can refuse it', async () => {
  let sent = null;
  await withFetch(async (url, options) => {
    sent = JSON.parse(options.body);
    return jsonResponse(200, { plan: { week: WEEK, days: {}, revision: 8 } });
  }, async () => {
    const result = await pushPlan(CONFIG, WEEK, { [MONDAY]: [{ text: 'Chook' }] }, 7, 'shayne');
    assert.equal(result.ok, true);
    assert.equal(result.plan.revision, 8);
  });

  assert.equal(sent.week, WEEK);
  assert.equal(sent.base_revision, 7);
  assert.equal(sent.updated_by, 'shayne');
  assert.deepEqual(sent.days[MONDAY], [{ text: 'Chook' }]);
});

test('a stale push comes back with the copy that beat it, never as a success', async () => {
  const theirs = { week: WEEK, days: {}, revision: 9, updated_by: 'karen' };
  await withFetch(async () => jsonResponse(409, { error: 'stale', plan: theirs }), async () => {
    const result = await pushPlan(CONFIG, WEEK, {}, 4, 'shayne');
    assert.equal(result.ok, false);
    assert.equal(result.stale, true);
    assert.deepEqual(result.plan, theirs, 'the page needs their copy to offer a choice');
  });
});

test('a network failure is offline, not an error the cook has to handle', async () => {
  await withFetch(async () => { throw new Error('ECONNREFUSED'); }, async () => {
    assert.deepEqual(await pullPlan(CONFIG, WEEK), { ok: false, offline: true });
    assert.deepEqual(await pushPlan(CONFIG, WEEK, {}, 0, ''), { ok: false, offline: true });
  });

  // A 500, or an HTML error page where JSON was expected, is the same thing.
  await withFetch(async () => jsonResponse(500, null), async () => {
    assert.deepEqual(await pullPlan(CONFIG, WEEK), { ok: false, offline: true });
  });
});

/* ---------------- build wiring ---------------- */

test('the endpoint reaches the page, and no key ever does', async () => {
  const outDir = await tmp('planner-sync-build-');
  const plansDir = await tmp('planner-sync-plans-');
  const { file } = await buildPlanner({ outDir, plansDir, week: WEEK, sync: CONFIG });
  const html = await readFile(file, 'utf8');
  const payload = JSON.parse(html.split('id="planner-json">')[1].split('</script>')[0]);

  assert.deepEqual(payload.sync, CONFIG);
  assert.deepEqual(Object.keys(payload.sync), ['endpoint'],
    'an endpoint and nothing else — a key here would expose the whole project');
  assert.doesNotMatch(html, /eyJhbGciOi|sb_publishable_|service_role|SUPABASE_/,
    'no API key of any shape in the built page');
});

test('a missing or malformed sync config just turns sync off', async () => {
  const dir = await tmp('planner-sync-config-');
  assert.equal(await loadSyncConfig(path.join(dir, 'nope.json')), null);

  const empty = path.join(dir, 'empty.json');
  await writeFile(empty, '{}', 'utf8');
  assert.equal(await loadSyncConfig(empty), null);

  const broken = path.join(dir, 'broken.json');
  await writeFile(broken, '{ not json', 'utf8');
  assert.equal(await loadSyncConfig(broken), null, 'a broken config must not break the build');

  const good = path.join(dir, 'good.json');
  await writeFile(good, JSON.stringify({ endpoint: ' https://sync.test/x ', extra: 'ignored' }), 'utf8');
  assert.deepEqual(await loadSyncConfig(good), { endpoint: 'https://sync.test/x' });
});

/* ---------------- two cooks, one plan ---------------- */

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch { /* not a local dependency */ }
  try {
    const { stdout } = await run('npm', ['root', '-g']);
    return await import(pathToFileURL(path.join(stdout.trim(), 'playwright', 'index.mjs')).href);
  } catch { /* not installed globally either */ }
  return null;
}

test('Karen opens the link, edits, and it lands on Shayne\'s planner', async (t) => {
  const playwright = await loadPlaywright();
  if (!playwright) return t.skip('playwright is not installed');

  const outDir = await tmp('planner-sync-browser-');
  const plansDir = await tmp('planner-sync-browser-plans-');
  const { file } = await buildPlanner({ outDir, plansDir, week: WEEK, sync: CONFIG });
  const url = pathToFileURL(file).href;

  // The server, in memory: one row, and the same compare-and-set the real
  // Edge Function does.
  const store = new Map();
  const requests = [];

  const serve = async (route, request) => {
    requests.push(request.method());
    if (request.method() === 'GET') {
      const week = new URL(request.url()).searchParams.get('week');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ plan: store.get(week) || null })
      });
    }
    const body = JSON.parse(request.postData() || '{}');
    const existing = store.get(body.week);
    if (existing && existing.revision !== body.base_revision) {
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'stale', plan: existing })
      });
    }
    const saved = {
      week: body.week,
      days: body.days,
      revision: (body.base_revision || 0) + 1,
      updated_at: new Date().toISOString(),
      updated_by: body.updated_by || ''
    };
    store.set(body.week, saved);
    return route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ plan: saved })
    });
  };

  let browser;
  try {
    browser = await playwright.chromium.launch({ args: ['--no-sandbox'] });
  } catch (error) {
    return t.skip(`chromium is not available: ${error.message.split('\n')[0]}`);
  }

  try {
    // Separate contexts: two devices, two localStorages, one server.
    const karenContext = await browser.newContext();
    const shayneContext = await browser.newContext();
    const karen = await karenContext.newPage();
    const shayne = await shayneContext.newPage();
    const errors = [];
    for (const page of [karen, shayne]) {
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (m) => {
        // Two subtests below cut the network and force a 409 on purpose; the
        // browser logs those as resource failures. Real page errors still count.
        if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
      });
      await page.route('**/meal-plan*', serve);
      await page.goto(url);
    }

    const settled = (page, text) => page.waitForFunction(
      (expected) => document.getElementById('save-text').textContent.includes(expected),
      text, { timeout: 5000 }
    );

    await t.test('Karen edits with nothing installed and no account', async () => {
      await karen.click(`.day[data-date="${MONDAY}"] [data-add]`);
      await karen.fill('#recipe-search', 'Chook');
      await karen.press('#recipe-search', 'Enter');

      await settled(karen, 'Saved for both of you');
      assert.equal(store.get(WEEK).revision, 1);
      assert.deepEqual(store.get(WEEK).days[MONDAY], [{ text: 'Chook', note: '' }]);
    });

    await t.test('it shows up on Shayne\'s planner', async () => {
      assert.match(await shayne.textContent(`.day[data-date="${MONDAY}"]`), /Nothing planned/,
        'his page has not looked since she saved');

      await shayne.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await shayne.waitForFunction(
        (date) => document.querySelector(`.day[data-date="${date}"] .freeform-input`) !== null,
        MONDAY, { timeout: 5000 }
      );
      assert.equal(await shayne.locator(`.day[data-date="${MONDAY}"] .freeform-input`).inputValue(),
        'Chook', 'her meal arrived without him reloading');
    });

    await t.test('the second cook to save is told, not silently overwritten', async () => {
      // Shayne goes offline and edits, so his page still thinks it is on the
      // revision he last saw while Karen moves the server on.
      await shayne.unroute('**/meal-plan*');
      await shayne.route('**/meal-plan*', (route) => route.abort('failed'));
      await shayne.click('.day[data-date="2026-09-02"] [data-add]');
      await shayne.fill('#recipe-search', 'Pasta');
      await shayne.press('#recipe-search', 'Enter');
      await settled(shayne, 'back online');

      await karen.click('.day[data-date="2026-09-03"] [data-add]');
      await karen.fill('#recipe-search', 'Curry');
      await karen.press('#recipe-search', 'Enter');
      await settled(karen, 'Saved for both of you');
      assert.equal(store.get(WEEK).revision, 2);

      // Back online, his queued edit is refused rather than clobbering hers.
      await shayne.unroute('**/meal-plan*');
      await shayne.route('**/meal-plan*', serve);
      await shayne.evaluate(() => window.dispatchEvent(new Event('online')));

      await settled(shayne, 'Someone else saved');
      assert.equal(await shayne.locator('#conflict-banner').isVisible(), true);
      assert.equal(store.get(WEEK).revision, 2, 'her save still stands');

      await shayne.click('#keep-mine');
      await settled(shayne, 'Saved for both of you');
      assert.equal(store.get(WEEK).revision, 3, 'his copy wins only once he chooses it');
    });

    await t.test('nothing threw', async () => {
      assert.deepEqual(errors, []);
      assert.ok(requests.includes('GET') && requests.includes('POST'));
    });
  } finally {
    await browser.close();
  }
});
