/**
 * Render functions for the dashboard cards. Plain DOM + SVG only; every string
 * that originates from an imported file is inserted with textContent.
 */

import {
  attachCrosshair, createTooltip, drawBaseline, drawDot, drawGapBands, drawSegmentedLine,
  drawXLabels, drawYAxis, el, legend, niceTicks, scaffold, xBandScale, xPointScale, yScale,
} from './charts.js';
import { ISSUE_META, issueSummary } from './analysis.js';
import { formatOffset } from './time.js';
import {
  hours as fmtHours, intensity, number, pct, shortestDate, slashDate, weekdayLabel,
} from './format.js';

const BUILDING_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-1-soft)'];

export function buildingColor(index) {
  return BUILDING_COLORS[index % BUILDING_COLORS.length];
}

function clear(host) {
  if (!host) return;
  while (host.firstChild) host.removeChild(host.firstChild);
}

function text(tag, className, content, parent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content != null) node.textContent = content;
  if (parent) parent.appendChild(node);
  return node;
}

function emptyState(host, message) {
  return text('div', 'empty', message, host);
}

// ---------------------------------------------------------------------------
// Header pills, notices, span note
// ---------------------------------------------------------------------------

export function renderDataPill(label, tone = 'ok') {
  const pill = document.getElementById('data-pill');
  pill.classList.toggle('warn', tone !== 'ok');
  document.getElementById('data-pill-text').textContent = label;
}

export function renderQualityPill(analysis) {
  const count = analysis.results.reduce((total, result) => total + result.issues.length, 0);
  const criticals = analysis.results.reduce(
    (total, result) => total + result.issues.filter((issue) => issue.severity === 'critical').length,
    0,
  );
  document.getElementById('quality-count').textContent = number(count);
  document.getElementById('quality-pill').classList.toggle('warn', criticals > 0);
  document.getElementById('quality-pill').title = criticals
    ? `当前时段有 ${criticals} 条严重计量提示（缺测等）`
    : '当前时段内的计量问题数量';
}

export function renderNotices(host, notices) {
  clear(host);
  for (const notice of notices) {
    const box = text('div', `notice ${notice.tone || ''}`, null, host);
    text('span', 'ico', notice.tone === 'critical' ? '!' : notice.tone === 'warning' ? '△' : 'i', box)
      .setAttribute('aria-hidden', 'true');
    const body = text('div', 'grow', null, box);
    text('div', '', notice.title, body).style.fontWeight = '600';
    if (notice.body) text('div', '', notice.body, body);
    if (notice.actionLabel && notice.onAction) {
      const button = text('button', 'btn small', notice.actionLabel, box);
      button.type = 'button';
      button.addEventListener('click', notice.onAction);
    }
  }
}

export function renderSpanNote(host, value) {
  host.textContent = value;
}

// ---------------------------------------------------------------------------
// KPI row
// ---------------------------------------------------------------------------

/**
 * Effects are expressed as a share of baseline energy intensity, matching the
 * hero change: raw change + weather + schedule must equal the corrected change
 * exactly, otherwise the KPI row contradicts itself. Each building contributes
 * in proportion to its usable days, and energy effects are divided by floor
 * area so the portfolio weights are intensity-based like `totals`.
 */
function portfolioEffect(analysis, key) {
  const baselineIntensity = analysis.totals.baselineIntensity;
  if (!Number.isFinite(baselineIntensity) || baselineIntensity <= 0) return NaN;
  let sum = 0;
  let weight = 0;
  for (const result of analysis.results) {
    if (!result.model.ok) continue;
    const days = result.reportAgg.usableDays;
    if (!days) continue;
    const value = key === 'correction'
      ? result.decomposition.normalized - result.reportAgg.meanEnergy
      : result.decomposition[key];
    if (!Number.isFinite(value)) continue;
    sum += (value / result.building.area) * days;
    weight += days;
  }
  if (!weight) return NaN;
  return sum / weight / baselineIntensity;
}

