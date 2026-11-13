/**
 * Analysis pipeline:
 *   raw rows -> local-hour grid -> daily totals -> baseline model + normalized results.
 *
 * The grid is keyed by absolute hour. A reading is placed in the hour bucket given
 * by the building's declared UTC offset; timezone-shift events move rows whose
 * timestamps were written in the wrong offset before bucketing.
 */

import {
  DAY_MS, dateKey, diffDays, eachDate, endOfDayMs, startOfDayMs,
} from './time.js';
import { aggregate, decomposeDays, extrapolationFlags, fitBaselineModel, normalizeDay, relativeDelta } from './metrics.js';
import { mad, mean, median, roundTo, robustZ } from './stats.js';

export const ISSUE_META = {
  missing: { label: '缺测', severity: 'critical', icon: '!' },
  imputed: { label: '估算补值', severity: 'warning', icon: '≈' },
  backfill: { label: '补录', severity: 'info', icon: '↺' },
  replacement: { label: '电表更换', severity: 'info', icon: '⇄' },
  multiplier_change: { label: '倍率调整', severity: 'info', icon: '×' },
  timezone_shift: { label: '时区错位', severity: 'warn', icon: '◷' },
  overlap: { label: '重叠计量', severity: 'warning', icon: '◎' },
  abnormal: { label: '异常日期', severity: 'warning', icon: '△' },
};

export const ISSUE_ORDER = ['missing', 'overlap', 'imputed', 'timezone_shift', 'abnormal', 'multiplier_change', 'replacement', 'backfill'];

function effectiveMultiplier(multipliers, meterId, ms) {
  let value = 1;
  for (const row of multipliers) {
    if (row.meterId !== meterId) continue;
    const fromMs = startOfDayMs(row.from, 480);
    if (fromMs <= ms) value = row.multiplier;
  }
  return value;
}

function meterRange(meter, offsetMin) {
  const start = meter.firstMs ?? (meter.activeFrom ? startOfDayMs(meter.activeFrom, offsetMin) : -Infinity);
  const end = meter.lastMs != null ? meter.lastMs + 3_600_000 : (meter.activeTo ? endOfDayMs(meter.activeTo, offsetMin) : Infinity);
  return { start, end };
}

function classifyMeters(snapshot, building) {
  const candidates = snapshot.meters
    .filter((meter) => meter.served.includes(building.id) && meter.readingCount > 0)
    .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1));
  const primary = [];
  const ignored = [];
  for (const meter of candidates) {
    if (meter.role === 'shared') {
      ignored.push({ meter, reason: 'shared' });
      continue;
    }
    const range = meterRange(meter, building.offsetMin);
    const conflict = primary.find((other) => {
      const otherRange = meterRange(other, building.offsetMin);
      return range.start < otherRange.end && otherRange.start < range.end;
    });
    if (conflict) {
      ignored.push({ meter, reason: 'overlap', conflictingWith: conflict });
      continue;
    }
    primary.push(meter);
  }
  return { primary, ignored };
}

function shiftWindowFor(events, building) {
  return events.filter((ev) => ev.type === 'timezone_shift' && (ev.buildingId === building.id || ev.meterId.startsWith(`${building.id}-`)));
}

