/**
 * Normalises the imported tables into the compact structures the dashboard
 * consumes. Import is all-or-nothing per required table: if a required table
 * is missing or invalid, the app reports the problem instead of producing
 * silently wrong numbers.
 */

import { parseCsv, tableKindFromColumns } from './csv.js';
import { isValidDateKey, minutesOfClock, operatingHours, parseTimestamp, dateKey, addDays, eachDate } from './time.js';

export const REQUIRED_TABLES = [
  { kind: 'buildings', label: '楼宇信息 buildings.csv', hint: 'building_id,name,type,floor_area_m2,timezone_offset,note' },
  { kind: 'meters', label: '电表清单 meters.csv', hint: 'meter_id,building_id,role,label,active_from,active_to,priority' },
  { kind: 'multipliers', label: '倍率变更 multipliers.csv', hint: 'meter_id,effective_from,multiplier' },
  { kind: 'events', label: '计量事件 meter_events.csv', hint: 'event_id,building_id,meter_id,timestamp,type,note' },
  { kind: 'weather', label: '本地天气 weather.csv', hint: 'date,temp_mean_c,temp_max_c,temp_min_c,humidity_pct,condition,source' },
  { kind: 'hours', label: '营业时段 business_hours.csv', hint: 'building_id,date,open_time,close_time,closed,note' },
  { kind: 'readings', label: '电表读数 readings.csv', hint: 'meter_id,timestamp,interval_units,source' },
];

export const OPTIONAL_TABLES = [
  { kind: 'backfill', label: '补录读数 readings_backfill.csv', hint: 'meter_id,timestamp,interval_units,source' },
];

const EVENT_TYPES = new Set(['replacement', 'multiplier_change', 'timezone_shift', 'missing', 'backfill', 'overlap', 'imputation']);

export const EVENT_TYPE_LABELS = {
  replacement: '电表更换',
  multiplier_change: '倍率调整',
  timezone_shift: '时区错位',
  missing: '缺测',
  backfill: '补录',
  overlap: '重叠计量',
  imputation: '估算补值',
};

export const READING_SOURCE_LABELS = {
  meter: '正常抄读',
  backfill: '补录',
  imputed: '估算补值',
};

function parseNumber(value) {
  if (value == null) return NaN;
  const text = String(value).replace(/,/g, '').trim();
  if (text === '') return NaN;
  const number = Number(text);
  return Number.isFinite(number) ? number : NaN;
}

function parseBoolean(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'true' || text === '1' || text === 'yes' || text === '是' || text === 'y';
}

function normalizeOffset(value) {
  if (value == null || String(value).trim() === '') return 480;
  const match = String(value).trim().match(/^(?:UTC|GMT)?([+-]?)(\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] || 0);
  if (hours > 14 || minutes > 59) return null;
  return sign * (hours * 60 + minutes);
}

function detectTables(files) {
  const found = new Map();
  const unknown = [];
  for (const file of files) {
    const kind = tableKindFromColumns(file.normalizedColumns, file.name);
    if (!kind) {
      unknown.push(file.name);
      continue;
    }
    if (found.has(kind)) {
      found.get(kind).duplicateFiles = [...(found.get(kind).duplicateFiles || []), file.name];
    } else {
      found.set(kind, file);
    }
  }
  return { found, unknown };
}

/**
 * @param {Array<{name:string,text:string}>} files
 * @returns {{ok:boolean, errors:string[], warnings:string[], snapshot:object}}
 */
