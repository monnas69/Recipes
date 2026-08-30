import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  emptyPlan, normalizePlan, isEmptyPlan, planAssignments, missingSlugs,
  readPlan, readAllPlans, writePlan, planPath
} from '../planner/plan-store.js';
import { normalizeRecipe } from '../src/normalize.js';

const tmp = () => mkdtemp(path.join(tmpdir(), 'meal-planner-test-'));

const RECIPES = new Map([
  ['soup', normalizeRecipe({
    title: 'Soup', base_servings: 2,
    ingredients: [{ name: 'stock', amount: 1, unit: 'l' }], steps: ['Simmer.']
  }, {})],
  ['toast', normalizeRecipe({
    title: 'Toast', base_servings: 1,
    ingredients: [{ name: 'bread', amount: 2, unit: 'slices' }], steps: ['Toast.']
  }, {})]
]);

test('an empty plan holds every day of its week', () => {
  const plan = emptyPlan('2026-W36');
  assert.equal(plan.week, '2026-W36');
  assert.equal(plan.revision, 0);
  assert.deepEqual(Object.keys(plan.days), [
    '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03',
    '2026-09-04', '2026-09-05', '2026-09-06'
  ]);
  assert.equal(isEmptyPlan(plan), true);
});

test('normalises whatever shape a hand-edited or downloaded file arrives in', () => {
  const plan = normalizePlan({
    week: '2026-W36',
    revision: '4',
    updated_by: '  Karen  ',
    days: {
      '2026-08-31': ['soup', { slug: 'toast', servings: '3', note: 'quick' }],
      '2026-09-01': [{ recipe: 'soup' }, { slug: '' }, null, 42],
      '2025-01-01': [{ slug: 'soup' }]
    }
  }, '2026-W36');

  assert.deepEqual(plan.days['2026-08-31'], [
    { slug: 'soup', servings: null, note: '' },
    { slug: 'toast', servings: 3, note: 'quick' }
  ], 'bare strings and string servings are coerced');
  assert.deepEqual(plan.days['2026-09-01'], [{ slug: 'soup', servings: null, note: '' }],
    'entries without a slug are dropped');
  assert.equal(plan.days['2025-01-01'], undefined, 'dates outside the week are dropped');
  assert.equal(plan.revision, 4);
  assert.equal(plan.updated_by, 'Karen');
});

test('rejects a plan with no usable week', () => {
  assert.equal(normalizePlan({ days: {} }, 'not-a-week'), null);
  assert.equal(normalizePlan(null, '2025-W53'), null, 'a 52-week year has no week 53');
  assert.equal(normalizePlan({ week: '2026-W36' }, undefined).week, '2026-W36',
    'the file may name its own week');
});

test('flattens a plan into assignments in day order', () => {
  const plan = normalizePlan({
    week: '2026-W36',
    days: {
      '2026-09-02': [{ slug: 'toast' }],
      '2026-08-31': [{ slug: 'soup', servings: 6 }]
    }
  }, '2026-W36');

  const assignments = planAssignments(plan, RECIPES);
  assert.deepEqual(assignments.map((a) => [a.date, a.recipe.title, a.servings]), [
    ['2026-08-31', 'Soup', 6],
    ['2026-09-02', 'Toast', 1]
  ], 'Monday first, and servings fall back to the recipe base');
});

test('reports planned recipes that no longer exist', () => {
  const plan = normalizePlan({
    week: '2026-W36',
    days: { '2026-08-31': [{ slug: 'soup' }, { slug: 'gone' }, { slug: 'gone' }] }
  }, '2026-W36');
  assert.deepEqual(missingSlugs(plan, RECIPES), ['gone']);
  assert.deepEqual(planAssignments(plan, RECIPES).map((a) => a.recipe.title), ['Soup'],
    'a missing recipe is skipped rather than crashing the list');
});

test('a missing plan file reads as an empty week, not an error', async () => {
  const dir = await tmp();
  const plan = await readPlan(dir, '2026-W36');
  assert.equal(isEmptyPlan(plan), true);
  assert.equal(plan.week, '2026-W36');
  assert.equal(await readPlan(dir, 'nope'), null);
});

test('writes, bumps the revision and reads back', async () => {
  const dir = await tmp();
  const draft = normalizePlan({
    week: '2026-W36', days: { '2026-08-31': [{ slug: 'soup' }] }
  }, '2026-W36');

  const first = await writePlan(dir, draft, { updatedBy: 'shayne' });
  assert.equal(first.plan.revision, 1);
  assert.equal(first.plan.updated_by, 'shayne');
  assert.equal(first.file, planPath(dir, '2026-W36'));
  assert.ok(first.plan.updated_at, 'a saved plan is timestamped');

  const second = await writePlan(dir, draft);
  assert.equal(second.plan.revision, 2, 'each save supersedes the last');

  const readBack = await readPlan(dir, '2026-W36');
  assert.equal(readBack.revision, 2);
  assert.deepEqual(readBack.days['2026-08-31'], [{ slug: 'soup', servings: null, note: '' }]);

  const raw = await readFile(first.file, 'utf8');
  assert.ok(raw.endsWith('\n'), 'files end with a newline so git is happy');
  assert.deepEqual(Object.keys(JSON.parse(raw)), ['week', 'revision', 'updated_at', 'updated_by', 'days']);
});

test('refuses to write a plan without a valid week', async () => {
  const dir = await tmp();
  await assert.rejects(() => writePlan(dir, { week: 'whenever', days: {} }), /valid week id/);
});

test('scans a folder of plans and skips what is not one', async () => {
  const dir = await tmp();
  await writePlan(dir, emptyPlan('2026-W36'));
  await writePlan(dir, normalizePlan({
    week: '2026-W35', days: { '2026-08-24': [{ slug: 'toast' }] }
  }, '2026-W35'));
  await writeFile(path.join(dir, 'notes.txt'), 'ignore me', 'utf8');
  await writeFile(path.join(dir, 'broken.json'), '{ not json', 'utf8');
  await writeFile(path.join(dir, '2026-W99.json'), '{"week":"2026-W99"}', 'utf8');

  const plans = await readAllPlans(dir);
  assert.deepEqual(plans.map((p) => p.week), ['2026-W35', '2026-W36'], 'oldest week first');
  assert.deepEqual(await readAllPlans(path.join(dir, 'missing')), [], 'a missing folder is empty');
});

test('a corrupt plan file for a specific week is reported, not swallowed', async () => {
  const dir = await tmp();
  await writeFile(planPath(dir, '2026-W36'), '{ oops', 'utf8');
  await assert.rejects(() => readPlan(dir, '2026-W36'), /not valid JSON/);
});