function buildGrid(snapshot, building, windowStartKey, windowEndKey) {
  const offset = building.offsetMin;
  const rangeStartMs = startOfDayMs(windowStartKey, offset);
  const rangeEndMs = startOfDayMs(windowEndKey, offset) + DAY_MS;
  const hours = Math.round((rangeEndMs - rangeStartMs) / 3_600_000);
  const { primary, ignored } = classifyMeters(snapshot, building);
  const shifts = shiftWindowFor(snapshot.events, building);

  const buckets = new Array(hours).fill(null);
  const sources = new Array(hours).fill(null);
  const perMeter = [];

  for (const meter of primary) {
    const readings = snapshot.readingsListByMeter?.get(meter.id)
      || snapshot.readings
        .filter((reading) => reading.meterId === meter.id)
        .sort((a, b) => (
          a.digits < b.digits ? -1 : a.digits > b.digits ? 1 : (a.offsetMin - b.offsetMin) || (a.ms - b.ms)
        ));
    if (!readings.length) continue;
    // Backfill supersedes a normal reading that carries the same wall-clock
    // label; counting both would silently double that hour.
    const unique = new Map();
    for (const parsed of readings) {
      const key = `${parsed.meterId}|${parsed.digits}`;
      const existing = unique.get(key);
      if (!existing || (parsed.source === 'backfill' && existing.source !== 'backfill')) {
        unique.set(key, parsed);
      }
    }
    const info = { meter, points: [], shifted: 0, totalKwh: 0 };
    for (const parsed of unique.values()) {
      const ms = parsed.ms;
      let localMs = ms;
      for (const ev of shifts) {
        const startDigits = ev.digits;
        const endDigits = ev.windowEndDigits || ev.digits;
        // The fault is detected from the wall-clock digits the collector wrote
        // (local time labelled with the wrong zone) and only applies to rows
        // that actually carry a foreign zone label.
        if (
          (!startDigits || (parsed.digits >= startDigits && parsed.digits < endDigits))
          && parsed.offsetMin !== offset
        ) {
          // digits_utc = ms + labelledOffset; desired instant = digits_utc - trueOffset.
          localMs = ms + (parsed.offsetMin - offset) * 60_000;
          info.shifted += 1;
          break;
        }
      }
      if (localMs < rangeStartMs || localMs >= rangeEndMs) continue;
      const reading = parsed;
      const multiplier = effectiveMultiplier(snapshot.multipliers, meter.id, localMs);
      const kwh = reading.units * multiplier;
      info.points.push({ ms: localMs, kwh, multiplier, source: reading.source });
      info.totalKwh += kwh;
      const index = Math.floor((localMs - rangeStartMs) / 3_600_000);
      if (index < 0 || index >= hours) continue;
      if (buckets[index] == null) {
        buckets[index] = kwh;
      } else {
        buckets[index] += kwh;
        if (sources[index] !== 'backfill' && reading.source === 'backfill') {
          // mixed hours count as observed, but backfill is still reported per day
        }
      }
      if (sources[index] == null || reading.source === 'imputed' || reading.source === 'backfill') {
        const rank = { meter: 0, imputed: 1, backfill: 1 };
        if (sources[index] == null || rank[reading.source] > rank[sources[index]]) {
          sources[index] = reading.source;
        }
      }
    }
    perMeter.push(info);
  }

  const series = [];
  for (let index = 0; index < hours; index += 1) {
    const ms = rangeStartMs + index * 3_600_000;
    series.push({
      index,
      ms,
      date: dateKey(ms, offset),
      hour: Math.round(((ms + offset * 60_000) % DAY_MS) / 3_600_000),
      kwh: buckets[index],
      source: sources[index],
    });
  }
  return { series, primary, ignored, shifts, rangeStartMs, rangeEndMs };
}

