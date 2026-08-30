import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isoWeekId, parseWeekId, isWeekId, weekStart, weekDates, shiftWeek,
  weeksInYear, weekLabel, dayName, dayLabel, toDateId
} from '../planner/shared/week.js';

test('assigns ISO week ids, including across the new year', () => {
  assert.equal(isoWeekId('2026-08-31'), '2026-W36', 'a Monday starts its week');
  assert.equal(isoWeekId('2026-09-06'), '2026-W36', 'the Sunday closes the same week');
  assert.equal(isoWeekId('2026-08-30'), '2026-W35', 'Sunday belongs to the week before');
  // The ISO year is not the calendar year: week 1 is the week holding 4 Jan,
  // so late December can be next year's W01 and 1 January can be last year's W53.
  assert.equal(isoWeekId('2025-12-29'), '2026-W01');
  assert.equal(isoWeekId('2026-01-01'), '2026-W01');
  assert.equal(isoWeekId('2027-01-01'), '2026-W53');
  assert.equal(isoWeekId('2027-01-04'), '2027-W01');
});

test('knows which years are 53 weeks long', () => {
  assert.equal(weeksInYear(2026), 53);
  assert.equal(weeksInYear(2025), 52);
  assert.equal(isWeekId('2026-W53'), true);
  assert.equal(isWeekId('2025-W53'), false, 'a 52-week year has no week 53');
  assert.equal(isWeekId('2026-W00'), false);
  assert.equal(isWeekId('2026-36'), false);
  assert.equal(isWeekId(''), false);
  assert.equal(isWeekId(null), false);
});

test('parses and rebuilds a week id without drifting', () => {
  assert.deepEqual(parseWeekId('2026-W36'), { year: 2026, week: 36 });
  assert.equal(toDateId(weekStart('2026-W36')), '2026-08-31');
  for (const week of ['2026-W01', '2026-W36', '2026-W53', '2020-W53']) {
    assert.equal(isoWeekId(weekStart(week)), week, `${week} survives a round trip`);
  }
});

test('lists a week as seven dates, Monday first', () => {
  assert.deepEqual(weekDates('2026-W36'), [
    '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03',
    '2026-09-04', '2026-09-05', '2026-09-06'
  ]);
  assert.deepEqual(weekDates('nonsense'), []);
});

test('steps between weeks across year ends', () => {
  assert.equal(shiftWeek('2026-W36', 1), '2026-W37');
  assert.equal(shiftWeek('2026-W36', -1), '2026-W35');
  assert.equal(shiftWeek('2026-W01', -1), '2025-W52');
  assert.equal(shiftWeek('2026-W53', 1), '2027-W01');
  assert.equal(shiftWeek('2026-W36', 0), '2026-W36');
});

test('labels weeks and days for humans', () => {
  assert.equal(weekLabel('2026-W36'), '31 Aug – 6 Sep 2026');
  assert.equal(weekLabel('2026-W53'), '28 Dec 2026 – 3 Jan 2027', 'a week spanning two years shows both');
  assert.equal(dayName('2026-08-31'), 'Mon');
  assert.equal(dayName('2026-09-06'), 'Sun');
  assert.equal(dayLabel('2026-09-01'), '1 Sep');
});

test('week maths is timezone-proof', () => {
  // A Date built from a local-midnight string in a westerly zone is still the
  // same calendar day; the planner must not shift it into the previous week.
  const original = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Auckland';
    assert.equal(isoWeekId('2026-08-31'), '2026-W36');
    process.env.TZ = 'America/Los_Angeles';
    assert.equal(isoWeekId('2026-08-31'), '2026-W36');
    assert.deepEqual(weekDates('2026-W36')[0], '2026-08-31');
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
