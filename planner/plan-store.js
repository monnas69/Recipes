/**
 * Plan storage: one JSON file per ISO week under planner/data/plans/.
 *
 * One file per week rather than a single rolling document, because the plans
 * are shared through git: separate files mean Shayne editing next week and
 * Karen editing this week never touch the same lines, and the folder doubles as
 * the history ("what did we eat two weeks ago" is just an older file).
 *
 * Files are hand-editable and arrive from the browser's download button, so
 * everything read back through here is re-validated rather than trusted.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isWeekId, weekDates } from './shared/week.js';

export const DEFAULT_PLANS_DIR = 'planner/data/plans';

/** Cap per day: a guard against a malformed file, not a product decision. */
const MAX_ENTRIES_PER_DAY = 12;

/** An empty plan for a week. */
export function emptyPlan(weekId) {
  const days = {};
  for (const date of weekDates(weekId)) days[date] = [];
  return {
    week: weekId,
    revision: 0,
    updated_at: null,
    updated_by: '',
    days
  };
}

function coerceEntry(raw) {
  if (typeof raw === 'string') {
    const slug = raw.trim();
    return slug ? { slug, servings: null, note: '' } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const slug = String(raw.slug ?? raw.recipe ?? raw.id ?? '').trim();
  if (!slug) return null;
  const servings = Number(raw.servings);
  return {
    slug,
    servings: Number.isFinite(servings) && servings > 0 ? Math.round(servings) : null,
    note: String(raw.note ?? '').trim().slice(0, 200)
  };
}

/**
 * Validate and normalise a plan object read from disk or posted by the page.
 * Days outside `weekId` are dropped; every day of the week is always present.
 */
export function normalizePlan(raw, weekId) {
  const week = isWeekId(raw?.week) ? raw.week : weekId;
  if (!isWeekId(week)) return null;

  const plan = emptyPlan(week);
  const source = raw && typeof raw.days === 'object' && raw.days ? raw.days : {};

  for (const date of weekDates(week)) {
    const entries = Array.isArray(source[date]) ? source[date] : [];
    plan.days[date] = entries
      .map(coerceEntry)
      .filter(Boolean)
      .slice(0, MAX_ENTRIES_PER_DAY);
  }

  const revision = Number(raw?.revision);
  plan.revision = Number.isFinite(revision) && revision >= 0 ? Math.floor(revision) : 0;
  plan.updated_at = typeof raw?.updated_at === 'string' && raw.updated_at ? raw.updated_at : null;
  plan.updated_by = String(raw?.updated_by ?? '').trim().slice(0, 60);
  return plan;
}

/** True when a plan has no recipes assigned at all. */
export function isEmptyPlan(plan) {
  return Object.values(plan?.days || {}).every((entries) => !entries.length);
}

/** Every recipe assignment in a plan, flattened and in day order. */
export function planAssignments(plan, recipesBySlug) {
  const out = [];
  for (const date of weekDates(plan?.week)) {
    for (const entry of plan.days[date] || []) {
      const recipe = recipesBySlug.get(entry.slug);
      if (!recipe) continue;
      out.push({
        date,
        recipe,
        servings: entry.servings || recipe.base_servings,
        note: entry.note
      });
    }
  }
  return out;
}

/** Slugs a plan references that no longer exist in recipes/. */
export function missingSlugs(plan, recipesBySlug) {
  const missing = [];
  for (const entries of Object.values(plan?.days || {})) {
    for (const entry of entries) {
      if (!recipesBySlug.has(entry.slug) && missing.indexOf(entry.slug) === -1) missing.push(entry.slug);
    }
  }
  return missing;
}

export function planPath(dir, weekId) {
  return path.join(dir, `${weekId}.json`);
}

/** Read one week's plan; a missing file is an empty plan, not an error. */
export async function readPlan(dir, weekId) {
  if (!isWeekId(weekId)) return null;
  let text;
  try {
    text = await readFile(planPath(dir, weekId), 'utf8');
  } catch {
    return emptyPlan(weekId);
  }
  try {
    return normalizePlan(JSON.parse(text), weekId) || emptyPlan(weekId);
  } catch {
    throw new Error(`${planPath(dir, weekId)} is not valid JSON`);
  }
}

/** Every plan file in the folder, oldest week first. Unreadable files are skipped. */
export async function readAllPlans(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const plans = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue;
    const weekId = entry.replace(/\.json$/, '');
    if (!isWeekId(weekId)) continue;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path.join(dir, entry), 'utf8'));
    } catch {
      continue;
    }
    const plan = normalizePlan(parsed, weekId);
    if (plan) plans.push(plan);
  }
  return plans;
}

/** Write a plan, bumping its revision so other devices can spot the newer copy. */
export async function writePlan(dir, rawPlan, options = {}) {
  const plan = normalizePlan(rawPlan, rawPlan?.week);
  if (!plan) throw new Error(`Cannot save a plan without a valid week id (got "${rawPlan?.week}")`);

  const existing = await readPlan(dir, plan.week);
  if (options.bumpRevision !== false) {
    plan.revision = Math.max(plan.revision, existing?.revision ?? 0) + 1;
    plan.updated_at = options.now || new Date().toISOString();
  }
  if (options.updatedBy) plan.updated_by = String(options.updatedBy).slice(0, 60);

  await mkdir(dir, { recursive: true });
  const file = planPath(dir, plan.week);
  await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return { plan, file };
}
