/**
 * Reads CSV rows into the shape `applyBackfill` expects, reusing the same
 * timestamp parsing and validation as the full import path so a backfilled
 * hour lands in exactly the bucket a normal reading would.
 */

import { parseCsv } from './csv.js';
import { parseTimestamp } from './time.js';

function parseNumber(value) {
  if (value == null) return NaN;
  const text = String(value).replace(/,/g, '').trim();
  if (text === '') return NaN;
  const number = Number(text);
  return Number.isFinite(number) ? number : NaN;
}

/**
 * @param {string} text raw CSV
 * @param {object} snapshot current snapshot (for meter/offset lookup)
 * @returns {{ok:boolean, rows:Array, errors:string[], warnings:string[], dateRange:?{start,end}}}
 */
export function parseBackfillCsv(text, snapshot, name = 'readings_backfill.csv') {
  const table = parseCsv(text, { name });
  const errors = [];
  const warnings = [];
  for (const error of table.errors) errors.push(`${name} 第 ${error.line} 行：${error.message}`);
  for (const key of ['meter_id', 'timestamp', 'interval_units']) {
    if (!table.normalizedColumns.includes(key)) {
      errors.push(`${name} 缺少必需列：${key}`);
    }
  }
  if (errors.length) return { ok: false, rows: [], errors, warnings, dateRange: null };

  const rows = [];
  const seen = new Set();
  for (const { record, line } of table.records) {
    const meterId = record.meter_id;
    const meter = snapshot.meterById.get(meterId);
    if (!meter) {
      errors.push(`${name} 第 ${line} 行引用了未知电表：${meterId}`);
      continue;
    }
    const building = snapshot.buildingById.get(meter.served[0]);
    const parsed = parseTimestamp(record.timestamp, building ? building.offsetMin : 480);
    if (!parsed) {
      errors.push(`${name} 第 ${line} 行 timestamp 无效：${record.timestamp}`);
      continue;
    }
    const units = parseNumber(record.interval_units);
    if (!Number.isFinite(units)) {
      errors.push(`${name} 第 ${line} 行 interval_units 无效：${record.interval_units}`);
      continue;
    }
    if (units < 0) {
      errors.push(`${name} 第 ${line} 行 interval_units 为负数，需要人工确认`);
      continue;
    }
    const key = `${meterId}|${parsed.digits}`;
    if (seen.has(key)) {
      warnings.push(`${name} 第 ${line} 行与已有补录行重复，保留首条`);
      continue;
    }
    seen.add(key);
    rows.push({
      meter_id: meterId,
      timestamp: record.timestamp,
      raw: record.timestamp,
      digits: parsed.digits,
      ms: parsed.ms,
      offsetMin: parsed.offsetMin,
      declaredOffset: parsed.hasOffset,
      units,
      source: 'backfill',
      line,
      buildingIds: meter.served.slice(),
    });
  }

  if (!rows.length && !errors.length) {
    errors.push(`${name} 没有可用的补录读数`);
  }
  if (!errors.length) {
    // Which days does this backfill actually touch? Used to scope recomputation.
    const dates = rows.map((row) => row.digits.slice(0, 10));
    const range = { start: dates.sort()[0], end: dates.sort().reverse()[0] };
    return { ok: true, rows, errors, warnings, dateRange: range };
  }
  return { ok: false, rows, errors, warnings, dateRange: null };
}
