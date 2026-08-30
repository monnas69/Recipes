/**
 * ISO-8601 week helpers, shared by the planner CLI and the built page.
 *
 * Like src/shared/format.js this file is imported normally by Node AND inlined
 * verbatim into planner.html (with `import`/`export` stripped), so the week the
 * browser shows is always the week the CLI wrote. Keep it dependency-free.
 *
 * Everything is computed in UTC: a plan is a set of calendar dates, not an
 * instant, so a cook opening the page in a different timezone must still see
 * the same Monday.
 */

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

/** Accepts a Date, a "YYYY-MM-DD" string or an ISO timestamp; returns UTC midnight. */
export function asUtcDate(input) {
  if (input instanceof Date) {
    return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
  }
  const text = String(input == null ? '' : input).trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  }
  const parsed = new Date(text);
  if (isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

/** "YYYY-MM-DD" for a Date. */
export function toDateId(date) {
  const d = asUtcDate(date);
  if (!d) return '';
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

/** Monday of the week containing `date` (ISO weeks start on Monday). */
export function mondayOf(date) {
  const d = asUtcDate(date);
  if (!d) return null;
  const offset = (d.getUTCDay() + 6) % 7; // Mon = 0 … Sun = 6
  return new Date(d.getTime() - offset * DAY_MS);
}

/** Monday of ISO week 1 of `year` — the week that contains 4 January. */
function week1Monday(year) {
  return mondayOf(new Date(Date.UTC(year, 0, 4)));
}

/**
 * ISO week id for a date, e.g. "2026-W36".
 *
 * The ISO year is not always the calendar year: 1 January 2027 falls in
 * 2026-W53, so the year is taken from the week's Thursday.
 */
export function isoWeekId(date) {
  const monday = mondayOf(date);
  if (!monday) return '';
  const thursday = new Date(monday.getTime() + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.round((monday.getTime() - week1Monday(year).getTime()) / WEEK_MS) + 1;
  return year + '-W' + pad2(week);
}

/** "2026-W36" -> { year: 2026, week: 36 }, or null when malformed/out of range. */
export function parseWeekId(weekId) {
  const match = String(weekId == null ? '' : weekId).trim().match(/^(\d{4})-W(\d{1,2})$/i);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) return null;
  // Only 53-week years have a week 53; reject 2026-W53 rather than silently
  // rolling it into the next year.
  if (week === 53 && weeksInYear(year) < 53) return null;
  return { year: year, week: week };
}

/** How many ISO weeks a year has — 52, or 53 for a "long" year. */
export function weeksInYear(year) {
  const start = week1Monday(year);
  const next = week1Monday(year + 1);
  return Math.round((next.getTime() - start.getTime()) / WEEK_MS);
}

/** True when `weekId` is a well-formed, in-range ISO week id. */
export function isWeekId(weekId) {
  return parseWeekId(weekId) !== null;
}

/** Monday of an ISO week id, as a Date (UTC midnight). */
export function weekStart(weekId) {
  const parsed = parseWeekId(weekId);
  if (!parsed) return null;
  return new Date(week1Monday(parsed.year).getTime() + (parsed.week - 1) * WEEK_MS);
}

/** The seven "YYYY-MM-DD" dates of a week, Monday first. */
export function weekDates(weekId) {
  const start = weekStart(weekId);
  if (!start) return [];
  const dates = [];
  for (let i = 0; i < 7; i += 1) dates.push(toDateId(new Date(start.getTime() + i * DAY_MS)));
  return dates;
}

/** The ISO week id `delta` weeks away from `weekId` (negative goes back). */
export function shiftWeek(weekId, delta) {
  const start = weekStart(weekId);
  if (!start) return weekId;
  return isoWeekId(new Date(start.getTime() + delta * WEEK_MS));
}

/** The ISO week id containing `now` (defaults to today). */
export function currentWeekId(now) {
  return isoWeekId(now || new Date());
}

/** Weekday name for a date, e.g. "Mon". */
export function dayName(dateId) {
  const d = asUtcDate(dateId);
  if (!d) return '';
  return DAY_NAMES[(d.getUTCDay() + 6) % 7];
}

/** Short date label, e.g. "31 Aug". */
export function dayLabel(dateId) {
  const d = asUtcDate(dateId);
  if (!d) return '';
  return d.getUTCDate() + ' ' + MONTH_NAMES[d.getUTCMonth()];
}

/** Human range for a week, e.g. "31 Aug – 6 Sep 2026". */
export function weekLabel(weekId) {
  const dates = weekDates(weekId);
  if (!dates.length) return String(weekId || '');
  const start = asUtcDate(dates[0]);
  const end = asUtcDate(dates[6]);
  const startText = start.getUTCFullYear() === end.getUTCFullYear()
    ? dayLabel(dates[0])
    : dayLabel(dates[0]) + ' ' + start.getUTCFullYear();
  return startText + ' – ' + dayLabel(dates[6]) + ' ' + end.getUTCFullYear();
}