export function buildSnapshot(files) {
  const errors = [];
  const warnings = [];
  const parsed = [];

  for (const file of files) {
    const table = parseCsv(file.text, { name: file.name });
    for (const error of table.errors) {
      errors.push(`${file.name} 第 ${error.line} 行：${error.message}`);
    }
    parsed.push(table);
  }

  const { found, unknown } = detectTables(parsed);
  if (unknown.length) warnings.push(`未识别的文件（已忽略）：${unknown.join('、')}`);
  for (const [kind, table] of found) {
    if (table.duplicateFiles) {
      warnings.push(`${kind} 表存在多个文件，仅使用 ${table.name}；已忽略：${table.duplicateFiles.join('、')}`);
    }
  }
  for (const required of REQUIRED_TABLES) {
    if (!found.has(required.kind)) {
      errors.push(`缺少必需表格：${required.label}（列格式：${required.hint}）`);
    }
  }
  if (errors.length) return { ok: false, errors, warnings, snapshot: null };

  const buildings = [];
  const buildingIds = new Set();
  for (const { record, line } of found.get('buildings').records) {
    const id = record.building_id;
    if (!id) {
      errors.push(`buildings.csv 第 ${line} 行缺少 building_id`);
      continue;
    }
    if (buildingIds.has(id)) {
      errors.push(`buildings.csv 第 ${line} 行 building_id 重复：${id}`);
      continue;
    }
    const area = parseNumber(record.floor_area_m2);
    if (!(area > 0)) {
      errors.push(`buildings.csv 第 ${line} 行 ${id} 的 floor_area_m2 无效：${record.floor_area_m2}`);
      continue;
    }
    const offset = normalizeOffset(record.timezone_offset);
    if (offset == null) {
      errors.push(`buildings.csv 第 ${line} 行 ${id} 的 timezone_offset 无法解析：${record.timezone_offset}`);
      continue;
    }
    buildingIds.add(id);
    buildings.push({
      id,
      name: record.name || id,
      type: record.type || '未分类',
      area,
      offsetMin: offset,
      note: record.note || '',
    });
  }

  const meters = [];
  const meterById = new Map();
  for (const { record, line } of found.get('meters').records) {
    const id = record.meter_id;
    if (!id || meterById.has(id)) {
      errors.push(`meters.csv 第 ${line} 行 meter_id 缺失或重复：${id || '(空)'}`);
      continue;
    }
    const role = record.role || 'main';
    const served = String(record.building_id || '').split('|').map((value) => value.trim()).filter(Boolean);
    if (served.length === 0 || served.some((bid) => !buildingIds.has(bid))) {
      errors.push(`meters.csv 第 ${line} 行 ${id} 的 building_id 未在 buildings.csv 中定义：${record.building_id}`);
      continue;
    }
    const meter = {
      id,
      served,
      role,
      label: record.label || id,
      activeFrom: record.active_from || null,
      activeTo: record.active_to || null,
      priority: Number.isFinite(parseNumber(record.priority)) ? parseNumber(record.priority) : 1,
      line: line,
    };
    if ((meter.activeFrom && !isValidDateKey(meter.activeFrom)) || (meter.activeTo && !isValidDateKey(meter.activeTo))) {
      errors.push(`meters.csv 第 ${line} 行 ${id} 的 active_from / active_to 不是有效日期`);
      continue;
    }
    meters.push(meter);
    meterById.set(id, meter);
  }

  const multipliers = [];
  const multiplierKeys = new Set();
  for (const { record, line } of found.get('multipliers').records) {
    const meterId = record.meter_id;
    const from = record.effective_from;
    const multiplier = parseNumber(record.multiplier);
    if (!meterById.has(meterId)) {
      errors.push(`multipliers.csv 第 ${line} 行引用了未知电表：${meterId}`);
      continue;
    }
    if (!isValidDateKey(from)) {
      errors.push(`multipliers.csv 第 ${line} 行 effective_from 无效：${from}`);
      continue;
    }
    if (!(multiplier > 0)) {
      errors.push(`multipliers.csv 第 ${line} 行倍率必须为正数：${record.multiplier}`);
      continue;
    }
    const key = `${meterId}|${from}`;
    if (multiplierKeys.has(key)) {
      warnings.push(`multipliers.csv 第 ${line} 行 ${meterId} 在 ${from} 的倍率重复，保留首次出现的值`);
      continue;
    }
    multiplierKeys.add(key);
    multipliers.push({ meterId, from, multiplier, line });
  }

  const events = [];
  for (const { record, line } of found.get('events').records) {
    const type = record.type;
    if (!EVENT_TYPES.has(type)) {
      warnings.push(`meter_events.csv 第 ${line} 行事件类型未知（已忽略）：${type}`);
      continue;
    }
    const parsedTs = parseTimestamp(record.timestamp, 480);
    if (!parsedTs) {
      errors.push(`meter_events.csv 第 ${line} 行 timestamp 无效：${record.timestamp}`);
      continue;
    }
    if (record.meter_id && !meterById.has(record.meter_id)) {
      warnings.push(`meter_events.csv 第 ${line} 行引用未知电表 ${record.meter_id}，该事件只保留在事件列表中`);
    }
    let windowEndMs = null;
    if (record.window_end) {
      const parsedEnd = parseTimestamp(record.window_end, 480);
      if (!parsedEnd || parsedEnd.ms <= parsedTs.ms) {
        errors.push(`meter_events.csv 第 ${line} 行 window_end 无效或不晚于 timestamp：${record.window_end}`);
        continue;
      }
      windowEndMs = parsedEnd.ms;
    }
    events.push({
      id: record.event_id || `EV-${line}`,
      buildingId: record.building_id || '',
      meterId: record.meter_id || '',
      digits: parsedTs.digits,
      ms: parsedTs.ms,
      windowEndMs,
      windowEndDigits: record.window_end ? parseTimestamp(record.window_end, 480).digits : null,
      timestamp: record.timestamp,
      type,
      note: record.note || '',
    });
  }
  events.sort((a, b) => a.ms - b.ms);

  const weather = new Map();
  for (const { record, line } of found.get('weather').records) {
    const date = record.date;
    const temp = parseNumber(record.temp_mean_c);
    if (!isValidDateKey(date)) {
      errors.push(`weather.csv 第 ${line} 行日期无效：${date}`);
      continue;
    }
    if (!Number.isFinite(temp)) {
      errors.push(`weather.csv 第 ${line} 行 temp_mean_c 无效：${record.temp_mean_c}`);
      continue;
    }
    weather.set(date, {
      date,
      tempMean: temp,
      tempMax: parseNumber(record.temp_max_c),
      tempMin: parseNumber(record.temp_min_c),
      humidity: parseNumber(record.humidity_pct),
      condition: record.condition || '',
      source: record.source || '',
      line,
    });
  }

  const hours = new Map();
  for (const { record, line } of found.get('hours').records) {
    const bid = record.building_id;
    const date = record.date;
    if (!buildingIds.has(bid)) {
      errors.push(`business_hours.csv 第 ${line} 行引用了未知楼宇：${bid}`);
      continue;
    }
    if (!isValidDateKey(date)) {
      errors.push(`business_hours.csv 第 ${line} 行日期无效：${date}`);
      continue;
    }
    const closed = parseBoolean(record.closed);
    const openMinutes = minutesOfClock(record.open_time);
    const closeMinutes = minutesOfClock(record.close_time);
    if (!closed && (openMinutes == null || closeMinutes == null || openMinutes === closeMinutes)) {
      errors.push(`business_hours.csv 第 ${line} 行营业时间无效：${record.open_time}–${record.close_time}`);
      continue;
    }
    const key = `${bid}|${date}`;
    if (hours.has(key)) {
      warnings.push(`business_hours.csv 第 ${line} 行 ${bid} ${date} 营业时段重复，保留首条`);
      continue;
    }
    hours.set(key, {
      buildingId: bid,
      date,
      openTime: record.open_time || '',
      closeTime: record.close_time || '',
      openMinutes,
      closeMinutes,
      closed,
      note: record.note || '',
      hours: operatingHours(record.open_time, record.close_time, closed),
    });
  }

  const normalizeReadingRow = (record, line, tableName, forcedSource) => {
    const meterId = record.meter_id;
    const meter = meterById.get(meterId);
    if (!meter) {
      errors.push(`${tableName} 第 ${line} 行引用了未知电表：${meterId}`);
      return null;
    }
    const parsedTs = parseTimestamp(record.timestamp, buildings.find((b) => b.id === meter.served[0])?.offsetMin ?? 480);
    if (!parsedTs) {
      errors.push(`${tableName} 第 ${line} 行 timestamp 无效：${record.timestamp}`);
      return null;
    }
    const units = parseNumber(record.interval_units ?? record.kwh);
    if (!Number.isFinite(units)) {
      errors.push(`${tableName} 第 ${line} 行 interval_units 无效：${record.interval_units}`);
      return null;
    }
    if (units < 0) {
      errors.push(`${tableName} 第 ${line} 行 interval_units 为负数（${units}），负用量需要人工确认`);
      return null;
    }
    const source = forcedSource || record.source || 'meter';
    return {
      meterId,
      raw: record.timestamp,
      digits: parsedTs.digits,
      ms: parsedTs.ms,
      offsetMin: parsedTs.offsetMin,
      declaredOffset: parsedTs.hasOffset,
      units,
      source,
      table: tableName,
      line,
    };
  };

  const readings = [];
  const readingsByMeter = new Map();
  /** Keyed by `meterId|digits` - the wall-clock label the collector wrote. */
  const readingLookup = new Map();
  const seenReadingKeys = new Set();

  const insertReading = (reading) => {
    readings.push(reading);
    if (!readingsByMeter.has(reading.meterId)) readingsByMeter.set(reading.meterId, new Map());
    readingsByMeter.get(reading.meterId).set(reading.ms, reading);
    readingLookup.set(`${reading.meterId}|${reading.digits}`, reading);
  };

  for (const { record, line } of found.get('readings').records) {
    const reading = normalizeReadingRow(record, line, 'readings.csv', null);
    if (!reading) continue;
    const dedupeKey = `${reading.meterId}|${reading.raw}`;
    if (seenReadingKeys.has(dedupeKey)) {
      warnings.push(`readings.csv 第 ${line} 行与已有读数重复（同一电表同一时间戳），保留首条`);
      continue;
    }
    seenReadingKeys.add(dedupeKey);
    insertReading(reading);
  }

  const backfill = [];
  for (const { record, line } of (found.get('backfill')?.records || [])) {
    const reading = normalizeReadingRow(record, line, 'readings_backfill.csv', 'backfill');
    if (!reading) continue;
    // Backfill fills a gap or supersedes the same labelled wall-clock row.
    if (readingLookup.has(`${reading.meterId}|${reading.digits}`)) {
      warnings.push(`readings_backfill.csv 第 ${line} 行覆盖了同一电表同一时刻的已有读数`);
    }
    insertReading(reading);
    backfill.push(reading);
  }

  for (const meter of meters) {
    const rows = readingsByMeter.get(meter.id);
    if (rows) {
      const sortedMs = [...rows.keys()].sort((a, b) => a - b);
      meter.firstMs = sortedMs[0];
      meter.lastMs = sortedMs[sortedMs.length - 1];
      meter.readingCount = sortedMs.length;
    } else {
      meter.firstMs = null;
      meter.lastMs = null;
      meter.readingCount = 0;
    }
  }

  if (errors.length) return { ok: false, errors, warnings, snapshot: null };

  const dateRange = deriveDateRange(buildings, meters, readings, weather, hours, warnings);

  const snapshot = {
    buildings,
    buildingById: new Map(buildings.map((b) => [b.id, b])),
    meters,
    meterById,
    multipliers,
    events,
    weather,
    hours,
    readings,
    readingsByMeter,
    readingsListByMeter: groupReadings(readings),
    backfill,
    dateRange,
    warnings,
  };
  return { ok: true, errors: [], warnings, snapshot };
}