function buildDaily(snapshot, building, series, startKey, endKey) {
  const byDate = new Map();
  for (const point of series) {
    if (!byDate.has(point.date)) {
      byDate.set(point.date, { kwh: 0, expected: 0, present: 0, imputed: 0, backfilled: 0, peak: 0, peakHour: null, peakMs: null });
    }
    const day = byDate.get(point.date);
    day.expected += 1;
    if (point.kwh == null) continue;
    day.present += 1;
    day.kwh += point.kwh;
    if (point.source === 'imputed') day.imputed += 1;
    if (point.source === 'backfill') day.backfilled += 1;
    if (point.kwh > day.peak) {
      day.peak = point.kwh;
      day.peakHour = point.hour;
      day.peakMs = point.ms;
    }
  }

  const dates = eachDate(startKey, endKey);
  const daily = [];
  for (const date of dates) {
    const hoursRow = snapshot.hours.get(`${building.id}|${date}`);
    const weather = snapshot.weather.get(date);
    const seen = byDate.get(date);
    const partial = seen && seen.present < seen.expected;
    const reasons = [];
    if (!seen) reasons.push('无读数');
    else if (partial) reasons.push(`缺 ${seen.expected - seen.present} 小时读数`);
    if (!weather) reasons.push('缺天气');
    if (!hoursRow) reasons.push('缺营业时段');
    const valid = Boolean(seen) && !partial && Boolean(weather) && Boolean(hoursRow);
    // `kwh` is only a day total when every hour was observed; a partial sum is
    // kept in `observed` but must never be compared with a complete day.
    const readingsComplete = Boolean(seen) && !partial;
    daily.push({
      date,
      buildingId: building.id,
      area: building.area,
      valid,
      reason: reasons.join('；'),
      kwh: readingsComplete ? seen.kwh : null,
      maxHourKwh: seen ? seen.peak : null,
      peakHour: seen ? seen.peakHour : null,
      peakMs: seen ? seen.peakMs : null,
      imputedHours: seen ? seen.imputed : 0,
      backfilledHours: seen ? seen.backfilled : 0,
      missingHours: seen ? seen.expected - seen.present : 24,
      presentHours: seen ? seen.present : 0,
      tempMean: weather ? weather.tempMean : null,
      hours: hoursRow ? hoursRow.hours : null,
      closed: hoursRow ? hoursRow.closed : null,
      observed: seen ? seen.kwh : 0,
    });
  }
  return daily;
}

function runIndex(primary, ignored, offset) {
  return primary.map((meter) => ({
    id: meter.id,
    label: meter.label,
    role: meter.role,
    from: meter.firstMs != null ? dateKey(meter.firstMs, offset) : meter.activeFrom,
    to: meter.lastMs != null ? dateKey(meter.lastMs, offset) : meter.activeTo,
  })).concat(ignored.map((entry) => ({
    id: entry.meter.id,
    label: entry.meter.label,
    role: entry.meter.role,
    from: entry.meter.firstMs != null ? dateKey(entry.meter.firstMs, offset) : entry.meter.activeFrom,
    to: entry.meter.lastMs != null ? dateKey(entry.meter.lastMs, offset) : entry.meter.activeTo,
    ignored: entry.reason,
  })));
}

function analysisWindow(options) {
  return {
    start: options.baselineStart < options.rangeStart ? options.baselineStart : options.rangeStart,
    end: options.baselineEnd > options.rangeEnd ? options.baselineEnd : options.rangeEnd,
  };
}

function windowOverlaps(affected, window) {
  return affected.start <= window.end && affected.end >= window.start;
}

function baselineOverlaps(affected, options) {
  return affected.start <= options.baselineEnd && affected.end >= options.baselineStart;
}

/**
 * Analyse one building over the union of the baseline and reporting windows.
 * Exported so a backfill can re-run just the affected buildings. When
 * `previousSeries` is supplied the returned series keeps every hour outside
 * the affected window untouched (backfill never rewrites unrelated hours).
 */
