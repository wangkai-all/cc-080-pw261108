import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCsv, tableKindFromColumns, toCsv } from '../src/csv.js';
import {
  addDays, dateKey, eachDate, isValidDateKey, operatingHours, parseTimestamp, startOfDayMs,
} from '../src/time.js';

test('parseTimestamp keeps explicit offsets and rejects impossible dates', () => {
  const local = parseTimestamp('2025-07-01T08:00:00+08:00');
  const utc = parseTimestamp('2025-07-01T00:00:00Z');
  assert.equal(local.ms, utc.ms);
  assert.equal(local.offsetMin, 480);
  assert.equal(local.digits, '2025-07-01T08:00');
  assert.equal(parseTimestamp('2025-02-30T00:00:00Z'), null);
  assert.equal(parseTimestamp('not a timestamp'), null);
});

test('naive timestamps fall back to the declared building offset', () => {
  const parsed = parseTimestamp('2025-07-01T08:00', 480);
  assert.equal(parsed.naive, true);
  assert.equal(parsed.ms, parseTimestamp('2025-07-01T08:00:00+08:00').ms);
});

test('timezone-shift correction moves mislabelled local time back by the offset difference', () => {
  // Collector wrote local wall-clock digits but labelled them +00:00.
  const mislabelled = parseTimestamp('2025-07-02T09:00:00+00:00');
  const trueOffset = 480;
  const correctedMs = mislabelled.ms + (mislabelled.offsetMin - trueOffset) * 60_000;
  assert.equal(dateKey(correctedMs, trueOffset), '2025-07-02');
  assert.equal(new Date(correctedMs + trueOffset * 60_000).getUTCHours(), 9);
});

test('date arithmetic never depends on the host timezone', () => {
  assert.equal(addDays('2025-12-31', 1), '2026-01-01');
  assert.deepEqual(eachDate('2025-02-27', '2025-03-02'), ['2025-02-27', '2025-02-28', '2025-03-01', '2025-03-02']);
  assert.equal(isValidDateKey('2025-02-29'), false);
  assert.equal(isValidDateKey('2024-02-29'), true);
  assert.equal(dateKey(startOfDayMs('2025-03-09', 480), 480), '2025-03-09');
});

test('operatingHours handles overnight and closed days', () => {
  assert.equal(operatingHours('08:00', '18:00', false), 10);
  assert.equal(operatingHours('22:00', '02:00', false), 4);
  assert.equal(operatingHours('00:00', '24:00', false), 24);
  assert.equal(operatingHours('08:00', '18:00', true), 0);
});

test('CSV parser handles BOM, quotes, embedded commas and CRLF', () => {
  const text = '﻿meter_id,timestamp,interval_units,note\r\nM1,"2025-01-01T00:00:00+08:00","1,234","a ""quoted"" note"\r\n';
  const table = parseCsv(text, { name: 'x.csv' });
  assert.equal(table.errors.length, 0);
  assert.equal(table.records.length, 1);
  assert.equal(table.records[0].record.interval_units, '1,234');
  assert.equal(table.records[0].record.note, 'a "quoted" note');
  assert.equal(table.normalizedColumns[0], 'meter_id');
});

test('CSV parser flags ragged rows and unclosed quotes', () => {
  const ragged = parseCsv('a,b\n1,2,3\n');
  assert.ok(ragged.errors.some((error) => /3 个值/.test(error.message)));
  const unclosed = parseCsv('a,b\n"1,2\n');
  assert.ok(unclosed.errors.some((error) => /未闭合/.test(error.message)));
});

test('table detection is signature-based and honour the backfill filename hint', () => {
  assert.equal(tableKindFromColumns(['meter_id', 'timestamp', 'interval_units'], 'readings.csv'), 'readings');
  assert.equal(tableKindFromColumns(['meter_id', 'timestamp', 'interval_units'], 'readings_backfill.csv'), 'backfill');
  assert.equal(tableKindFromColumns(['meter_id', 'timestamp', 'interval_units'], '4月补录.csv'), 'backfill');
  assert.equal(tableKindFromColumns(['event_id', 'timestamp', 'type']), 'events');
  assert.equal(tableKindFromColumns(['meter_id', 'effective_from', 'multiplier']), 'multipliers');
  assert.equal(tableKindFromColumns(['meter_id', 'building_id', 'role']), 'meters');
  assert.equal(tableKindFromColumns(['building_id', 'floor_area_m2']), 'buildings');
  assert.equal(tableKindFromColumns(['building_id', 'date', 'open_time']), 'hours');
  assert.equal(tableKindFromColumns(['date', 'temp_mean_c']), 'weather');
  assert.equal(tableKindFromColumns(['foo']), null);
});

test('toCsv escapes cells that need it', () => {
  const csv = toCsv(['a', 'b'], [{ a: 'x,y', b: 'say "hi"' }]);
  assert.equal(csv, 'a,b\r\n"x,y","say ""hi"""\r\n');
});
