/**
 * Live plan sync — the bit that lets the other cook open a link and edit.
 *
 * Like week.js and shopping.js this runs in both places: Node imports it, and
 * it is inlined into planner.html with its export lines stripped. Keep it
 * dependency-free.
 *
 * There is no API key here, and there must never be one. The endpoint is a
 * Supabase Edge Function holding the service key server-side, reaching exactly
 * one table. Publishing the project's own key instead would have exposed every
 * other table in that project, which is readable and writable by `anon`.
 *
 * Every call answers in one of three ways, and the caller must handle all three:
 *
 *   { ok: true, plan }           the server's copy, now authoritative
 *   { ok: false, stale, plan }   someone saved first; `plan` is what they saved
 *   { ok: false, offline }       no network, or the server is unwell
 *
 * `offline` is never an error the cook has to deal with: edits are already in
 * localStorage, so the page keeps working and tries again later.
 */

const SYNC_TIMEOUT_MS = 8000;

/** True when this build has somewhere to sync to. */
export function syncEnabled(config) {
  return !!(config && typeof config.endpoint === 'string' && config.endpoint);
}

async function callEndpoint(url, options) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS) : null;
  try {
    const response = await fetch(url, Object.assign({ signal: controller && controller.signal }, options));
    let body = null;
    try {
      body = await response.json();
    } catch { /* a proxy or an error page, not our JSON */ }
    return { response, body };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Read the stored plan for a week. A week nobody has saved yet is `plan: null`. */
export async function pullPlan(config, week) {
  if (!syncEnabled(config)) return { ok: false, offline: true };
  try {
    const { response, body } = await callEndpoint(
      config.endpoint + '?week=' + encodeURIComponent(week),
      { method: 'GET', headers: { accept: 'application/json' } }
    );
    if (!response.ok || !body) return { ok: false, offline: true };
    return { ok: true, plan: body.plan || null };
  } catch {
    return { ok: false, offline: true };
  }
}

/**
 * Save a week, but only if `baseRevision` is still the stored one — otherwise
 * the other cook saved while this page held edits, and overwriting them
 * silently is the one thing this must never do.
 */
export async function pushPlan(config, week, days, baseRevision, updatedBy) {
  if (!syncEnabled(config)) return { ok: false, offline: true };
  try {
    const { response, body } = await callEndpoint(config.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        week: week,
        days: days || {},
        base_revision: Number(baseRevision) || 0,
        updated_by: String(updatedBy || '').slice(0, 60)
      })
    });
    if (response.status === 409) {
      return { ok: false, stale: true, plan: (body && body.plan) || null };
    }
    if (!response.ok || !body || !body.plan) return { ok: false, offline: true };
    return { ok: true, plan: body.plan };
  } catch {
    return { ok: false, offline: true };
  }
}
