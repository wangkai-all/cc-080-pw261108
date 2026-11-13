import assert from 'node:assert/strict';
import test from 'node:test';

import { analyze, reanalyzeBuilding, mergeResults } from '../src/analysis.js';
import { parseBackfillCsv } from '../src/backfill.js';
import { applyBackfill, buildSnapshot } from '../src/import.js';
import { bundleToCsv, generateBundle } from '../src/sample-data.js';
import { diffDays } from '../src/time.js';

const bundle = generateBundle();
const csvFiles = bundleToCsv(bundle);
const withBackfill = Object.entries(csvFiles).map(([name, text]) => ({ name, text }));
const withoutBackfill = withBackfill.filter((file) => file.name !== 'readings_backfill.csv');

const OPTIONS = {
  baselineStart: '2025-02-01',
  baselineEnd: '2025-03-31',
  rangeStart: '2025-03-20',
  rangeEnd: '2025-05-31',
};

const built = buildSnapshot(withoutBackfill);
assert.equal(built.ok, true, built.errors?.join('; '));
const analysis = analyze(built.snapshot, OPTIONS);

test('sample bundle is generated locally and parses into a complete snapshot', () => {
  assert.ok(Object.keys(csvFiles).length >= 8);
  assert.equal(built.snapshot.buildings.length, 4);
  assert.ok(built.snapshot.readings.length > 40_000);
  assert.ok(built.snapshot.weather.size >= 365);
  assert.equal(built.snapshot.meters.length, 7);
});

test('building ids, meters and shared plant stay distinct in the summary', () => {
  for (const result of analysis.results) {
    const primary = result.meters.filter((meter) => !meter.ignored);
    assert.ok(primary.length >= 1, `${result.building.id} has a primary meter`);
    const shared = result.meters.filter((meter) => meter.ignored === 'shared');
    if (result.building.id === 'C' || result.building.id === 'D') {
      assert.ok(shared.length >= 1, 'shared central plant is never merged into a building');
      assert.ok(shared.every((meter) => meter.id === 'SHARED-PLANT'));
    }
  }
});

test('overlapping check meter is de-duplicated and reported', () => {
  const d = analysis.byId.get('D');
  const overlapMeters = d.meters.filter((meter) => meter.ignored === 'overlap');
  assert.ok(overlapMeters.some((meter) => meter.id === 'D-MAIN-B'));
  const overlapIssue = d.issues.find((issue) => issue.type === 'overlap' && issue.meterId === 'D-MAIN-B');
  assert.ok(overlapIssue, 'overlap issue is raised');
  // 10/1-10/20 fall outside this window, so the issue range should still be reported.
  assert.ok(overlapIssue.date <= '2025-10-20');
});

test('missing readings are excluded, never treated as zero', () => {
  const b = analysis.byId.get('B');
  const excluded = b.reportDays.filter((day) => !day.valid);
  assert.ok(excluded.length > 0, 'B has missing days in the compare window');
  for (const day of excluded) {
    assert.equal(day.kwh, null, 'incomplete day has no total (null, not 0)');
    assert.ok(day.missingHours > 0);
    assert.match(day.reason, /缺/);
  }
  assert.ok(b.baselineAgg.meanEnergy > 0);
  assert.ok(b.issues.some((issue) => issue.type === 'missing' && issue.severity === 'critical'));
});

test('timezone-shift window is corrected into continuous local totals', () => {
  const summer = analyze(built.snapshot, {
    baselineStart: '2025-05-01', baselineEnd: '2025-06-30',
    rangeStart: '2025-06-20', rangeEnd: '2025-07-25',
  });
  const c = summer.byId.get('C');
  const days = c.daily.filter((day) => day.date >= '2025-06-29' && day.date <= '2025-07-18');
  assert.ok(days.length >= 20);
  for (const day of days) {
    assert.equal(day.missingHours, 0, `${day.date} has every local hour after the shift correction`);
    assert.equal(day.presentHours, 24, `${day.date} present hours`);
  }
  assert.ok(c.shifts.length >= 1, 'timezone shift event is attached to C');
  assert.ok(c.issues.some((issue) => issue.type === 'timezone_shift'));
});