export function renderKpis(analysis) {
  const totals = analysis.totals;
  const results = analysis.results;
  const baselineIntensity = totals.baselineIntensity;
  const correctedIntensity = totals.normalizedIntensity;
  const actualIntensity = totals.actualIntensity;

  const change = Number.isFinite(baselineIntensity) && baselineIntensity > 0
    ? (correctedIntensity - baselineIntensity) / baselineIntensity
    : NaN;
  const rawChange = Number.isFinite(baselineIntensity) && baselineIntensity > 0
    ? (actualIntensity - baselineIntensity) / baselineIntensity
    : NaN;

  const heroValue = document.getElementById('hero-value');
  heroValue.textContent = pct(change);
  heroValue.style.color = Number.isFinite(change) && change < -0.005
    ? 'var(--good-text)'
    : Number.isFinite(change) && change > 0.005 ? 'var(--critical)' : '';

  const heroDelta = document.getElementById('hero-delta');
  clear(heroDelta);
  heroDelta.append(
    document.createTextNode('同等天气与营业时长下校正 '),
    text('strong', '', pct(change), heroDelta),
    document.createTextNode('；未校正的原始变化 '),
    text('span', rawChange < 0 ? 'down' : 'up', pct(rawChange), heroDelta),
  );

  const usableReport = results.reduce((total, result) => total + result.reportAgg.usableDays, 0);
  const usableBaseline = results.reduce((total, result) => total + result.baselineAgg.usableDays, 0);
  const excluded = results.reduce((total, result) => total + result.reportAgg.excludedDays, 0);
  const modelFailures = results.filter((result) => !result.model.ok).length;
  document.getElementById('hero-foot').textContent =
    `对比 ${usableReport} 个完整日 · 基线 ${usableBaseline} 个完整日`
    + (excluded ? ` · 剔除 ${excluded} 个缺测/不完整日（不按 0）` : '')
    + (modelFailures ? ` · ${modelFailures} 栋模型不可用` : '');

  document.getElementById('kpi-intensity').textContent = intensity(correctedIntensity);
  document.getElementById('kpi-intensity-delta').textContent =
    `基线 ${intensity(baselineIntensity)} · 实际 ${intensity(actualIntensity)} kWh/m²·日`;

  const correction = portfolioEffect(analysis, 'correction');
  const weather = portfolioEffect(analysis, 'weatherEffect');
  const schedule = portfolioEffect(analysis, 'scheduleEffect');
  document.getElementById('kpi-effects').textContent = pct(correction);
  document.getElementById('kpi-effects-delta').textContent =
    `天气 ${pct(weather)} · 营业时长 ${pct(schedule)}（占基线用能）`;
  document.getElementById('kpi-effects-foot').textContent =
    '负值表示对比时段更热或营业更长，已从实际用能中扣除后再比较；原始变化、天气与营业时长三项相加即校正后变化';

  // Peak: sum of per-building daily peaks, compared with the baseline window.
  const peakOf = (key) => {
    const byDate = new Map();
    for (const result of results) {
      for (const day of result[key]) {
        if (!day.valid || !Number.isFinite(day.maxHourKwh)) continue;
        byDate.set(day.date, (byDate.get(day.date) ?? 0) + day.maxHourKwh);
      }
    }
    let max = 0;
    for (const value of byDate.values()) max = Math.max(max, value);
    return max;
  };
  const reportPeak = peakOf('reportDays');
  const baselinePeak = peakOf('baselineDays');
  document.getElementById('kpi-peak').textContent = reportPeak ? `${number(reportPeak)} kWh` : '—';
  document.getElementById('kpi-peak-delta').textContent = baselinePeak && reportPeak
    ? `基线最大 ${number(baselinePeak)} kWh · 比基线${reportPeak >= baselinePeak ? '高' : '低'} ${Math.abs((reportPeak - baselinePeak) / baselinePeak * 100).toFixed(1)}%`
    : '';

  drawSparkline(document.getElementById('hero-spark'), results);
}