export function analyzeBuilding(snapshot, options, building, overrides = {}) {
  const fullWindow = analysisWindow(options);
  const window = overrides.window || fullWindow;
  const { start: windowStart, end: windowEnd } = window;
  const offset = building.offsetMin;
  const grid = buildGrid(snapshot, building, windowStart, windowEnd);
  let daily = buildDaily(snapshot, building, grid.series, windowStart, windowEnd);

  let series = grid.series;
  if (overrides.previousSeries || overrides.previousDaily) {
    // Keep untouched days/hours from the previous run so a partial recompute
    // never loses data outside the affected window.
    const previousSeries = overrides.previousSeries || [];
    const byMs = new Map(previousSeries.map((point) => [point.ms, point]));
    for (const point of grid.series) byMs.set(point.ms, point);
    series = [...byMs.values()]
      .filter((point) => point.date >= fullWindow.start && point.date <= fullWindow.end)
      .sort((a, b) => a.ms - b.ms)
      .map((point, index) => ({ ...point, index }));

    if (overrides.previousDaily) {
      const byDate = new Map(overrides.previousDaily.map((day) => [day.date, day]));
      for (const day of daily) byDate.set(day.date, day);
      daily = [...byDate.values()]
        .filter((day) => day.date >= fullWindow.start && day.date <= fullWindow.end)
        .sort((a, b) => (a.date < b.date ? -1 : 1));
    }
  }

  const enabled = {
    baselineStart: options.baselineStart,
    baselineEnd: options.baselineEnd,
    rangeStart: options.rangeStart,
    rangeEnd: options.rangeEnd,
  };
  const baselineDays = daily.filter((day) => day.date >= enabled.baselineStart && day.date <= enabled.baselineEnd);
  const reportDays = daily.filter((day) => day.date >= enabled.rangeStart && day.date <= enabled.rangeEnd);

  const model = overrides.model || fitBaselineModel(baselineDays);
  const baselineAgg = aggregate(baselineDays);
  const reportAgg = aggregate(reportDays);
  const reportDecomp = decomposeDays(model, reportDays);
  const baselineDecomp = decomposeDays(model, baselineDays);

  const normalizedDays = reportDays.map((day) => ({
    ...day,
    normalizedKwh: normalizeDay(model, day),
  }));

  const abnormalities = model.ok ? findAbnormalDays(reportDays, model) : [];
  const extrapolatedDays = extrapolationFlags(model, reportDays);
  const pseudoGrid = { primary: grid.primary, ignored: grid.ignored };
  const issues = collectIssues({ snapshot, building, grid: pseudoGrid, daily, model, abnormalities, options });

  const correctedPct = model.ok && reportAgg.usableDays
    ? relativeDelta(baselineAgg.meanEnergy, reportDecomp.normalized)
    : NaN;

  return {
    building,
    offset,
    daily,
    baselineDays,
    reportDays,
    normalizedDays,
    baselineAgg,
    reportAgg,
    model,
    decomposition: reportDecomp,
    baselineDecomposition: baselineDecomp,
    correctedMeanKwh: reportDecomp.normalized,
    correctedPct,
    rawPct: model.ok && baselineAgg.usableDays ? relativeDelta(baselineAgg.meanEnergy, reportAgg.meanEnergy) : NaN,
    weatherPct: model.ok && baselineAgg.usableDays ? relativeDelta(baselineAgg.meanEnergy, reportAgg.meanEnergy - reportDecomp.weatherEffect) : NaN,
    schedulePct: model.ok && baselineAgg.usableDays ? relativeDelta(baselineAgg.meanEnergy, reportAgg.meanEnergy - reportDecomp.scheduleEffect) : NaN,
    abnormalities,
    extrapolatedDays,
    issues,
    meters: runIndex(grid.primary, grid.ignored, offset),
    perMeter: grid.perMeter,
    shifts: grid.shifts,
    series,
    excludedDays: daily.filter((day) => !day.valid),
    ignoredMeters: grid.ignored,
  };
}

export function analyze(snapshot, options) {
  const window = analysisWindow(options);
  const results = snapshot.buildings.map((building) => analyzeBuilding(snapshot, options, building, { window }));
  return buildAnalysis(options, results);
}

function buildAnalysis(options, results) {
  return {
    options,
    results,
    byId: new Map(results.map((result) => [result.building.id, result])),
    totals: portfolioTotals(results),
  };
}

/**
 * Recompute only the affected reporting days for one building.
 *
 * The baseline model is reused when the backfill does not touch the baseline
 * window; otherwise the model is refitted and the whole reporting period is
 * normalised again (a re-fitted baseline changes every normalised day, so a
 * partial update would leave stale numbers on screen).
 */