test('model and decomposition identities hold', () => {
  for (const result of analysis.results) {
    if (!result.model.ok) continue;
    const d = result.decomposition;
    assert.ok(Number.isFinite(d.normalized));
    const tolerance = 1e-6 * Math.max(1, Math.abs(d.actual));
    assert.ok(Math.abs((d.actual - d.normalized) + d.weatherEffect + d.scheduleEffect + d.interactionEffect) <= tolerance,
      `${result.building.id}: correction equals weather + schedule`);
    assert.ok(d.n >= 1);
  }
});

test('partial backfill only recomputes the affected dates', () => {
  const b = analysis.byId.get('B');
  const before = b.reportDays.filter((day) => day.date >= '2025-04-01' && day.date <= '2025-04-10');
  const excludedBefore = before.filter((day) => !day.valid).map((day) => day.date);
  assert.ok(excludedBefore.includes('2025-04-03'), '4/3 is missing before backfill');

  const parsed = parseBackfillCsv(csvFiles['readings_backfill.csv'], built.snapshot);
  assert.equal(parsed.ok, true, parsed.errors.join('; '));
  // The sample backfill covers B's April gap plus C's single-day September gap.
  assert.ok(parsed.rows.length >= 32);
  const bRows = parsed.rows.filter((row) => row.meter_id === 'B-MAIN');
  assert.equal(bRows.length, 32, 'B backfill rows');
  assert.deepEqual(
    { start: bRows.map((r) => r.digits.slice(0, 10)).sort()[0], end: bRows.map((r) => r.digits.slice(0, 10)).sort().reverse()[0] },
    { start: '2025-04-02', end: '2025-04-03' },
  );

  const snapshot2 = applyBackfill(built.snapshot, parsed.rows);
  assert.equal(built.snapshot.readings.length + parsed.rows.length, snapshot2.readings.length, 'original snapshot untouched');
  assert.ok(snapshot2.readings.length > built.snapshot.readings.length);
  assert.equal(snapshot2.meters.find((m) => m.id === 'B-MAIN').readingCount,
    built.snapshot.meters.find((m) => m.id === 'B-MAIN').readingCount + bRows.length);
  assert.equal(built.snapshot.meters.find((m) => m.id === 'B-MAIN').readingCount,
    [...built.snapshot.readingsListByMeter.get('B-MAIN')].length, 'original meter counts unchanged');

  const outcome = reanalyzeBuilding(snapshot2, OPTIONS, b, { start: '2025-04-02', end: '2025-04-03' });
  assert.equal(outcome.recomputed.baseline, false);
  assert.equal(outcome.recomputed.start, '2025-04-02');
  assert.equal(outcome.recomputed.end, '2025-04-03');
  assert.ok(outcome.recomputed.days <= 2);
  assert.equal(outcome.modelRefit, false);

  const fixed = outcome.result.reportDays.filter((day) => day.date >= '2025-04-02' && day.date <= '2025-04-03');
  for (const day of fixed) {
    assert.equal(day.valid, true, `${day.date} becomes complete after backfill`);
    assert.ok(day.backfilledHours > 0);
    assert.ok(day.kwh > 0);
  }
  assert.equal(outcome.result.series.length, b.series.length, 'series length unchanged outside window');

  // Days outside the affected window are byte-identical objects.
  const untouchedBefore = b.reportDays.find((day) => day.date === '2025-05-01');
  const untouchedAfter = outcome.result.reportDays.find((day) => day.date === '2025-05-01');
  assert.deepEqual(untouchedAfter, untouchedBefore);
});