/** Trend of corrected portfolio intensity across the compare window. */
function drawSparkline(host, results) {
  clear(host);
  const byDate = new Map();
  for (const result of results) {
    for (const day of result.normalizedDays) {
      if (!Number.isFinite(day.normalizedKwh)) continue;
      if (!byDate.has(day.date)) byDate.set(day.date, { sum: 0, count: 0 });
      const entry = byDate.get(day.date);
      entry.sum += day.normalizedKwh / result.building.area;
      entry.count += 1;
    }
  }
  const all = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, entry]) => ({ date, value: entry.sum / entry.count }));
  if (all.length < 2) return;

  const width = Math.max(120, host.clientWidth || 220);
  const height = 34;
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, 'aria-hidden': 'true' }, host);
  const step = Math.max(1, Math.floor(all.length / 12));
  const points = [];
  for (let i = 0; i < all.length; i += step) points.push(all[i]);
  if (points[points.length - 1]?.date !== all[all.length - 1].date) points.push(all[all.length - 1]);

  const min = Math.min(...points.map((point) => point.value));
  const max = Math.max(...points.map((point) => point.value));
  const scaleY = yScale(min, max, height - 8);
  const scaleX = xPointScale(points.length, width - 6);
  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${(scaleX.x(index) + 3).toFixed(2)},${(scaleY(point.value) + 4).toFixed(2)}`)
    .join(' ');
  el('path', { d: path, fill: 'none', stroke: 'var(--text-muted)', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }, svg);
  const last = points.length - 1;
  el('circle', {
    cx: scaleX.x(last) + 3, cy: scaleY(points[last].value) + 4, r: 3.2,
    fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2,
  }, svg);
}

// ---------------------------------------------------------------------------
// Portfolio table
// ---------------------------------------------------------------------------

export function renderPortfolioTable(host, analysis, selectedId, onSelect) {
  clear(host);
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const columns = [
    '楼宇', '面积 m²', '基线强度', '实际强度（未校正）', '校正后强度', '校正后变化',
    '天气贡献', '营业时长贡献', '日峰值 基线 → 对比', '数据状态',
  ];
  for (const label of columns) {
    const th = text('th', '', label, headRow);
    if (label !== '楼宇') th.style.textAlign = 'right';
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  analysis.results.forEach((result, index) => {
    const row = document.createElement('tr');
    row.style.cursor = 'pointer';
    if (result.building.id === selectedId) row.style.background = 'var(--series-1-wash)';
    row.tabIndex = 0;
    const select = () => onSelect(result.building.id);
    row.addEventListener('click', select);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select();
      }
    });

    const nameCell = document.createElement('td');
    const dot = document.createElement('span');
    dot.style.cssText = 'display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;background:'
      + buildingColor(index);
    nameCell.appendChild(dot);
    nameCell.append(document.createTextNode(`${result.building.id} · ${result.building.name}`));
    row.appendChild(nameCell);

    row.appendChild(text('td', '', number(result.building.area)));
    row.appendChild(text('td', '', intensity(result.baselineAgg.meanIntensity)));
    row.appendChild(text('td', '', intensity(result.reportAgg.meanIntensity)));
    const corrected = result.model.ok ? result.correctedMeanKwh / result.building.area : NaN;
    row.appendChild(text('td', '', intensity(corrected)));

    const changeCell = text('td', '', pct(result.correctedPct));
    if (Number.isFinite(result.correctedPct)) {
      if (result.correctedPct <= -0.02) changeCell.classList.add('num-good');
      else if (result.correctedPct >= 0.02) changeCell.classList.add('num-bad');
    }
    row.appendChild(changeCell);

    row.appendChild(text('td', '', effectPct(result, 'weatherEffect')));
    row.appendChild(text('td', '', effectPct(result, 'scheduleEffect')));
    row.appendChild(text('td', '', peakText(result)));

    const statusCell = document.createElement('td');
    statusCell.style.textAlign = 'right';
    const parts = [`${result.reportAgg.usableDays}/${result.reportAgg.days} 完整`];
    if (result.reportAgg.excludedDays) parts.push(`缺 ${result.reportAgg.excludedDays} 天`);
    if (result.abnormalities.length) parts.push(`异常 ${result.abnormalities.length} 天`);
    statusCell.textContent = parts.join(' · ');
    row.appendChild(statusCell);

    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  host.appendChild(table);

  const note = text('p', 'note-line', null, host);
  note.textContent = '强度 = 日用电量 ÷ 建筑面积。校正后变化为正表示用能增加，为负表示减少；天气贡献与营业时长贡献按基线模型拆解，两者相加等于校正总额。';
}

function effectPct(result, key) {
  if (!result.model.ok) return '—';
  const base = result.baselineAgg.meanEnergy;
  if (!Number.isFinite(base) || base <= 0) return '—';
  const value = result.decomposition[key];
  if (!Number.isFinite(value)) return '—';
  return pct(value / base);
}

function peakText(result) {
  const baseline = result.baselineAgg.meanPeak;
  const compare = result.reportAgg.meanPeak;
  if (!Number.isFinite(baseline) || !Number.isFinite(compare)) return '—';
  return `${number(baseline)} → ${number(compare)}`;
}

// ---------------------------------------------------------------------------
// Building chips + peak chart
// ---------------------------------------------------------------------------

export function renderBuildingTabs(host, analysis, selectedId, onSelect) {
  clear(host);
  analysis.results.forEach((result, index) => {
    const button = text('button', 'chip', null, host);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(result.building.id === selectedId));
    const swatch = text('span', 'swatch', '', button);
    swatch.style.background = buildingColor(index);
    text('span', '', `${result.building.id} · ${result.building.name}`, button);
    text('span', 'meta', Number.isFinite(result.correctedPct) ? pct(result.correctedPct) : '模型不可用', button);
    if (result.abnormalities.length) {
      const flag = text('span', 'flag', '△', button);
      flag.title = `${result.abnormalities.length} 个异常日期`;
    }
    button.addEventListener('click', () => onSelect(result.building.id));
  });
}

export function renderPeakChart(chartHost, legendHost, analysis, selectedId) {
  clear(chartHost);
  clear(legendHost);
  const first = analysis.results[0];
  if (!first) {
    emptyState(chartHost, '没有可显示的楼宇。');
    return;
  }
  const days = first.reportDays.map((day) => day.date);
  if (!days.length) {
    emptyState(chartHost, '对比时段没有日期。');
    return;
  }

  const series = analysis.results.map((result, index) => ({
    result,
    color: buildingColor(index),
    values: result.reportDays.map((day) => ({
      date: day.date,
      value: day.valid ? day.maxHourKwh : null,
      abnormal: result.abnormalities.some((item) => item.date === day.date),
    })),
  }));

  const size = scaffold(chartHost, {
    height: 250,
    margin: { top: 20, right: 16, bottom: 34, left: 60 },
    ariaLabel: '各楼宇每日最高小时负荷柱状图，缺测日留空',
  });
  const { svg, plot, plotW, plotH, margin } = size;
  const tooltip = createTooltip(chartHost);

  const defs = el('defs', {}, svg);
  const pattern = el('pattern', { id: 'peak-gap-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse' }, defs);
  el('path', { d: 'M0,6 L6,0', stroke: 'var(--gridline)', 'stroke-width': 1 }, pattern);

  const allValues = series.flatMap((entry) => entry.values.map((value) => value.value)).filter((v) => Number.isFinite(v));
  const max = allValues.length ? Math.max(...allValues) : 1;
  const ticks = niceTicks(0, max * 1.06, 4);
  const top = ticks[ticks.length - 1] || max;
  const scaleY = yScale(0, top, plotH);
  drawYAxis(plot, { ticks, scale: scaleY, plotW });
  drawBaseline(plot, plotW, scaleY(0));

  const bands = xBandScale(plot, plotW, days.length, 0.18);
  const barW = Math.max(2, Math.min(22, (bands.band / Math.max(1, series.length)) * 0.8));
  const groupInner = Math.min(bands.band, barW * series.length + (series.length - 1));

  const hovering = (date) => {
    const rows = series.map((entry) => {
      const point = entry.values.find((value) => value.date === date);
      return {
        label: `${entry.result.building.id} · ${entry.result.building.name}`,
        value: point && point.value != null ? `${number(point.value)} kWh` : '缺测（不按 0）',
        color: entry.color,
      };
    });
    const day = first.reportDays.find((item) => item.date === date);
    return {
      title: `${slashDate(date)} ${weekdayLabel(date)}`,
      rows,
      note: day
        ? `室外均温 ${day.tempMean != null ? day.tempMean.toFixed(1) : '—'} °C · 营业 ${day.hours != null ? fmtHours(day.hours) : '—'} h`
        : '',
    };
  };

  days.forEach((date, dayIndex) => {
    series.forEach((entry, seriesIndex) => {
      const point = entry.values[dayIndex];
      const x = bands.center(dayIndex) - groupInner / 2 + seriesIndex * (barW + 1);
      if (point.value == null) {
        el('rect', {
          x, y: 0, width: barW, height: plotH,
          fill: 'url(#peak-gap-hatch)', stroke: 'var(--gridline)', 'stroke-width': 0.5,
          opacity: entry.result.building.id === selectedId ? 0.9 : 0.45,
        }, plot);
        return;
      }
      const barHeight = Math.max(2, plotH - scaleY(point.value));
      const radius = Math.min(3, barW / 2);
      const y = plotH - barHeight;
      const path = barW <= 4
        ? `M${x},${plotH} L${x},${y} L${x + barW},${y} L${x + barW},${plotH} Z`
        : `M${x},${plotH} L${x},${y + radius} Q${x},${y} ${x + radius},${y} L${x + barW - radius},${y} Q${x + barW},${y} ${x + barW},${y + radius} L${x + barW},${plotH} Z`;
      el('path', {
        d: path,
        fill: point.abnormal ? 'var(--series-2)' : entry.color,
        opacity: entry.result.building.id === selectedId ? 1 : 0.55,
      }, plot);
    });
  });

  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(3, Math.floor(plotW / 56))));
  drawXLabels(plot, {
    plotW,
    plotH,
    labels: days.map((date, index) => ({
      x: bands.center(index),
      text: index % labelEvery === 0 || index === days.length - 1 ? shortestDate(date) : '',
    })),
  });

  const hit = attachCrosshair({
    svg, plot, plotW, plotH, margin, wrap: chartHost, tooltip,
    xOfIndex: Object.assign(
      (localX) => Math.max(0, Math.min(days.length - 1, Math.round((localX / plotW) * (days.length - 1)) || 0)),
      { count: days.length, position: (index) => bands.center(index) },
    ),
    onHover: (index) => {
      const data = hovering(days[index]);
      tooltip.show(data.title, data.rows, data.note);
    },
    onLeave: () => {},
  });
  hit.addEventListener('pointermove', (event) => tooltip.move(event, chartHost));

  legend(legendHost, [
    ...analysis.results.map((result, index) => ({
      label: `${result.building.id} · ${result.building.name}`,
      color: buildingColor(index),
      shape: 'rect',
    })),
    { label: '异常日期', color: 'var(--series-2)', shape: 'rect' },
    { label: '缺测日（留空，不按 0）', border: '1px solid var(--gridline)', shape: 'band' },
  ]);
}

// ---------------------------------------------------------------------------
// Per-building hourly profile
// ---------------------------------------------------------------------------

export function renderProfileHeader(result, options) {
  document.getElementById('profile-title').textContent = `${result.building.id} · ${result.building.name}`;
  document.getElementById('profile-meta').textContent =
    `${result.building.type} · ${number(result.building.area)} m² · ${formatOffset(result.building.offsetMin)} · `
    + `对比 ${slashDate(options.rangeStart)} 至 ${slashDate(options.rangeEnd)}`;
}

export function renderProfileBadges(result) {
  const host = document.getElementById('profile-badges');
  clear(host);
  const summary = issueSummary(result.issues);
  if (!summary.length) {
    text('span', 'badge', '所选时段无计量问题', host);
    return;
  }
  for (const item of summary) {
    const badge = text('span', `badge ${item.severity}`, null, host);
    text('span', 'ico', item.icon, badge).setAttribute('aria-hidden', 'true');
    text('span', '', `${item.label} ${item.count}`, badge);
  }
}

export function renderProfileChart(chartHost, legendHost, result, zoomMode) {
  clear(chartHost);
  clear(legendHost);
  const allDays = result.reportDays.map((day) => day.date);
  const useDays = zoomMode === 'week' ? allDays.slice(-14) : allDays;
  if (!useDays.length) {
    emptyState(chartHost, '所选时段没有数据。');
    return;
  }
  const startDate = useDays[0];
  const endDate = useDays[useDays.length - 1];
  const normalizedByDate = new Map(result.normalizedDays.map((day) => [day.date, day]));

  const hourly = result.series.filter((point) => point.date >= startDate && point.date <= endDate);
  if (!hourly.length) {
    emptyState(chartHost, '该时段没有逐时数据。');
    return;
  }

  const values = hourly.map((point) => {
    const day = normalizedByDate.get(point.date);
    let normalized = null;
    if (day && Number.isFinite(day.normalizedKwh) && Number.isFinite(point.kwh)) {
      // Scale each observed hour by the day's corrected/actual ratio so the
      // hourly curve sums to the daily corrected total exactly and keeps the
      // real load shape. A day with no observed energy has no ratio to apply.
      if (day.kwh > 0) normalized = point.kwh * (day.normalizedKwh / day.kwh);
      else normalized = point.kwh;
    }
    return { ...point, normalized };
  });

  const size = scaffold(chartHost, {
    height: 300,
    margin: { top: 22, right: 18, bottom: 34, left: 62 },
    ariaLabel: '逐小时实际用能与按基线天气和营业时长校正后的曲线',
  });
  const { svg, plot, plotW, plotH, margin } = size;
  const tooltip = createTooltip(chartHost);

  const finite = values.flatMap((point) => [point.kwh, point.normalized]).filter((value) => Number.isFinite(value));
  const max = finite.length ? Math.max(...finite) : 1;
  const ticks = niceTicks(0, max * 1.08, 4);
  const top = ticks[ticks.length - 1] || max;
  const scaleY = yScale(0, top, plotH);
  drawYAxis(plot, { ticks, scale: scaleY, plotW });
  drawBaseline(plot, plotW, scaleY(0));

  const scaleX = xPointScale(values.length, plotW);

  const dayStarts = new Map();
  for (const point of values) {
    if (!dayStarts.has(point.date)) dayStarts.set(point.date, point.index);
  }
  for (const index of dayStarts.values()) {
    el('line', {
      x1: scaleX.x(index), x2: scaleX.x(index), y1: 0, y2: plotH,
      stroke: 'var(--gridline)', 'stroke-width': 1, 'shape-rendering': 'crispEdges',
    }, plot);
  }

  // Missing hours: hatched bands, never interpolated or drawn as zero.
  const gapBands = [];
  let gapStart = null;
  values.forEach((point, index) => {
    if (point.kwh == null && gapStart == null) gapStart = index;
    if (point.kwh != null && gapStart != null) {
      gapBands.push({ start: Math.max(0, gapStart - 0.5), end: index - 0.5 });
      gapStart = null;
    }
  });
  if (gapStart != null) gapBands.push({ start: Math.max(0, gapStart - 0.5), end: values.length - 0.5 });
  if (gapBands.length) {
    drawGapBands(plot, gapBands, (index) => scaleX.x(Math.max(0, Math.min(values.length - 1, index))), plotW, plotH);
  }

  const actualPoints = values.map((point) => ({
    x: scaleX.x(point.index),
    y: point.kwh == null ? null : scaleY(point.kwh),
  }));
  const normalizedPoints = values.map((point) => ({
    x: scaleX.x(point.index),
    y: point.normalized == null ? null : scaleY(point.normalized),
  }));

  drawSegmentedLine(plot, normalizedPoints, 'var(--series-2)', { dash: '5 4', width: 2 });
  drawSegmentedLine(plot, actualPoints, 'var(--series-1)', { width: 2 });

  // Per-hour source markers: imputed = warning dot, backfill = hollow ring.
  for (const point of values) {
    if (point.kwh == null) continue;
    const x = scaleX.x(point.index);
    const y = scaleY(point.kwh);
    if (point.source === 'imputed') {
      drawDot(plot, x, y, 'var(--warning)', 3.4);
    } else if (point.source === 'backfill') {
      el('circle', {
        cx: x, cy: y, r: 3.4, fill: 'var(--surface-1)',
        stroke: 'var(--series-3)', 'stroke-width': 2,
      }, plot);
    }
  }

  // Abnormal days: light wash plus a top-of-plot triangle.
  const abnormalDates = new Map(result.abnormalities.map((item) => [item.date, item]));
  for (const date of useDays) {
    if (!abnormalDates.has(date)) continue;
    const dayPoints = values.filter((point) => point.date === date);
    if (!dayPoints.length) continue;
    const x0 = scaleX.x(dayPoints[0].index);
    const x1 = scaleX.x(dayPoints[dayPoints.length - 1].index);
    el('rect', { x: x0, y: 0, width: Math.max(1, x1 - x0), height: plotH, fill: 'var(--series-2-wash)' }, plot);
    const middle = (x0 + x1) / 2;
    el('path', { d: `M${middle - 4},0 L${middle + 4},0 L${middle},6 Z`, fill: 'var(--series-2)' }, plot);
  }

  const tickEvery = Math.max(1, Math.ceil(useDays.length / Math.max(3, Math.floor(plotW / 64))));
  drawXLabels(plot, {
    plotW,
    plotH,
    labels: useDays
      .filter((date, index) => index % tickEvery === 0 || index === useDays.length - 1)
      .map((date) => ({ x: scaleX.x(dayStarts.get(date)), text: shortestDate(date) }))
      .filter((label) => Number.isFinite(label.x)),
  });

  const tooltipFor = (index) => {
    const point = values[index];
    if (!point) return null;
    const day = normalizedByDate.get(point.date);
    const rows = [
      { label: '实际逐时', value: point.kwh == null ? '缺测（留空）' : `${number(point.kwh, 1)} kWh`, color: 'var(--series-1)' },
      { label: '校正后逐时', value: point.normalized == null ? '不可用' : `${number(point.normalized, 1)} kWh`, color: 'var(--series-2)' },
    ];
    const notes = [];
    if (point.source === 'imputed') notes.push('该小时为估算补值');
    if (point.source === 'backfill') notes.push('该小时为补录读数');
    if (day) {
      notes.push(`日合计 ${day.valid ? `${number(day.kwh)} kWh` : '不完整（不参与对比）'}`);
      notes.push(`均温 ${day.tempMean != null ? day.tempMean.toFixed(1) : '—'} °C · 营业 ${day.hours != null ? fmtHours(day.hours) : '—'} h`);
    }
    return { title: `${point.date} ${String(point.hour).padStart(2, '0')}:00`, rows, note: notes.join('；') };
  };

  let marker = null;
  const hit = attachCrosshair({
    svg, plot, plotW, plotH, margin, wrap: chartHost, tooltip,
    xOfIndex: Object.assign(
      (localX) => Math.max(0, Math.min(values.length - 1, Math.round((localX / plotW) * (values.length - 1)) || 0)),
      { count: values.length, position: (index) => scaleX.x(index) },
    ),
    onHover: (index) => {
      const data = tooltipFor(index);
      if (data) tooltip.show(data.title, data.rows, data.note);
      if (marker) marker.remove();
      marker = null;
      const point = values[index];
      if (point && point.kwh != null) {
        marker = el('circle', {
          cx: scaleX.x(index), cy: scaleY(point.kwh), r: 4.5, fill: 'transparent',
          stroke: 'var(--text-primary)', 'stroke-width': 1.5, 'pointer-events': 'none',
        }, plot);
      }
    },
    onLeave: () => {
      if (marker) marker.remove();
      marker = null;
    },
  });
  hit.addEventListener('pointermove', (event) => tooltip.move(event, chartHost));

  legend(legendHost, [
    { label: '实际逐时用能', color: 'var(--series-1)' },
    { label: '校正后（基线天气与营业时长）', color: 'var(--series-2)' },
    { label: '估算补值', color: 'var(--warning)', shape: 'dot' },
    { label: '补录读数', color: 'var(--series-3)', shape: 'dot' },
    { label: '缺测时段（留空，不按 0）', border: '1px solid var(--gridline)', shape: 'band' },
    { label: '异常日期', color: 'var(--series-2-wash)', shape: 'rect' },
  ]);
}

// ---------------------------------------------------------------------------
// Baseline model card
// ---------------------------------------------------------------------------

export function renderModelCard(result) {
  const body = document.getElementById('model-body');
  clear(body);
  if (!result.model.ok) {
    emptyState(body, result.model.reason || '基线模型不可用');
    text('p', 'note-line', '请选择至少 10 个完整日的基线时段（天气、营业时段与逐时读数都齐全）。', body);
    return;
  }
  const model = result.model;
  const grid = text('div', 'model-grid', null, body);
  const entries = [
    ['基线完整日', `${model.n} 天`],
    ['拟合优度 R²', model.r2.toFixed(3)],
    ['基线均温', `${model.baseTemp.toFixed(1)} °C`],
    ['基线营业时长', `${model.baseHours.toFixed(2)} h`],
    ['制冷平衡点', `${model.params.coolPoint.toFixed(1)} °C`],
    ['采暖平衡点', `${model.params.heatPoint.toFixed(1)} °C`],
    ['营业时长系数', `${model.coefficients[1].toFixed(2)} kWh/h`],
    ['制冷 / 采暖系数', `${model.coefficients[2].toFixed(2)} / ${model.coefficients[3].toFixed(2)}`],
  ];
  for (const [key, value] of entries) {
    const kv = text('div', 'kv', null, grid);
    text('span', 'k', key, kv);
    text('span', 'v', value, kv);
  }

  const formula = text('div', 'formula', null, body);
  text('code', '', model.formula, formula);

  text('p', 'note-line',
    `基线天气 ${model.baseTempMin.toFixed(1)}–${model.baseTempMax.toFixed(1)} °C，`
    + `营业时长 ${model.baseHoursMin.toFixed(1)}–${model.baseHoursMax.toFixed(1)} h；`
    + '对比日先归一到基线天气与营业时长，再与基线均值比较。', body);

  if (!model.hoursVaries) {
    const warn = text('p', 'warn-line', null, body);
    text('strong', '', '营业时长为常数：', warn);
    warn.append(document.createTextNode('基线期内每天营业时长相同，营业时长项不可辨识，其校正贡献按 0 处理。若需拆分营业时长的影响，基线应同时包含工作日与周末。'));
  }

  if (result.extrapolatedDays.length) {
    const warn = text('p', 'warn-line', null, body);
    text('strong', '', `${result.extrapolatedDays.length} 天超出基线范围：`, warn);
    warn.append(document.createTextNode('对比时段的室外温度或营业时长落在基线未覆盖的区间，校正结果为外推，异常判断已自动收紧。'));
    text('p', 'note-line',
      result.extrapolatedDays.slice(0, 12).map((day) => shortestDate(day.date)).join('、')
      + (result.extrapolatedDays.length > 12 ? ` 等 ${result.extrapolatedDays.length} 天` : ''), body);
  }
}

// ---------------------------------------------------------------------------
// Issues card
// ---------------------------------------------------------------------------

export function renderIssues(result, handlers = {}) {
  const body = document.getElementById('issues-body');
  clear(body);
  if (!result.issues.length) {
    emptyState(body, '当前所选时段没有计量质量提示。');
    return;
  }

  const missingDays = result.excludedDays.filter((day) => day.missingHours > 0).length;
  if (missingDays) {
    const notice = text('div', 'notice warning', null, body);
    text('span', 'ico', '!', notice).setAttribute('aria-hidden', 'true');
    text('div', 'grow', `${missingDays} 天存在缺测。缺失读数未被当作 0；补录后只重算对应时段。`, notice);
    if (handlers.onBackfill) {
      const button = text('button', 'btn small', '补录缺失读数', notice);
      button.type = 'button';
      button.addEventListener('click', handlers.onBackfill);
    }
  }

  const list = text('div', 'issue-list', null, body);
  for (const issue of result.issues.slice(0, 80)) {
    const meta = ISSUE_META[issue.type] || { label: issue.type, severity: 'info', icon: '·' };
    const item = text('div', `issue ${issue.severity || meta.severity}`, null, list);
    text('span', 'ico', meta.icon, item).setAttribute('aria-hidden', 'true');
    const main = text('div', '', null, item);
    text('div', 't', issue.title || meta.label, main);
    text('div', 'd', issue.detail, main);
    const date = text('span', 'date', issue.date || '', item);
    if (issue.dateEnd) text('span', 'date-end', `至 ${issue.dateEnd}`, date);
  }
  if (result.issues.length > 80) {
    text('p', 'note-line', `另有 ${result.issues.length - 80} 条记录未显示，可在导出数据中查看。`, list);
  }
}

// ---------------------------------------------------------------------------
// Daily table (table twin of the hourly profile)
// ---------------------------------------------------------------------------

const SORTABLE = {
  date: (day) => day.date,
  kwh: (day) => day.kwh,
  normalizedKwh: (day) => day.normalizedKwh,
  maxHourKwh: (day) => day.maxHourKwh,
  tempMean: (day) => day.tempMean,
  hours: (day) => day.hours,
};

export function renderDailyTable(host, result, sort, onSort) {
  clear(host);
  const wrap = text('div', 'table-wrap', null, host);
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const columns = [
    { key: 'date', label: '日期' },
    { key: null, label: '状态' },
    { key: 'kwh', label: '实际 kWh' },
    { key: 'normalizedKwh', label: '校正后 kWh' },
    { key: null, label: '差异' },
    { key: 'maxHourKwh', label: '峰值 kWh/h' },
    { key: 'tempMean', label: '均温 °C' },
    { key: 'hours', label: '营业 h' },
    { key: null, label: '质量标记' },
  ];
  for (const column of columns) {
    const th = text('th', '', column.label, headRow);
    if (column.key) {
      th.style.cursor = 'pointer';
      th.title = '点击排序';
      if (sort.key === column.key) {
        th.textContent = `${column.label} ${sort.direction === 'asc' ? '↑' : '↓'}`;
        th.setAttribute('aria-sort', sort.direction === 'asc' ? 'ascending' : 'descending');
      }
      th.tabIndex = 0;
      th.addEventListener('click', () => onSort(column.key));
      th.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSort(column.key);
        }
      });
    }
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const rows = result.normalizedDays.slice();
  const getter = SORTABLE[sort.key] || SORTABLE.date;
  rows.sort((a, b) => {
    const direction = sort.direction === 'asc' ? 1 : -1;
    const av = getter(a);
    const bv = getter(b);
    const aMissing = av == null || (typeof av === 'number' && !Number.isFinite(av));
    const bMissing = bv == null || (typeof bv === 'number' && !Number.isFinite(bv));
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (typeof av === 'string' || typeof bv === 'string') {
      return av < bv ? -direction : av > bv ? direction : 0;
    }
    return (av - bv) * direction;
  });

  const abnormalDates = new Map(result.abnormalities.map((item) => [item.date, item]));
  const tbody = document.createElement('tbody');
  for (const day of rows) {
    const tr = document.createElement('tr');
    tr.appendChild(text('td', '', `${slashDate(day.date)} ${weekdayLabel(day.date)}`));
    tr.appendChild(text('td', day.valid ? '' : 'muted', day.valid ? '完整' : '不完整'));
    tr.appendChild(text('td', day.valid ? '' : 'muted', day.valid ? number(day.kwh) : '—'));
    tr.appendChild(text('td', Number.isFinite(day.normalizedKwh) ? '' : 'muted',
      Number.isFinite(day.normalizedKwh) ? number(day.normalizedKwh) : '—'));
    const diff = day.valid && Number.isFinite(day.normalizedKwh) && day.kwh > 0
      ? (day.normalizedKwh - day.kwh) / day.kwh
      : NaN;
    tr.appendChild(text('td', 'muted', pct(diff)));
    tr.appendChild(text('td', day.valid ? '' : 'muted', day.valid ? number(day.maxHourKwh, 1) : '—'));
    tr.appendChild(text('td', 'muted', day.tempMean != null ? day.tempMean.toFixed(1) : '—'));
    tr.appendChild(text('td', 'muted', day.hours != null ? fmtHours(day.hours) : '—'));

    const flags = text('td', 'flag', null, tr);
    flags.style.textAlign = 'left';
    if (!day.valid) {
      const reason = day.missingHours > 0 ? `缺 ${day.missingHours} h` : (day.reason || '不完整');
      text('span', 'tag critical', reason, flags);
    }
    if (day.imputedHours > 0) text('span', 'tag warning', `估算 ${day.imputedHours} h`, flags);
    if (day.backfilledHours > 0) text('span', 'tag info', `补录 ${day.backfilledHours} h`, flags);
    const abnormal = abnormalDates.get(day.date);
    if (abnormal) {
      const tag = text('span', 'tag warn', `异常 ${abnormal.relative > 0 ? '偏高' : '偏低'}`, flags);
      tag.title = `${abnormal.direction}：${pct(abnormal.relative)}`;
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  text('p', 'note-line',
    `完整日 ${result.reportAgg.usableDays}/${result.reportAgg.days}；缺测日不参与基线或对比，也不按 0 计入。`
    + (result.reportAgg.days > 120 ? ' 日数较多时可在表格内滚动查看。' : ''), host);
}