function deriveDateRange(buildings, meters, readings, weather, hours, warnings) {
  const starts = [];
  const ends = [];
  const pushWeather = [...weather.keys()].sort();
  if (pushWeather.length) {
    starts.push(pushWeather[0]);
    ends.push(pushWeather[pushWeather.length - 1]);
  }
  for (const meter of meters) {
    if (meter.firstMs == null) continue;
    const building = buildings.find((candidate) => meter.served.includes(candidate.id)) || buildings[0];
    const offset = building ? building.offsetMin : 480;
    starts.push(dateKey(meter.firstMs, offset));
    ends.push(dateKey(meter.lastMs, offset));
  }
  if (!starts.length) return { start: null, end: null, dates: [] };
  const start = starts.sort()[0];
  const end = ends.sort().reverse()[0];
  const dates = eachDate(start, end);
  if (dates.length > 800) warnings.push(`数据跨度 ${dates.length} 天，逐日计算可能需要几秒钟`);
  return { start, end, dates };
}

export function groupReadings(readings) {
  const map = new Map();
  for (const reading of readings) {
    if (!map.has(reading.meterId)) map.set(reading.meterId, []);
    map.get(reading.meterId).push(reading);
  }
  for (const list of map.values()) {
    list.sort((a, b) => (
      a.digits < b.digits ? -1 : a.digits > b.digits ? 1 : (a.offsetMin - b.offsetMin) || (a.ms - b.ms)
    ));
  }
  return map;
}

