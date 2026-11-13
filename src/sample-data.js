/**
 * Deterministic local sample data. No network access, no external data source.
 *
 * Deliberate quality events are embedded so every marker in the dashboard can be
 * exercised from the bundled sample:
 *  - A: main meter replaced 2025-06-01, multiplier 40 -> 60 on 2025-09-01
 *  - B: readings missing 2025-04-02 09:00..17:00 and all of 2025-04-03
 *       (a backfill CSV is supplied separately)
 *  - C: 2025-07-01..07-15 timestamps written with +00:00 although local time is UTC+8
 *  - D: temporary check meter overlaps the main meter 2025-10-01..10-20;
 *       a 3-hour communication gap is imputed and flagged
 *  - C and D share a central-plant meter (possible double counting if allocated twice)
 *  - planted abnormal days so anomaly detection has something to find
 */

import { addDays, dayOfWeek, operatingHours, parseTimestamp } from './time.js';
import { toCsv } from './csv.js';

export const SAMPLE_META = {
  year: 2025,
  start: '2025-01-01',
  end: '2025-12-31',
  seed: 20251113,
  tz: '+08:00',
};

const TZ = SAMPLE_META.tz;
const LOCAL_OFFSET_MIN = 480;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random) {
  const u = Math.max(random(), 1e-9);
  const v = Math.max(random(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function normalize(weights) {
  const sum = weights.reduce((total, value) => total + value, 0);
  return weights.map((value) => value / sum);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function ts(date, hour, zone = TZ) {
  return `${date}T${pad2(hour)}:00:00${zone}`;
}

const TZ_FAULT_START = '2025-07-01';
const TZ_FAULT_END = '2025-07-16';

function inTimezoneFault(date, hour) {
  if (date === TZ_FAULT_START) return hour >= 8;
  return date > TZ_FAULT_START && date < TZ_FAULT_END;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Daily weather
// ---------------------------------------------------------------------------

const WEATHER_SEED = 907;
const COLD_SNAP_DATES = ['2025-01-20', '2025-01-21', '2025-01-22', '2025-01-23', '2025-01-24'];
const HEAT_WAVE_DATES = ['2025-07-10', '2025-07-11', '2025-07-12', '2025-07-13', '2025-07-14', '2025-07-15', '2025-07-16'];

function buildWeather() {
  const random = mulberry32(WEATHER_SEED);
  const rows = [];
  const originMs = parseTimestamp('2025-01-01T00:00:00Z').ms;
  let cursor = SAMPLE_META.start;
  while (cursor <= SAMPLE_META.end) {
    const doy = Math.round((parseTimestamp(`${cursor}T00:00:00Z`).ms - originMs) / 86_400_000) + 1;
    const seasonal = 13.4 + 14.2 * Math.sin((2 * Math.PI * (doy - 110)) / 365);
    let mean = seasonal + gaussian(random) * 2.2;
    if (COLD_SNAP_DATES.includes(cursor)) mean -= 6.5;
    if (HEAT_WAVE_DATES.includes(cursor)) mean += 3.4;
    const max = mean + 5.4 + gaussian(random) * 0.8;
    const min = mean - 6.2 + gaussian(random) * 0.6;
    const humidity = clamp(54 + (mean < 8 ? 15 : 0) + (mean > 27 ? 8 : 0) + gaussian(random) * 8, 22, 96);
    const condition = mean <= -3 ? (humidity > 70 ? '小雪' : '晴冷')
      : mean < 8 ? (humidity > 75 ? '阴' : '多云')
        : mean > 28 ? (humidity > 70 ? '雷阵雨' : '晴热')
          : humidity > 80 ? '小雨' : humidity > 65 ? '多云' : '晴';
    rows.push({
      date: cursor,
      temp_mean_c: round(mean, 1),
      temp_max_c: round(max, 1),
      temp_min_c: round(min, 1),
      humidity_pct: Math.round(humidity),
      condition,
      source: '本地生成',
    });
    cursor = addDays(cursor, 1);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Buildings, meters, multipliers, business hours
// ---------------------------------------------------------------------------

export const BUILDINGS = [
  { building_id: 'A', name: '科创研发楼', type: '办公', floor_area_m2: 26800, timezone_offset: '+08:00', note: '工作日为主，周末低负荷' },
  { building_id: 'B', name: '滨江商业中心', type: '商业', floor_area_m2: 42300, timezone_offset: '+08:00', note: '含冷链与餐饮，营业时段长' },
  { building_id: 'C', name: '仁和医院综合楼', type: '医疗', floor_area_m2: 18400, timezone_offset: '+08:00', note: '24 小时运行，负荷平坦' },
  { building_id: 'D', name: '城北物流园', type: '物流', floor_area_m2: 31200, timezone_offset: '+08:00', note: '分拣作业与冷链仓储' },
];

const BUILDING_PROFILE = {
  A: {
    baseKwhPerM2Year: 86,
    typicalHours: 10,
    typicalOpen: '08:00',
    typicalClose: '18:00',
    coolCoef: 0.016,
    heatCoef: 0.010,
    retrofit: { from: '2025-10-01', factor: 0.9, note: '空调自控改造投运' },
    weekendOpen: '09:00',
    weekendClose: '13:00',
  },
  B: {
    baseKwhPerM2Year: 142,
    typicalHours: 12,
    typicalOpen: '10:00',
    typicalClose: '22:00',
    coolCoef: 0.019,
    heatCoef: 0.008,
    retrofit: { from: '2025-08-01', factor: 0.94, note: '冷站群控优化' },
    weekendOpen: '10:00',
    weekendClose: '22:00',
  },
  C: {
    baseKwhPerM2Year: 176,
    typicalHours: 24,
    typicalOpen: '00:00',
    typicalClose: '24:00',
    coolCoef: 0.014,
    heatCoef: 0.008,
    retrofit: null,
    weekendOpen: '00:00',
    weekendClose: '24:00',
  },
  D: {
    baseKwhPerM2Year: 74,
    typicalHours: 12,
    typicalOpen: '07:00',
    typicalClose: '19:00',
    coolCoef: 0.010,
    heatCoef: 0.006,
    retrofit: { from: '2025-07-01', factor: 1.03, note: '新增分拣线，负荷上升' },
    weekendOpen: '08:00',
    weekendClose: '14:00',
  },
};

const HOLIDAYS = {
  A: ['2025-01-01', '2025-01-29', '2025-01-30', '2025-01-31', '2025-05-01', '2025-10-01', '2025-10-02', '2025-10-03'],
  B: ['2025-01-01', '2025-01-29', '2025-01-30', '2025-01-31', '2025-05-01', '2025-10-01', '2025-10-02', '2025-10-03'],
  C: [],
  D: ['2025-01-01', '2025-01-29', '2025-01-30', '2025-01-31', '2025-05-01', '2025-10-01'],
};

const SPECIAL_HOURS = {
  '2025-11-11': { building_ids: ['B'], open: '10:00', close: '24:00', note: '夜间促销，营业延至 24:00' },
  '2025-06-18': { building_ids: ['C'], open: '00:00', close: '22:00', note: '设备检修，提前 2 小时闭楼' },
  '2025-09-20': { building_ids: ['A'], open: '08:00', close: '20:00', note: '开放日延长营业' },
  '2025-12-24': { building_ids: ['B'], open: '10:00', close: '23:00', note: '平安夜延长营业' },
};

export const METERS = [
  { meter_id: 'A-MAIN', building_id: 'A', role: 'main', label: '研发楼 1# 总表', active_from: '2025-01-01', active_to: '2025-05-31', priority: 1 },
  { meter_id: 'A-MAIN2', building_id: 'A', role: 'main', label: '研发楼 1# 总表（更换后）', active_from: '2025-06-01', active_to: '2025-12-31', priority: 1 },
  { meter_id: 'B-MAIN', building_id: 'B', role: 'main', label: '商业中心总表', active_from: '2025-01-01', active_to: '2025-12-31', priority: 1 },
  { meter_id: 'C-MAIN', building_id: 'C', role: 'main', label: '医院综合楼总表', active_from: '2025-01-01', active_to: '2025-12-31', priority: 1 },
  { meter_id: 'D-MAIN', building_id: 'D', role: 'main', label: '物流园总表', active_from: '2025-01-01', active_to: '2025-12-31', priority: 1 },
  { meter_id: 'D-MAIN-B', building_id: 'D', role: 'check', label: '物流园临时校验表', active_from: '2025-10-01', active_to: '2025-10-20', priority: 9 },
  { meter_id: 'SHARED-PLANT', building_id: 'C|D', role: 'shared', label: 'C/D 共用冷站总表', active_from: '2025-01-01', active_to: '2025-12-31', priority: 1 },
];

export const MULTIPLIERS = [
  { meter_id: 'A-MAIN', effective_from: '2025-01-01', multiplier: 40 },
  { meter_id: 'A-MAIN2', effective_from: '2025-06-01', multiplier: 40 },
  { meter_id: 'A-MAIN2', effective_from: '2025-09-01', multiplier: 60 },
  { meter_id: 'B-MAIN', effective_from: '2025-01-01', multiplier: 80 },
  { meter_id: 'C-MAIN', effective_from: '2025-01-01', multiplier: 60 },
  { meter_id: 'D-MAIN', effective_from: '2025-01-01', multiplier: 120 },
  { meter_id: 'D-MAIN-B', effective_from: '2025-10-01', multiplier: 120 },
  { meter_id: 'SHARED-PLANT', effective_from: '2025-01-01', multiplier: 100 },
];

export const METER_EVENTS = [
  { event_id: 'EV-001', building_id: 'A', meter_id: 'A-MAIN2', timestamp: '2025-06-01T00:00:00+08:00', type: 'replacement', note: '1# 总表整表更换为新表 A-MAIN2，读数连续' },
  { event_id: 'EV-002', building_id: 'A', meter_id: 'A-MAIN2', timestamp: '2025-09-01T00:00:00+08:00', type: 'multiplier_change', note: '倍率由 40 调整为 60，按供电局核定值录入' },
  { event_id: 'EV-003', building_id: 'C', meter_id: 'C-MAIN', timestamp: '2025-07-01T08:00:00+08:00', window_end: '2025-07-16T00:00:00+08:00', type: 'timezone_shift', note: '7/1 08:00 至 7/16 00:00（本地）期间采集器把本地时间写成 UTC：时间戳带 +00:00，需按 UTC+8 回移 8 小时' },
  { event_id: 'EV-004', building_id: 'B', meter_id: 'B-MAIN', timestamp: '2025-04-02T09:00:00+08:00', window_end: '2025-04-04T00:00:00+08:00', type: 'missing', note: '4/2 09:00–17:00 与 4/3 全天采集器离线，读数缺失，未按 0 处理' },
  { event_id: 'EV-005', building_id: 'B', meter_id: 'B-MAIN', timestamp: '2025-04-04T00:00:00+08:00', type: 'backfill', note: '已通过现场抄表补录 4/2–4/3 缺失读数' },
  { event_id: 'EV-006', building_id: 'D', meter_id: 'D-MAIN-B', timestamp: '2025-10-01T00:00:00+08:00', type: 'overlap', note: '调试期临时校验表与主表同时计量，汇总时需按优先级去重' },
  { event_id: 'EV-007', building_id: 'D', meter_id: 'D-MAIN', timestamp: '2025-06-18T03:00:00+08:00', type: 'imputation', note: '03:00–06:00 通讯中断，按前后时均值补值并标记为估算' },
];

const PROFILES = {
  officeWeekday: normalize([
    0.30, 0.26, 0.24, 0.24, 0.28, 0.42, 0.80, 1.35, 1.72, 1.86, 1.94, 1.92,
    1.88, 1.86, 1.82, 1.76, 1.64, 1.34, 1.02, 0.82, 0.68, 0.56, 0.45, 0.35,
  ]),
  officeWeekend: normalize([
    0.42, 0.38, 0.34, 0.32, 0.32, 0.38, 0.52, 0.72, 0.92, 1.02, 1.05, 1.02,
    0.98, 0.92, 0.86, 0.80, 0.72, 0.62, 0.54, 0.48, 0.44, 0.41, 0.39, 0.42,
  ]),
  retail: normalize([
    0.42, 0.36, 0.30, 0.28, 0.26, 0.28, 0.34, 0.44, 0.62, 1.12, 1.64, 1.88,
    1.96, 1.98, 1.96, 1.92, 1.90, 1.92, 1.98, 2.08, 2.16, 2.08, 1.52, 0.86,
  ]),
  hospital: normalize([
    0.96, 0.94, 0.92, 0.93, 0.96, 1.00, 1.06, 1.14, 1.22, 1.30, 1.34, 1.36,
    1.34, 1.32, 1.30, 1.28, 1.24, 1.20, 1.16, 1.12, 1.08, 1.04, 1.00, 0.98,
  ]),
  logistics: normalize([
    0.30, 0.26, 0.24, 0.22, 0.24, 0.46, 1.18, 1.62, 1.78, 1.86, 1.88, 1.80,
    1.62, 1.44, 1.50, 1.58, 1.48, 1.26, 1.04, 0.86, 0.68, 0.52, 0.40, 0.32,
  ]),
  closed: normalize([
    0.62, 0.58, 0.55, 0.53, 0.52, 0.54, 0.58, 0.64, 0.72, 0.78, 0.80, 0.78,
    0.75, 0.72, 0.70, 0.69, 0.68, 0.68, 0.70, 0.72, 0.70, 0.68, 0.66, 0.64,
  ]),
};

const ANOMALIES = {
  '2025-08-18': { building_ids: ['A'], factor: 1.42, note: '冷水机组故障，效率下降' },
  '2025-05-26': { building_ids: ['B'], factor: 1.33, note: '冷链压缩机异常运行' },
  '2025-11-17': { building_ids: ['D'], factor: 1.26, note: '分拣线满负荷超时运行' },
  '2025-07-22': { building_ids: ['A'], factor: 0.82, note: '电流互感器松动，读数偏低（疑似计量异常）' },
  '2025-09-09': { building_ids: ['C'], factor: 1.24, note: '备用发电机组带载测试' },
};

export function buildBusinessHours() {
  const rows = [];
  for (const building of BUILDINGS) {
    const profile = BUILDING_PROFILE[building.building_id];
    let cursor = SAMPLE_META.start;
    while (cursor <= SAMPLE_META.end) {
      const weekend = dayOfWeek(cursor) === 0 || dayOfWeek(cursor) === 6;
      const holiday = HOLIDAYS[building.building_id].includes(cursor);
      const special = SPECIAL_HOURS[cursor];
      let openTime = weekend ? profile.weekendOpen : profile.typicalOpen;
      let closeTime = weekend ? profile.weekendClose : profile.typicalClose;
      let closed = false;
      let note = '';
      if (building.building_id === 'A' && dayOfWeek(cursor) === 0) {
        closed = true;
        note = '周日闭楼';
      } else if (building.building_id === 'D' && dayOfWeek(cursor) === 0) {
        closed = true;
        note = '周日不排班';
      }
      if (holiday) {
        closed = true;
        note = '法定节假日闭楼';
      }
      if (special && special.building_ids.includes(building.building_id)) {
        closed = false;
        openTime = special.open;
        closeTime = special.close;
        note = special.note;
      }
      rows.push({
        building_id: building.building_id,
        date: cursor,
        open_time: openTime,
        close_time: closeTime,
        closed: closed ? 'true' : 'false',
        note,
      });
      cursor = addDays(cursor, 1);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Hourly readings from a deterministic model with understandable drivers
// ---------------------------------------------------------------------------

function profileFor(buildingId, date, closed) {
  if (closed) return PROFILES.closed;
  if (buildingId === 'A') return dayOfWeek(date) >= 6 ? PROFILES.officeWeekend : PROFILES.officeWeekday;
  if (buildingId === 'B') return PROFILES.retail;
  if (buildingId === 'C') return PROFILES.hospital;
  return PROFILES.logistics;
}

function multiplierAt(meterId, ms) {
  let value = 1;
  for (const row of MULTIPLIERS.filter((item) => item.meter_id === meterId)) {
    const effectiveMs = parseTimestamp(`${row.effective_from}T00:00:00${TZ}`, LOCAL_OFFSET_MIN).ms;
    if (ms >= effectiveMs) value = row.multiplier;
  }
  return value;
}

function expectedDailyEnergy(building, date, weather, hoursRow, random) {
  const profile = BUILDING_PROFILE[building.building_id];
  const base = (profile.baseKwhPerM2Year * building.floor_area_m2) / 365;
  const temp = weather.temp_mean_c;
  const weatherFactor = 1 + profile.coolCoef * Math.max(0, temp - 22) + profile.heatCoef * Math.max(0, 10 - temp);
  const hours = operatingHours(hoursRow.open_time, hoursRow.close_time, hoursRow.closed === 'true') ?? 0;
  const scheduleFactor = hours <= 0 ? 0.3 : 0.3 + 0.7 * Math.min(hours, 24) / profile.typicalHours;
  const retrofitFactor = profile.retrofit && date >= profile.retrofit.from ? profile.retrofit.factor : 1;
  const anomaly = ANOMALIES[date];
  const anomalyFactor = anomaly && anomaly.building_ids.includes(building.building_id) ? anomaly.factor : 1;
  const noise = 1 + gaussian(random) * 0.022;
  return base * weatherFactor * scheduleFactor * retrofitFactor * anomalyFactor * noise;
}

export function generateBundle() {
  const weatherRows = buildWeather();
  const weatherByDate = new Map(weatherRows.map((row) => [row.date, row]));
  const businessHours = buildBusinessHours();
  const hoursByDate = new Map(businessHours.map((row) => [`${row.building_id}|${row.date}`, row]));

  const output = {
    buildings: BUILDINGS,
    meters: METERS,
    multipliers: MULTIPLIERS,
    events: METER_EVENTS,
    weather: weatherRows,
    businessHours,
    readings: [],
    backfill: [],
  };

  for (const building of BUILDINGS) {
    const buildingRandom = mulberry32(SAMPLE_META.seed + building.building_id.charCodeAt(0) * 131);
    let cursor = SAMPLE_META.start;
    while (cursor <= SAMPLE_META.end) {
      const weather = weatherByDate.get(cursor);
      const hours = hoursByDate.get(`${building.building_id}|${cursor}`);
      const dailyEnergy = expectedDailyEnergy(building, cursor, weather, hours, buildingRandom);
      const share = profileFor(building.building_id, cursor, hours.closed === 'true');
      const noiseWeights = share.map((weight) => weight * (1 + gaussian(buildingRandom) * 0.045));
      const weightSum = noiseWeights.reduce((total, weight) => total + weight, 0);

      const meterId = building.building_id === 'A'
        ? (cursor < '2025-06-01' ? 'A-MAIN' : 'A-MAIN2')
        : building.building_id === 'B' ? 'B-MAIN'
          : building.building_id === 'C' ? 'C-MAIN' : 'D-MAIN';

      for (let hour = 0; hour < 24; hour += 1) {
        const energy = (dailyEnergy * noiseWeights[hour]) / weightSum;

        let timestamp = ts(cursor, hour);
        const localMs = parseTimestamp(timestamp, LOCAL_OFFSET_MIN).ms;
        if (building.building_id === 'C' && inTimezoneFault(cursor, hour)) {
          // Collector writes local wall-clock digits with a wrong +00:00 label.
          // The digits are right; only the zone suffix is wrong.
          timestamp = ts(cursor, hour, '+00:00');
        }

        const multiplier = multiplierAt(meterId, localMs);
        let units = energy / multiplier;
        let source = 'meter';

        const missingB = building.building_id === 'B' && (
          (cursor === '2025-04-02' && hour >= 9 && hour < 17)
          || cursor === '2025-04-03'
        );
        // A short daytime gap in the reporting period, used to show that a
        // backfill only recomputes the affected day instead of the whole window.
        const missingC = building.building_id === 'C' && cursor === '2025-09-03' && hour >= 10 && hour < 16;
        if (missingB || missingC) {
          output.backfill.push({
            meter_id: meterId,
            timestamp,
            interval_units: round(units),
            source: 'backfill',
          });
          continue;
        }

        if (building.building_id === 'D' && cursor === '2025-06-18' && hour >= 3 && hour < 6) {
          // Communication gap: estimated from neighbouring hours, explicitly flagged.
          units *= 1.015;
          source = 'imputed';
        }

        output.readings.push({
          meter_id: meterId,
          timestamp,
          interval_units: round(units),
          source,
        });

        if (building.building_id === 'D' && cursor >= '2025-10-01' && cursor <= '2025-10-20') {
          const trialRandom = mulberry32((SAMPLE_META.seed + 991) * (hour + 1) + (cursor.charCodeAt(9) || 0));
          output.readings.push({
            meter_id: 'D-MAIN-B',
            timestamp: ts(cursor, hour),
            interval_units: round(units * (0.975 + trialRandom() * 0.05)),
            source: 'meter',
          });
        }
      }
      cursor = addDays(cursor, 1);
    }
  }

  // Shared central plant serving C and D. It is metered separately and never
  // silently allocated to both buildings.
  {
    const sharedRandom = mulberry32(SAMPLE_META.seed + 77);
    let cursor = SAMPLE_META.start;
    while (cursor <= SAMPLE_META.end) {
      const weather = weatherByDate.get(cursor);
      const base = 1150 * (1 + 0.016 * Math.max(0, weather.temp_mean_c - 20) + 0.008 * Math.max(0, 8 - weather.temp_mean_c));
      const dailyUnits = (base * (1 + gaussian(sharedRandom) * 0.05)) / 100;
      const share = normalize(PROFILES.hospital.map((value, hour) => value * (hour >= 7 && hour <= 22 ? 1.12 : 0.9)));
      for (let hour = 0; hour < 24; hour += 1) {
        output.readings.push({
          meter_id: 'SHARED-PLANT',
          timestamp: ts(cursor, hour),
          interval_units: round((dailyUnits * share[hour]) / 100, 4),
          source: 'meter',
        });
      }
      cursor = addDays(cursor, 1);
    }
  }

  return output;
}

// ---------------------------------------------------------------------------
// CSV serialisation
// ---------------------------------------------------------------------------

const COLUMNS = {
  buildings: ['building_id', 'name', 'type', 'floor_area_m2', 'timezone_offset', 'note'],
  meters: ['meter_id', 'building_id', 'role', 'label', 'active_from', 'active_to', 'priority'],
  multipliers: ['meter_id', 'effective_from', 'multiplier'],
  events: ['event_id', 'building_id', 'meter_id', 'timestamp', 'window_end', 'type', 'note'],
  weather: ['date', 'temp_mean_c', 'temp_max_c', 'temp_min_c', 'humidity_pct', 'condition', 'source'],
  businessHours: ['building_id', 'date', 'open_time', 'close_time', 'closed', 'note'],
  readings: ['meter_id', 'timestamp', 'interval_units', 'source'],
  backfill: ['meter_id', 'timestamp', 'interval_units', 'source'],
};

export function bundleToCsv(bundle) {
  return {
    'buildings.csv': toCsv(COLUMNS.buildings, bundle.buildings),
    'meters.csv': toCsv(COLUMNS.meters, bundle.meters),
    'multipliers.csv': toCsv(COLUMNS.multipliers, bundle.multipliers),
    'meter_events.csv': toCsv(COLUMNS.events, bundle.events),
    'weather.csv': toCsv(COLUMNS.weather, bundle.weather),
    'business_hours.csv': toCsv(COLUMNS.businessHours, bundle.businessHours),
    'readings.csv': toCsv(COLUMNS.readings, bundle.readings),
    'readings_backfill.csv': toCsv(COLUMNS.backfill, bundle.backfill),
  };
}