test('backfill touching the baseline refits the model and recomputes all compare days', () => {
  const b = analysis.byId.get('B');
  const snapshot2 = applyBackfill(built.snapshot, parseBackfillCsv(csvFiles['readings_backfill.csv'], built.snapshot).rows);
  const outcome = reanalyzeBuilding(snapshot2, OPTIONS, b, { start: '2025-03-01', end: '2025-03-05' });
  assert.equal(outcome.recomputed.baseline, true);
  assert.equal(outcome.modelRefit, true);
  assert.ok(outcome.result.reportDays.every((day) => day.date >= OPTIONS.rangeStart && day.date <= OPTIONS.rangeEnd));
  // A refitted baseline invalidates every normalised day, so the reported
  // recompute span must be the whole compare period, not the 3/1–3/5 overlap.
  assert.equal(outcome.recomputed.days, diffDays(OPTIONS.rangeStart, OPTIONS.rangeEnd) + 1);
});

test('backfill outside both windows leaves the building untouched', () => {
  const b = analysis.byId.get('B');
  const snapshot2 = applyBackfill(built.snapshot, parseBackfillCsv(csvFiles['readings_backfill.csv'], built.snapshot).rows);
  const outcome = reanalyzeBuilding(snapshot2, OPTIONS, b, { start: '2025-09-01', end: '2025-09-02' });
  assert.equal(outcome.recomputed.days, 0);
  assert.equal(outcome.result, b, 'previous result object is returned unchanged');
});

test('backfill supersedes a same-timestamp normal reading instead of double counting', () => {
  // B-MAIN's 2025-04-15 10:00 reading re-issued in a backfill file: the hour
  // must be replaced, not added to the original.
  const existing = built.snapshot.readingsListByMeter.get('B-MAIN')
    .find((reading) => reading.digits === '2025-04-15T10:00');
  assert.ok(existing, 'sample has that hour');
  const files = Object.entries(csvFiles)
    .filter(([name]) => name !== 'readings_backfill.csv')
    .map(([name, text]) => ({ name, text }));
  files.push({
    name: 'readings_backfill.csv',
    text: 'meter_id,timestamp,interval_units,source\n'
      + `B-MAIN,2025-04-15T10:00:00+08:00,1.000,manual\n`,
  });
  const merged = buildSnapshot(files);
  assert.equal(merged.ok, true, merged.errors?.join('; '));
  const duplicateHours = merged.snapshot.readingsListByMeter.get('B-MAIN')
    .filter((reading) => reading.digits === '2025-04-15T10:00');
  assert.equal(duplicateHours.length, 2, 'both rows are stored; the grid must resolve them');

  const base = analyze(built.snapshot, OPTIONS).byId.get('B');
  const patched = analyze(merged.snapshot, OPTIONS).byId.get('B');
  const hourKwh = (result) => result.series.find(
    (point) => point.date === '2025-04-15' && point.hour === 10,
  )?.kwh;
  const multiplier = 80;
  assert.ok(Math.abs(hourKwh(patched) - 1.000 * multiplier) < 1e-6, 'corrected hour wins');
  assert.ok(Math.abs(hourKwh(patched) - hourKwh(base) - (1.000 * multiplier - existing.units * multiplier)) < 1e-6,
    'one corrected hour replaces the original, not adds to it');
});

test('anomaly detection is binned to the baseline weather envelope', () => {
  const summer = analyze(built.snapshot, {
    baselineStart: '2025-05-01', baselineEnd: '2025-06-30',
    rangeStart: '2025-07-01', rangeEnd: '2025-08-31',
  });
  const a = summer.byId.get('A');
  assert.ok(a.abnormalities.some((item) => item.date === '2025-08-18'), 'planted A anomaly is found');
  assert.ok(a.abnormalities.length <= 12, `no anomaly flooding (got ${a.abnormalities.length})`);
  for (const item of a.abnormalities) {
    assert.ok(Math.abs(item.z) >= 3);
    assert.ok(Math.abs(item.relative) >= 0.12);
  }
  const cold = summer.byId.get('A').reportDays.every((day) => day.valid);
  assert.ok(cold);
});

test('analysis is deterministic', () => {  const again = analyze(built.snapshot, OPTIONS);
  for (const result of again.results) {
    const first = analysis.byId.get(result.building.id);
    assert.equal(result.correctedPct, first.correctedPct);
    assert.equal(result.reportAgg.usableDays, first.reportAgg.usableDays);
  }
});