/** Merge backfill rows into a snapshot, returning a new snapshot (originals untouched). */
export function applyBackfill(snapshot, rows) {
  const added = [];
  const next = {
    ...snapshot,
    // Clone meters: their firstMs/lastMs/readingCount are derived and must not
    // be written back onto the snapshot the previous analysis still references.
    meters: snapshot.meters.map((meter) => ({ ...meter })),
    readings: [...snapshot.readings],
    backfill: [...snapshot.backfill],
  };
  const lookup = new Map();
  for (const reading of next.readings) lookup.set(`${reading.meterId}|${reading.raw}`, reading);

  for (const row of rows) {
    const normalized = {
      meterId: row.meter_id,
      raw: row.timestamp,
      digits: row.digits,
      ms: row.ms,
      offsetMin: row.offsetMin,
      declaredOffset: row.declaredOffset,
      units: row.units,
      source: 'backfill',
      table: 'readings_backfill.csv',
      line: row.line,
    };
    if (!next.meterById.has(normalized.meterId)) continue;
    const key = `${normalized.meterId}|${normalized.raw}`;
    if (lookup.has(key)) continue;
    lookup.set(key, normalized);
    next.readings.push(normalized);
    added.push(normalized);
  }
  next.backfill = [...snapshot.backfill, ...added];
  next.readingsListByMeter = groupReadings(next.readings);
  next.readingsByMeter = new Map();
  for (const [meterId, list] of next.readingsListByMeter) {
    const byMs = new Map();
    for (const reading of list) byMs.set(reading.ms, reading);
    next.readingsByMeter.set(meterId, byMs);
  }
  for (const meter of next.meters) {
    const list = next.readingsListByMeter.get(meter.id);
    meter.readingCount = list ? list.length : 0;
    meter.firstMs = list && list.length ? list[0].ms : null;
    meter.lastMs = list && list.length ? list[list.length - 1].ms : null;
  }
  next.addedBackfill = added;
  return next;
}

export function totalArea(buildings) {
  return buildings.reduce((total, building) => total + building.area, 0);
}

export function uniqueBuildingIds(meters) {
  const ids = new Set();
  for (const meter of meters) for (const id of meter.served) ids.add(id);
  return [...ids].sort();
}

export { addDays };