export function reanalyzeBuilding(snapshot, options, previous, affected) {
  const fullWindow = analysisWindow(options);
  const windowStart = affected.start > fullWindow.start ? affected.start : fullWindow.start;
  const windowEnd = affected.end < fullWindow.end ? affected.end : fullWindow.end;
  if (windowStart > windowEnd || !windowOverlaps({ start: windowStart, end: windowEnd }, fullWindow)) {
    return { result: previous, recomputed: { start: windowStart, end: windowEnd, days: 0, baseline: false }, modelRefit: false };
  }

  const baselineTouched = baselineOverlaps({ start: windowStart, end: windowEnd }, options);
  const window = baselineTouched ? fullWindow : { start: windowStart, end: windowEnd };
  const next = analyzeBuilding(snapshot, options, previous.building, {
    window,
    previousSeries: previous.series,
    previousDaily: previous.daily,
    model: baselineTouched ? null : previous.model,
  });

  // The grid only saw affected days, so anomaly/residual findings and issue
  // rows outside it come from the previous run.
  const abnormalities = mergeByDate(previous.abnormalities, next.abnormalities, windowStart, windowEnd, baselineTouched);
  next.abnormalities = abnormalities;
  next.extrapolatedDays = mergeByDate(
    previous.extrapolatedDays || [], next.extrapolatedDays, windowStart, windowEnd, baselineTouched,
  );
  const mergedIssues = mergeIssues(previous.issues, next.issues, windowStart, windowEnd, baselineTouched);
  next.issues = mergedIssues;

  // A refitted baseline changes every normalised day, so the whole reporting
  // period is redone; report that span rather than the (possibly empty) overlap
  // between the backfilled dates and the compare window.
  const days = baselineTouched
    ? eachDate(options.rangeStart, options.rangeEnd).length
    : eachDate(windowStart, windowEnd).filter(
      (date) => date >= options.rangeStart && date <= options.rangeEnd,
    ).length;
  return {
    result: next,
    recomputed: {
      start: window.start,
      end: window.end,
      days,
      baseline: baselineTouched,
    },
    modelRefit: baselineTouched,
  };
}

/**
 * Issues are sorted newest first. A partial recompute may only see affected
 * days inside its grid, so keep the previous issue rows that fall outside the
 * recomputed window and let the fresh rows win inside it.
 */
