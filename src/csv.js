/**
 * Small, dependency-free CSV reader/writer.
 * Handles UTF-8 BOM, quoted fields, escaped quotes, and newlines inside quotes.
 */

export function normalizeHeader(value) {
  return String(value ?? '')
    .replace(/^﻿/, '')
    .trim()
    .toLowerCase();
}

export function parseCsv(text, options = {}) {
  const name = options.name || '';
  const source = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  const errors = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  let sawSeparator = false;

  const pushField = () => {
    row.push(field);
    field = '';
    sawSeparator = false;
  };

  const pushRow = () => {
    if (row.length === 0 && field === '') return;
    if (row.length === 0 && field.trim() === '') {
      field = '';
      return;
    }
    pushField();
    const nonEmpty = row.some((cell) => cell.trim() !== '');
    if (nonEmpty) rows.push({ values: row, line: rowLine });
    row = [];
    rowLine = line;
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
        if (ch === '\n') line += 1;
      }
      continue;
    }
    if (ch === '"') {
      if (field.trim() === '') {
        field = '';
        inQuotes = true;
      } else {
        field += ch;
      }
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\r') {
      // CRLF: the following LF closes the row.
      if (source[i + 1] !== '\n') {
        pushRow();
        line += 1;
        rowLine = line;
      }
    } else if (ch === '\n') {
      pushRow();
      line += 1;
      rowLine = line;
    } else {
      field += ch;
    }
  }
  if (inQuotes) errors.push({ line: rowLine, message: '存在未闭合的引号字段' });
  pushRow();

  if (rows.length === 0) {
    return { name, columns: [], normalizedColumns: [], records: [], rowCount: 0, errors: [{ line: 1, message: '文件为空' }] };
  }

  const headerRow = rows.shift();
  const columns = headerRow.values.map((value) => value.replace(/^﻿/, '').trim());
  const normalizedColumns = columns.map(normalizeHeader);
  const seen = new Set();
  for (const key of normalizedColumns) {
    if (!key) {
      errors.push({ line: headerRow.line, message: '存在空列名' });
    } else if (seen.has(key)) {
      errors.push({ line: headerRow.line, message: `列名重复：${key}` });
    }
    seen.add(key);
  }

  const records = [];
  for (const { values, line: rowLineNumber } of rows) {
    if (values.length !== columns.length) {
      if (values.length > columns.length) {
        errors.push({ line: rowLineNumber, message: `该行有 ${values.length} 个值，表头只有 ${columns.length} 列` });
      }
    }
    const record = {};
    for (let i = 0; i < normalizedColumns.length; i += 1) {
      if (!normalizedColumns[i]) continue;
      record[normalizedColumns[i]] = (values[i] ?? '').trim();
    }
    records.push({ record, line: rowLineNumber });
  }

  return {
    name,
    columns,
    normalizedColumns,
    records,
    rowCount: records.length,
    errors,
  };
}

export function tableKindFromColumns(columns, fileName = '') {
  const has = (key) => columns.includes(key);
  const looksBackfill = /backfill|补录/i.test(fileName);
  if (has('meter_id') && has('timestamp') && (has('interval_units') || has('interval_kwh') || has('register_end_kwh'))) {
    return looksBackfill ? 'backfill' : 'readings';
  }
  if (has('event_id') && has('timestamp') && has('type')) return 'events';
  if (has('meter_id') && has('effective_from') && has('multiplier')) return 'multipliers';
  if (has('meter_id') && has('role')) return 'meters';
  if (has('building_id') && has('floor_area_m2')) return 'buildings';
  if (has('building_id') && has('date') && has('open_time')) return 'hours';
  if (has('date') && has('temp_mean_c')) return 'weather';
  return null;
}

export function escapeCsvCell(value) {
  const str = value == null ? '' : String(value);
  if (/[",\r\n]/.test(str)) return '"' + str.replaceAll('"', '""') + '"';
  return str;
}

export function toCsv(columns, rows) {
  const lines = [columns.map(escapeCsvCell).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsvCell(row[column])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