function mergeIssues(previousIssues, nextIssues, start, end, baselineTouched) {
  if (baselineTouched) return nextIssues;
  const inWindow = (issue) => {
    const date = issue.date || '';
    if (date >= start && date <= end) return true;
    if (issue.dateEnd && date <= end && issue.dateEnd >= start) return true;
    return false;
  };
  const outside = previousIssues.filter((issue) => !inWindow(issue));
  const map = new Map();
  for (const issue of nextIssues) {
    const key = `${issue.type}|${issue.date}|${issue.meterId || ''}|${issue.detail}`;
    map.set(key, issue);
  }
  for (const issue of outside) {
    const key = `${issue.type}|${issue.date}|${issue.meterId || ''}|${issue.detail}`;
    if (!map.has(key)) map.set(key, issue);
  }
  return [...map.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Same idea as mergeIssues, keyed on `date`, newest first. */
function mergeByDate(previousItems, nextItems, start, end, baselineTouched) {
  if (baselineTouched) return nextItems;
  const outside = previousItems.filter((item) => !(item.date >= start && item.date <= end));
  const map = new Map();
  for (const item of nextItems) map.set(item.date, item);
  for (const item of outside) if (!map.has(item.date)) map.set(item.date, item);
  return [...map.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Swap re-analysed buildings into an existing analysis and refresh totals. */
export function mergeResults(analysis, replacements) {
  const byId = new Map(replacements.map((result) => [result.building.id, result]));
  const results = analysis.results.map((result) => byId.get(result.building.id) || result);
  return buildAnalysis(analysis.options, results);
}

function findAbnormalDays(days, model) {
  const tempTolerance = 3;
  // Work in ratio space (actual / model prediction) and compare each day with
  // its local neighbourhood. A retrofit or a new load shifts *every* following
  // day, so a global residual threshold would report the whole post-retrofit
  // period as "abnormal". The local median absorbs that step and leaves only
  // genuine short excursions (faults, meter errors, one-off events).
  const usable = [];
  for (const day of days) {
    if (!day.valid) continue;
    // Only judge days the baseline covers; when the model is extrapolating in
    // temperature *or* schedule, a residual is not evidence of an anomaly.
    const tempInRange = day.tempMean >= model.baseTempMin - tempTolerance
      && day.tempMean <= model.baseTempMax + tempTolerance;
    // Also require the day's business hours to sit inside the baseline range.
    // A closed holiday against a baseline of open weekdays is a schedule
    // regime the model was never fitted on, not a metering anomaly.
    const hoursInRange = day.hours >= model.baseHoursMin - 0.5 && day.hours <= model.baseHoursMax + 0.5;
    if (!tempInRange || !hoursInRange) continue;
    const predicted = model.predict(day);
    if (!(predicted > 0) || !(day.kwh > 0)) continue;
    usable.push({ day, predicted, ratio: day.kwh / predicted });
  }
  if (usable.length < 5) return [];

  const flagged = [];
  const halfWindow = 14;
  for (let index = 0; index < usable.length; index += 1) {
    const current = usable[index];
    const neighbours = [];
    for (let offset = -halfWindow; offset <= halfWindow; offset += 1) {
      if (offset === 0) continue;
      const other = usable[index + offset];
      if (other) neighbours.push(other.ratio);
    }
    if (neighbours.length < 5) continue;
    const center = median(neighbours);
    const scale = Math.max(1.4826 * mad(neighbours), 0.01);
    const z = robustZ(current.ratio, center, scale);
    const relative = current.ratio / center - 1;
    // Require both statistical separation from the local level and a material
    // size, so ordinary day-to-day variation is not reported as an anomaly.
    if (Math.abs(z) >= 3 && Math.abs(relative) >= 0.12) {
      flagged.push({
        date: current.day.date,
        kwh: current.day.kwh,
        predicted: current.predicted,
        residual: current.day.kwh - current.predicted,
        relative,
        z,
        direction: z > 0 ? '高于模型预测' : '低于模型预测',
      });
    }
  }
  return flagged;
}

const EVENT_TITLES = {
  replacement: '电表更换',
  multiplier_change: '倍率调整',
  timezone_shift: '时区错位',
  missing: '缺测',
  backfill: '补录',
  overlap: '重叠计量',
  imputation: '估算补值',
};

function collectIssues({ snapshot, building, grid, daily, model, abnormalities, options }) {
  const offset = building.offsetMin;
  const issues = [];
  const seen = new Set();
  const add = (issue) => {
    const key = `${issue.type}|${issue.date}|${issue.meterId || ''}|${issue.detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
  };

  for (const entry of grid.ignored) {
    const meter = entry.meter;
    const from = meter.firstMs != null ? dateKey(meter.firstMs, offset) : meter.activeFrom;
    const to = meter.lastMs != null ? dateKey(meter.lastMs, offset) : meter.activeTo;
    if (entry.reason === 'shared') {
      add({
        type: 'overlap',
        severity: 'warning',
        date: from,
        dateEnd: to,
        meterId: meter.id,
        title: '共用表不并入楼栋总量',
        detail: `${meter.label} 同时服务 ${meter.served.join(' 与 ')}；各楼合计不含此表，避免重复统计。如需分摊请单独核定分摊比例。`,
      });
    } else {
      add({
        type: 'overlap',
        severity: 'warning',
        date: from,
        dateEnd: to,
        meterId: meter.id,
        title: '重叠计量已去重',
        detail: `${meter.label} 与优先级更高的 ${entry.conflictingWith.id} 在 ${from}–${to} 同时计量；汇总已按优先级只取主表，未计入 ${meter.label}。`,
      });
    }
  }

  for (const ev of snapshot.events) {
    const serves = ev.buildingId
      ? ev.buildingId === building.id || ev.buildingId.split('|').includes(building.id)
      : snapshot.meterById.get(ev.meterId)?.served.includes(building.id);
    if (!serves) continue;
    if (!EVENT_TITLES[ev.type]) continue;
    const evDate = dateKey(ev.ms, offset);
    if (evDate < options.baselineStart && evDate < options.rangeStart) continue;
    if (evDate > options.baselineEnd && evDate > options.rangeEnd) continue;
    add({
      type: ev.type,
      severity: ev.type === 'missing' ? 'critical' : ev.type === 'timezone_shift' ? 'warn' : 'info',
      date: evDate,
      meterId: ev.meterId,
      title: EVENT_TITLES[ev.type],
      detail: ev.note,
    });
  }

  for (const day of daily) {
    if (day.date < options.rangeStart && day.date < options.baselineStart) continue;
    if (day.date > options.rangeEnd && day.date > options.baselineEnd) continue;
    if (!day.valid && day.missingHours > 0) {
      add({
        type: 'missing',
        severity: 'critical',
        date: day.date,
        title: '缺测，未按零处理',
        detail: `缺 ${day.missingHours} 小时读数，日合计视为不完整并剔除出基线/对比，不按 0 计入。`,
      });
    }
    if (day.valid && day.imputedHours > 0) {
      add({
        type: 'imputed',
        severity: 'warning',
        date: day.date,
        title: '含估算补值',
        detail: `${day.imputedHours} 小时为估算补值，已在曲线中以虚线/标记显示。`,
      });
    }
    if (day.valid && day.backfilledHours > 0) {
      add({
        type: 'backfill',
        severity: 'info',
        date: day.date,
        title: '含补录读数',
        detail: `${day.backfilledHours} 小时读数来自补录文件，仅重算受影响时段。`,
      });
    }
  }

  for (const item of abnormalities) {
    add({
      type: 'abnormal',
      severity: 'warning',
      date: item.date,
      title: '异常日期',
      detail: `${item.direction}：实际 ${roundTo(item.kwh)} kWh，模型预测 ${roundTo(item.predicted)} kWh（稳健 z = ${roundTo(item.z, 1)}）。`,
    });
  }

  return issues.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

function portfolioTotals(results) {
  let basis = 0;
  let actual = 0;
  let normalized = 0;
  let area = 0;
  for (const result of results) {
    const weight = result.reportAgg.usableDays;
    if (!result.model.ok || !weight) continue;
    basis += result.baselineAgg.meanEnergy / result.building.area * weight;
    actual += result.reportAgg.meanEnergy / result.building.area * weight;
    normalized += result.decomposition.normalized / result.building.area * weight;
    area += weight;
  }
  return {
    normalizedIntensity: area ? normalized / area : NaN,
    actualIntensity: area ? actual / area : NaN,
    baselineIntensity: area ? basis / area : NaN,
  };
}

export function issueSummary(issues) {
  const counts = new Map();
  for (const issue of issues) {
    counts.set(issue.type, (counts.get(issue.type) || 0) + 1);
  }
  return ISSUE_ORDER.filter((type) => counts.has(type)).map((type) => ({ type, count: counts.get(type), ...ISSUE_META[type] }));
}

export function monthBuckets(days) {
  const buckets = new Map();
  for (const day of days) {
    const key = day.date.slice(0, 7);
    if (!buckets.has(key)) buckets.set(key, { key, days: [], valid: [], normalized: [] });
    const bucket = buckets.get(key);
    bucket.days.push(day);
    if (day.valid) bucket.valid.push(day);
    if (Number.isFinite(day.normalizedKwh)) bucket.normalized.push(day.normalizedKwh);
  }
  return [...buckets.values()].map((bucket) => ({
    key: bucket.key,
    label: `${Number(bucket.key.slice(5))}月`,
    actual: mean(bucket.valid.map((day) => day.kwh)),
    normalized: mean(bucket.normalized),
    days: bucket.days.length,
    usableDays: bucket.valid.length,
  }));
}
