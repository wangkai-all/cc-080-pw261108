/**
 * Dashboard controller: owns the data snapshot, the analysis windows, the
 * selected building and all UI wiring. Everything runs locally; sample CSVs are
 * generated in memory by `sample-data.js` and no request leaves the page.
 */

import { analyze, mergeResults, reanalyzeBuilding } from './analysis.js';
import { parseBackfillCsv } from './backfill.js';
import { tableKindFromColumns, toCsv } from './csv.js';
import { applyBackfill, buildSnapshot, OPTIONAL_TABLES, REQUIRED_TABLES } from './import.js';
import { bundleToCsv, generateBundle } from './sample-data.js';
import { addDays, diffDays } from './time.js';
import { dayCountLabel } from './format.js';
import {
  renderBuildingTabs, renderDailyTable, renderDataPill, renderIssues, renderKpis, renderModelCard,
  renderNotices, renderPeakChart, renderPortfolioTable, renderProfileBadges, renderProfileChart,
  renderProfileHeader, renderQualityPill, renderSpanNote,
} from './views.js';

const THEME_KEY = 'energy-board-theme';

const PRESETS = [
  {
    id: 'all-events',
    label: '重点事件窗口',
    baselineStart: '2025-04-01',
    baselineEnd: '2025-06-30',
    rangeStart: '2025-07-01',
    rangeEnd: '2025-12-31',
  },
  {
    id: 'summer-compare',
    label: '夏季同比',
    baselineStart: '2025-05-01',
    baselineEnd: '2025-06-30',
    rangeStart: '2025-07-01',
    rangeEnd: '2025-08-31',
  },
  {
    id: 'autumn-window',
    label: '秋季窗口',
    baselineStart: '2025-08-01',
    baselineEnd: '2025-09-30',
    rangeStart: '2025-10-01',
    rangeEnd: '2025-11-30',
  },
  {
    id: 'cold-snap',
    label: '寒潮期间',
    baselineStart: '2025-01-05',
    baselineEnd: '2025-01-19',
    rangeStart: '2025-01-20',
    rangeEnd: '2025-01-27',
  },
];

const state = {
  snapshot: null,
  analysis: null,
  options: null,
  selectedId: null,
  zoom: 'all',
  sort: { key: 'date', direction: 'asc' },
  sampleCsv: {},
  sourceLabel: '样例数据',
  pendingImport: null,
  pendingBackfill: null,
  backfillReport: null,
  importReport: null,
  resizeTimer: null,
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  try {
    if (theme) localStorage.setItem(THEME_KEY, theme);
    else localStorage.removeItem(THEME_KEY);
  } catch {
    /* storage can be unavailable in private mode; the toggle still works */
  }
  // Tokens changed, so redraw colours baked into marks (only sparkline).
  if (state.analysis) renderKpis(state.analysis);
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    saved = null;
  }
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  $('theme-btn').addEventListener('click', () => {
    const root = document.documentElement;
    const current = root.dataset.theme
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot() {
  initTheme();

  const bundle = generateBundle();
  state.sampleCsv = bundleToCsv(bundle);
  // Load the sample *without* its backfill file: the gap stays visible, the
  // dashboard flags it, and the "补录缺失读数" flow can then demonstrate that
  // only the affected days are recomputed.
  const files = Object.entries(state.sampleCsv)
    .filter(([name]) => name !== 'readings_backfill.csv')
    .map(([name, text]) => ({ name, text }));
  const built = buildSnapshot(files);
  if (!built.ok) {
    renderDataPill('样例数据不可用', 'warn');
    renderNotices($('notice-host'), [{
      tone: 'critical',
      title: '内置样例生成失败',
      body: built.errors.join('；'),
    }]);
    return;
  }
  state.snapshot = built.snapshot;
  state.options = defaultOptions(built.snapshot);
  state.selectedId = built.snapshot.buildings[0]?.id || null;

  wireEvents();
  runAnalysis();
}

function defaultOptions(snapshot) {
  const range = snapshot.dateRange;
  const preset = PRESETS[0];
  const clamped = clampOptions({
    baselineStart: preset.baselineStart,
    baselineEnd: preset.baselineEnd,
    rangeStart: preset.rangeStart,
    rangeEnd: preset.rangeEnd,
  }, range);
  if (clamped.valid) return clamped.options;

  // Fallback for imported data whose dates do not match the sample year:
  // first 90 days as baseline, last 90 days as the comparison window.
  const dates = range.dates || [];
  const total = dates.length;
  const baseSpan = Math.min(90, Math.max(10, Math.floor(total / 3)));
  return {
    baselineStart: dates[0],
    baselineEnd: addDays(dates[0], baseSpan - 1),
    rangeStart: addDays(dates[total - 1], -(baseSpan - 1)),
    rangeEnd: dates[total - 1],
  };
}

function clampOptions(options, range) {
  const min = range.start;
  const max = range.end;
  if (!min || !max) return { valid: false, options };
  const clampDate = (value, fallback) => {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
    if (value < min) return min;
    if (value > max) return max;
    return value;
  };
  let baselineStart = clampDate(options.baselineStart, min);
  let baselineEnd = clampDate(options.baselineEnd, max);
  let rangeStart = clampDate(options.rangeStart, min);
  let rangeEnd = clampDate(options.rangeEnd, max);
  if (baselineStart > baselineEnd) [baselineStart, baselineEnd] = [baselineEnd, baselineStart];
  if (rangeStart > rangeEnd) [rangeStart, rangeEnd] = [rangeEnd, rangeStart];
  const valid = diffDays(baselineStart, baselineEnd) + 1 >= 1
    && diffDays(rangeStart, rangeEnd) + 1 >= 1;
  return { valid, options: { baselineStart, baselineEnd, rangeStart, rangeEnd } };
}

// ---------------------------------------------------------------------------
// Options + analysis
// ---------------------------------------------------------------------------

function setOptions(next, { silent = false } = {}) {
  const clamped = clampOptions(next, state.snapshot.dateRange);
  if (!clamped.valid) {
    renderNotices($('notice-host'), [{
      tone: 'warning',
      title: '时段无效',
      body: '请检查基线时段与对比时段：起止日期必须落在数据覆盖范围内。',
    }]);
    return false;
  }
  state.options = clamped.options;
  runAnalysis();
  if (!silent) {
    // keep the date inputs in sync when clamped
    writeDateInputs();
  }
  return true;
}

function runAnalysis() {
  state.analysis = analyze(state.snapshot, state.options);
  if (!state.analysis.byId.has(state.selectedId)) {
    state.selectedId = state.analysis.results[0]?.building.id || null;
  }
  renderAll();
}

function selectBuilding(id) {
  if (!state.analysis?.byId.has(id)) return;
  state.selectedId = id;
  renderAll();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAll() {
  const analysis = state.analysis;
  if (!analysis) return;
  const options = state.options;
  const selected = analysis.byId.get(state.selectedId) || analysis.results[0];
  if (!selected) {
    renderDataPill('无可用楼宇', 'warn');
    return;
  }
  state.selectedId = selected.building.id;

  renderDataPill(state.sourceLabel, 'ok');
  renderQualityPill(analysis);
  renderSpanNote($('span-note'), spanText(analysis));
  renderNotices($('notice-host'), buildNotices(analysis));

  renderKpis(analysis);
  renderPortfolioTable($('portfolio-table'), analysis, state.selectedId, selectBuilding);
  renderBuildingTabs($('building-tabs'), analysis, state.selectedId, selectBuilding);
  renderPeakChart($('peak-chart'), $('peak-legend'), analysis, state.selectedId);

  renderProfileHeader(selected, options);
  renderProfileBadges(selected);
  renderProfileChart($('profile-chart'), $('profile-legend'), selected, state.zoom);
  renderModelCard(selected);
  renderIssues(selected, { onBackfill: openBackfillDialog });
  renderDailyTable($('daily-table'), selected, state.sort, selectSort);

  writeDateInputs();
  syncPresetButtons();
  syncZoomButtons();
}

function selectSort(key) {
  state.sort = state.sort.key === key
    ? { key, direction: state.sort.direction === 'asc' ? 'desc' : 'asc' }
    : { key, direction: 'asc' };
  const selected = state.analysis.byId.get(state.selectedId);
  if (selected) renderDailyTable($('daily-table'), selected, state.sort, selectSort);
}

function spanText(analysis) {
  const { baselineStart, baselineEnd, rangeStart, rangeEnd } = state.options;
  const range = state.snapshot.dateRange;
  return `${dayCountLabel(baselineStart, baselineEnd, rangeStart, rangeEnd)} · 数据覆盖 ${range.start} 至 ${range.end}`;
}

function buildNotices(analysis) {
  const notices = [];
  if (state.importReport) {
    notices.push({
      tone: state.importReport.errors.length ? 'critical' : 'info',
      title: state.importReport.errors.length
        ? `导入未完成（${state.importReport.errors.length} 个错误）`
        : `已导入 ${state.importReport.buildings} 栋楼宇、${state.importReport.readings} 条读数`,
      body: state.importReport.errors.length
        ? state.importReport.errors.slice(0, 3).join('；')
        : (state.importReport.warnings.length
          ? `解析提示：${state.importReport.warnings.slice(0, 3).join('；')}`
          : '所有必需表格均已识别；缺失读数未被当作 0。'),
    });
  }

  if (state.backfillReport) {
    const report = state.backfillReport;
    const body = report.entries.map((item) => {
      if (!item.days) return `${item.building}：补录日期不在当前基线或对比时段内，视图无需重算`;
      if (item.baseline) return `${item.building}：补录落在基线时段，已重新拟合模型并重算全部 ${item.days} 个对比日`;
      return `${item.building}：仅重算 ${item.start} 至 ${item.end} 的 ${item.days} 天`;
    }).join('；');
    notices.push({
      tone: 'info',
      title: `已补录 ${report.rows} 行，涉及 ${report.affectedBuildings} 栋楼宇`,
      body: `${body || '补录日期不在当前时段内'}。未受影响的楼宇与时段沿用原有结果，没有重新计算。`,
    });
  }

  const failures = analysis.results.filter((result) => !result.model.ok);
  if (failures.length) {
    notices.push({
      tone: 'warning',
      title: `${failures.length} 栋楼宇的基线模型不可用`,
      body: failures.map((result) => `${result.building.id}：${result.model.reason}`).join('；')
        + '。请选择至少 10 个完整日、且天气与营业时段齐全的基线。',
    });
  }

  const warningCount = state.snapshot.warnings?.length || 0;
  if (warningCount) {
    notices.push({
      tone: 'warning',
      title: `导入时有 ${warningCount} 条提示`,
      body: state.snapshot.warnings.slice(0, 3).join('；'),
    });
  }
  return notices;
}

function writeDateInputs() {
  const { baselineStart, baselineEnd, rangeStart, rangeEnd } = state.options;
  const range = state.snapshot.dateRange;
  for (const [id, value] of Object.entries({
    'baseline-start': baselineStart,
    'baseline-end': baselineEnd,
    'range-start': rangeStart,
    'range-end': rangeEnd,
  })) {
    const input = $(id);
    input.value = value;
    if (range.start) input.min = range.start;
    if (range.end) input.max = range.end;
  }
}

function syncPresetButtons() {
  for (const button of document.querySelectorAll('#presets button')) {
    const preset = PRESETS.find((item) => item.id === button.dataset.preset);
    if (!preset) continue;
    const clamped = clampOptions(preset, state.snapshot.dateRange);
    const active = clamped.valid
      && state.options.baselineStart === clamped.options.baselineStart
      && state.options.baselineEnd === clamped.options.baselineEnd
      && state.options.rangeStart === clamped.options.rangeStart
      && state.options.rangeEnd === clamped.options.rangeEnd;
    button.setAttribute('aria-pressed', String(active));
    const baseDays = clamped.valid ? diffDays(clamped.options.baselineStart, clamped.options.baselineEnd) + 1 : 0;
    const rangeDays = clamped.valid ? diffDays(clamped.options.rangeStart, clamped.options.rangeEnd) + 1 : 0;
    const usable = baseDays >= 10 && rangeDays >= 1;
    button.disabled = !usable;
    button.title = usable ? '' : '当前数据覆盖范围不包含该内置时段';
  }
}

function syncZoomButtons() {
  $('zoom-week').setAttribute('aria-pressed', String(state.zoom === 'week'));
  $('zoom-all').setAttribute('aria-pressed', String(state.zoom === 'all'));
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function wireEvents() {
  for (const id of ['baseline-start', 'baseline-end', 'range-start', 'range-end']) {
    $(id).addEventListener('change', () => {
      setOptions({
        baselineStart: $('baseline-start').value,
        baselineEnd: $('baseline-end').value,
        rangeStart: $('range-start').value,
        rangeEnd: $('range-end').value,
      });
    });
  }

  for (const button of document.querySelectorAll('#presets button')) {
    button.addEventListener('click', () => {
      const preset = PRESETS.find((item) => item.id === button.dataset.preset);
      if (!preset) return;
      setOptions(preset);
    });
  }

  $('zoom-week').addEventListener('click', () => {
    state.zoom = 'week';
    syncZoomButtons();
    const selected = state.analysis.byId.get(state.selectedId);
    if (selected) renderProfileChart($('profile-chart'), $('profile-legend'), selected, state.zoom);
  });
  $('zoom-all').addEventListener('click', () => {
    state.zoom = 'all';
    syncZoomButtons();
    const selected = state.analysis.byId.get(state.selectedId);
    if (selected) renderProfileChart($('profile-chart'), $('profile-legend'), selected, state.zoom);
  });

  $('export-btn').addEventListener('click', exportCsv);
  $('import-btn').addEventListener('click', openImportDialog);
  $('import-close').addEventListener('click', () => $('import-dialog').close());
  $('backfill-close').addEventListener('click', () => $('backfill-dialog').close());

  wireImportDialog();
  wireBackfillDialog();

  window.addEventListener('resize', () => {
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(() => {
      if (!state.analysis) return;
      const selected = state.analysis.byId.get(state.selectedId);
      renderPeakChart($('peak-chart'), $('peak-legend'), state.analysis, state.selectedId);
      if (selected) renderProfileChart($('profile-chart'), $('profile-legend'), selected, state.zoom);
      renderKpis(state.analysis);
    }, 180);
  });
}

// ---------------------------------------------------------------------------
// Import dialog
// ---------------------------------------------------------------------------

function openImportDialog() {
  state.pendingImport = new Map();
  $('import-dialog').showModal();
  renderTableStatus();
  renderSampleLinks();
  renderImportDiag(null);
  $('apply-import').disabled = true;
}

function wireImportDialog() {
  const dropzone = $('dropzone');
  const input = $('file-input');
  dropzone.addEventListener('click', () => input.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
  for (const type of ['dragenter', 'dragover']) {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('drag');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    dropzone.addEventListener(type, () => dropzone.classList.remove('drag'));
  }
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    handleImportFiles(event.dataTransfer?.files);
  });
  input.addEventListener('change', () => {
    handleImportFiles(input.files);
    input.value = '';
  });

  $('load-sample').addEventListener('click', () => {
    const files = Object.entries(state.sampleCsv)
      .filter(([name]) => name !== 'readings_backfill.csv')
      .map(([name, text]) => ({ name, text }));
    const built = buildSnapshot(files);
    if (!built.ok) {
      renderImportDiag(built);
      return;
    }
    applySnapshot(built.snapshot, { label: '样例数据', report: null });
    $('import-dialog').close();
  });

  $('download-sample').addEventListener('click', downloadSampleFiles);
  $('apply-import').addEventListener('click', () => {
    const built = state.pendingImportResult;
    if (!built?.ok) return;
    applySnapshot(built.snapshot, {
      label: `本地导入 · ${built.snapshot.buildings.length} 栋`,
      report: {
        errors: [],
        warnings: built.warnings || [],
        buildings: built.snapshot.buildings.length,
        readings: built.snapshot.readings.length,
      },
    });
    $('import-dialog').close();
  });
}

async function handleImportFiles(fileList) {
  const files = [...(fileList || [])].filter((file) => file && /\.csv$/i.test(file.name));
  if (!files.length) {
    renderImportDiag({ errors: ['请选择 .csv 文件'], warnings: [] });
    $('apply-import').disabled = true;
    return;
  }
  const pending = state.pendingImport;
  for (const file of files) {
    try {
      pending.set(file.name, await file.text());
    } catch {
      pending.set(file.name, '');
    }
  }
  const entries = [...pending.entries()].map(([name, text]) => ({ name, text }));
  renderTableStatus(entries);
  $('apply-import').disabled = true;

  const built = buildSnapshot(entries);
  if (!built.ok) {
    state.pendingImportResult = null;
    renderImportDiag({ errors: built.errors, warnings: built.warnings });
    return;
  }
  state.pendingImportResult = built;
  if (!built.snapshot.buildings.length) {
    renderImportDiag({ errors: ['没有有效楼宇'], warnings: built.warnings });
    return;
  }
  renderImportDiag({ errors: [], warnings: built.warnings, built });
  $('apply-import').disabled = false;
}

function renderTableStatus(entries) {
  const host = $('table-status');
  while (host.firstChild) host.removeChild(host.firstChild);
  const list = entries || [...(state.pendingImport?.entries() || [])].map(([name, text]) => ({ name, text }));

  const found = new Map();
  for (const entry of list) {
    try {
      const preview = parseFirstRowColumns(entry.text);
      const kind = tableKindFromColumns(preview, entry.name);
      if (kind && !found.has(kind)) found.set(kind, entry.name);
    } catch {
      /* a malformed file is reported by buildSnapshot */
    }
  }

  for (const table of [...REQUIRED_TABLES, ...OPTIONAL_TABLES]) {
    const row = document.createElement('div');
    const name = found.get(table.kind);
    const ok = Boolean(name);
    row.className = `ts-row ${ok ? 'ok' : (table.kind === 'backfill' ? 'ok' : 'missing')}`;
    const icon = document.createElement('span');
    icon.className = 'ico';
    icon.textContent = ok ? '✓' : (table.kind === 'backfill' ? '·' : '!');
    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = table.label;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = ok ? name : (table.kind === 'backfill' ? '可选，未选择' : '缺少');
    if (!ok && table.kind === 'backfill') row.style.opacity = '0.7';
    row.append(icon, label, meta);
    host.appendChild(row);
  }
  const note = document.createElement('p');
  note.className = 'note-line';
  note.textContent = '文件仅在本地解析，不会上传。按列名自动识别表类型；补录表可选，导入后可从计量提示卡片单独补录。';
  host.appendChild(note);
}

function parseFirstRowColumns(text) {
  const firstLine = String(text).replace(/^﻿/, '').split(/\r?\n/, 1)[0] || '';
  return firstLine.split(',').map((cell) => cell.replace(/^"|"$/g, '').trim().toLowerCase());
}

function renderImportDiag(diag) {
  const host = $('import-diag');
  while (host.firstChild) host.removeChild(host.firstChild);
  if (!diag) {
    host.className = '';
    return;
  }
  host.className = 'diag-list';
  for (const error of (diag.errors || []).slice(0, 12)) {
    const item = document.createElement('div');
    item.className = 'd-error';
    item.textContent = `错误：${error}`;
    host.appendChild(item);
  }
  for (const warning of (diag.warnings || []).slice(0, 8)) {
    const item = document.createElement('div');
    item.className = 'd-warn';
    item.textContent = `提示：${warning}`;
    host.appendChild(item);
  }
  if (diag.built) {
    const item = document.createElement('div');
    item.className = 'd-warn';
    item.textContent = `已识别 ${diag.built.snapshot.buildings.length} 栋楼宇、`
      + `${diag.built.snapshot.meters.length} 块电表、${diag.built.snapshot.readings.length} 条读数，`
      + `覆盖 ${diag.built.snapshot.dateRange.start} 至 ${diag.built.snapshot.dateRange.end}。`;
    host.appendChild(item);
    const metrics = resultMetrics(diag.built.snapshot, state.options);
    if (metrics) {
      const hint = document.createElement('div');
      hint.className = 'd-warn';
      hint.textContent = metrics;
      host.appendChild(hint);
    }
  }
}

function resultMetrics(snapshot, options) {
  try {
    const preview = analyze(snapshot, clampOptions(options, snapshot.dateRange).options || options);
    const complete = preview.results.reduce((sum, result) => sum + result.reportAgg.usableDays, 0);
    return `按当前时段预览：对比时段共 ${complete} 个完整日可用于分析。`;
  } catch {
    return null;
  }
}

function applySnapshot(snapshot, { label, report }) {
  state.snapshot = snapshot;
  state.sourceLabel = label;
  state.importReport = report;
  state.backfillReport = null;

  // Only keep the previous windows when the new data actually covers them;
  // otherwise fall back to sensible windows for the imported date range.
  const previous = state.options;
  const coversPrevious = previous
    && snapshot.dateRange.start <= previous.baselineStart
    && snapshot.dateRange.end >= previous.rangeEnd
    && diffDays(previous.baselineStart, previous.rangeEnd) <= 400;
  const clamped = coversPrevious ? clampOptions(previous, snapshot.dateRange) : { valid: false };
  state.options = clamped.valid ? clamped.options : defaultOptions(snapshot);
  if (!snapshot.buildingById.has(state.selectedId)) {
    state.selectedId = snapshot.buildings[0]?.id || null;
  }
  runAnalysis();
}

function renderSampleLinks() {
  const host = $('sample-links');
  while (host.firstChild) host.removeChild(host.firstChild);
  const label = document.createElement('span');
  label.className = 'note-line';
  label.textContent = '内置样例（完全本地生成）：';
  host.appendChild(label);
  for (const name of Object.keys(state.sampleCsv || {})) {
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = name;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      downloadText(name, state.sampleCsv[name]);
    });
    host.appendChild(link);
  }
}

function downloadSampleFiles() {
  const names = Object.keys(state.sampleCsv || {});
  names.forEach((name, index) => {
    setTimeout(() => downloadText(name, state.sampleCsv[name]), index * 160);
  });
}

function downloadText(name, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------------------------------------------------------------------------
// Backfill dialog
// ---------------------------------------------------------------------------

function openBackfillDialog() {
  const selected = state.analysis?.byId.get(state.selectedId);
  if (!selected) return;
  state.pendingBackfill = null;
  $('backfill-dialog').showModal();
  $('backfill-sub').textContent =
    `${selected.building.id} · ${selected.building.name}：补录只重算受影响的楼宇与日期，其余结果保持不变。`;
  renderBackfillGaps(selected);
  renderBackfillDiag(null);
}

function renderBackfillGaps(result) {
  const host = $('backfill-gaps');
  while (host.firstChild) host.removeChild(host.firstChild);
  const gaps = result.excludedDays.filter((day) => day.missingHours > 0);
  if (!gaps.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '当前对比与基线时段内没有缺测日。仍可导入任意时段的补录文件。';
    host.appendChild(empty);
    return;
  }
  const title = document.createElement('div');
  title.className = 'note-line';
  title.textContent = `当前时段内 ${gaps.length} 天缺测（共 ${gaps.reduce((sum, day) => sum + day.missingHours, 0)} 小时）：`;
  host.appendChild(title);
  const list = document.createElement('p');
  list.className = 'note-line';
  list.textContent = gaps.slice(0, 10).map((day) => `${day.date}（缺 ${day.missingHours} h）`).join('、')
    + (gaps.length > 10 ? ` 等 ${gaps.length} 天` : '');
  host.appendChild(list);
  const meters = result.meters.filter((meter) => !meter.ignored);
  if (meters.length) {
    const meterLine = document.createElement('p');
    meterLine.className = 'note-line';
    meterLine.textContent = `可用电表：${meters.map((meter) => `${meter.id}（${meter.label}）`).join('、')}`;
    host.appendChild(meterLine);
  }
}

function wireBackfillDialog() {
  const dropzone = $('backfill-dropzone');
  const input = $('backfill-file');
  dropzone.addEventListener('click', () => input.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
  for (const type of ['dragenter', 'dragover']) {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('drag');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    dropzone.addEventListener(type, () => dropzone.classList.remove('drag'));
  }
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) handleBackfillFile(file);
  });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (file) handleBackfillFile(file);
  });
}

async function handleBackfillFile(file) {
  if (!/\.csv$/i.test(file.name)) {
    renderBackfillDiag({ errors: ['请选择 .csv 补录文件'], warnings: [] });
    return;
  }
  const text = await file.text();
  const parsed = parseBackfillCsv(text, state.snapshot, file.name);
  state.pendingBackfill = parsed.ok ? parsed : null;
  renderBackfillDiag(parsed);
}

function renderBackfillDiag(parsed) {
  const host = $('backfill-diag');
  while (host.firstChild) host.removeChild(host.firstChild);
  if (!parsed) return;
  host.className = 'diag-list';

  for (const error of parsed.errors.slice(0, 8)) {
    const item = document.createElement('div');
    item.className = 'd-error';
    item.textContent = `错误：${error}`;
    host.appendChild(item);
  }
  for (const warning of parsed.warnings.slice(0, 6)) {
    const item = document.createElement('div');
    item.className = 'd-warn';
    item.textContent = `提示：${warning}`;
    host.appendChild(item);
  }
  if (!parsed.ok) return;

  const perBuilding = new Map();
  for (const row of parsed.rows) {
    const date = row.digits.slice(0, 10);
    for (const id of row.buildingIds || []) {
      const span = perBuilding.get(id);
      if (!span) perBuilding.set(id, { start: date, end: date, hours: 1 });
      else {
        if (date < span.start) span.start = date;
        if (date > span.end) span.end = date;
        span.hours += 1;
      }
    }
  }

  const summary = document.createElement('div');
  summary.className = 'd-warn';
  summary.textContent = `已解析 ${parsed.rows.length} 行：`
    + [...perBuilding.entries()]
      .map(([id, span]) => `${id} 共 ${span.hours} 行，${span.start} 至 ${span.end}`)
      .join('；')
    + '。应用后只重算这些楼宇在该区间内的日期，其余结果保持不变。';
  host.appendChild(summary);

  const button = document.createElement('button');
  button.className = 'btn primary';
  button.type = 'button';
  button.textContent = '应用补录（只重算受影响时段）';
  button.style.marginTop = '4px';
  button.addEventListener('click', () => applyPendingBackfill());
  host.appendChild(button);
}

function applyPendingBackfill() {
  const parsed = state.pendingBackfill;
  if (!parsed || !parsed.ok) return;
  const snapshot = applyBackfill(state.snapshot, parsed.rows);

  // Scope the recompute per building: B's backfill lands in April (inside the
  // baseline) while C's single day is in September (outside it), so C can keep
  // its fitted model even though the file as a whole starts inside the baseline.
  const affectedByBuilding = new Map();
  for (const row of parsed.rows) {
    const date = row.digits.slice(0, 10);
    const meter = state.snapshot.meterById.get(row.meter_id);
    if (!meter) continue;
    for (const id of meter.served) {
      const range = affectedByBuilding.get(id);
      if (!range) affectedByBuilding.set(id, { start: date, end: date });
      else {
        if (date < range.start) range.start = date;
        if (date > range.end) range.end = date;
      }
    }
  }

  const replacements = [];
  const reports = [];
  for (const result of state.analysis.results) {
    const affected = affectedByBuilding.get(result.building.id);
    if (!affected) continue;
    const outcome = reanalyzeBuilding(snapshot, state.options, result, affected);
    // A building whose backfilled dates sit entirely outside the current
    // baseline/compare windows has nothing to redraw; keep its previous result.
    if (!outcome.recomputed.days && !outcome.recomputed.baseline && !outcome.modelRefit) {
      reports.push({
        building: result.building.id,
        start: affected.start,
        end: affected.end,
        days: 0,
        baseline: false,
      });
      continue;
    }
    replacements.push(outcome.result);
    reports.push({
      building: result.building.id,
      days: outcome.recomputed.days,
      baseline: outcome.recomputed.baseline,
      start: outcome.recomputed.start,
      end: outcome.recomputed.end,
    });
  }

  state.snapshot = snapshot;
  state.analysis = replacements.length ? mergeResults(state.analysis, replacements) : state.analysis;
  state.sourceLabel = `${state.sourceLabel.replace(/ · 已补录.*$/, '')} · 已补录`;

  state.backfillReport = {
    rows: parsed.rows.length,
    entries: reports.map((item) => ({
      building: item.building,
      start: item.start,
      end: item.end,
      days: item.days,
      baseline: item.baseline,
    })),
    affectedBuildings: affectedByBuilding.size,
  };

  $('backfill-dialog').close();
  renderAll();
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function exportCsv() {
  if (!state.analysis) return;
  const columns = [
    'record_type', 'scope', 'building_id', 'building_name', 'date', 'status',
    'area_m2', 'days_usable', 'days_total',
    'baseline_intensity_kwh_m2', 'actual_intensity_kwh_m2', 'corrected_intensity_kwh_m2',
    'corrected_change', 'weather_effect', 'schedule_effect',
    'peak_baseline_kwh', 'peak_report_kwh',
    'kwh', 'normalized_kwh', 'peak_kwh', 'missing_hours', 'imputed_hours', 'backfilled_hours',
    'title', 'detail',
  ];
  const rows = [];
  const { baselineStart, baselineEnd, rangeStart, rangeEnd } = state.options;
  rows.push({
    record_type: 'analysis',
    scope: `baseline ${baselineStart}..${baselineEnd}; compare ${rangeStart}..${rangeEnd}`,
    title: '基线模型与校正口径',
    detail: '缺测日不参与均值且不按 0；校正后强度按基线天气与营业时长归一。',
  });

  for (const result of state.analysis.results) {
    const totalArea = result.building.area;
    rows.push({
      record_type: 'building',
      building_id: result.building.id,
      building_name: result.building.name,
      area_m2: totalArea,
      days_usable: result.reportAgg.usableDays,
      days_total: result.reportAgg.days,
      baseline_intensity_kwh_m2: round(result.baselineAgg.meanIntensity),
      actual_intensity_kwh_m2: round(result.reportAgg.meanIntensity),
      corrected_intensity_kwh_m2: result.model.ok ? round(result.correctedMeanKwh / totalArea) : '',
      corrected_change: result.model.ok ? round(result.correctedPct) : '',
      weather_effect: result.model.ok ? round(result.decomposition.weatherEffect / result.baselineAgg.meanEnergy) : '',
      schedule_effect: result.model.ok ? round(result.decomposition.scheduleEffect / result.baselineAgg.meanEnergy) : '',
      peak_baseline_kwh: round(result.baselineAgg.meanPeak),
      peak_report_kwh: round(result.reportAgg.meanPeak),
      status: result.model.ok ? 'ok' : 'baseline-model-unavailable',
    });
    for (const day of result.normalizedDays) {
      rows.push({
        record_type: 'day',
        building_id: result.building.id,
        building_name: result.building.name,
        date: day.date,
        status: day.valid ? 'complete' : 'incomplete',
        kwh: round(day.kwh),
        normalized_kwh: round(day.normalizedKwh),
        peak_kwh: round(day.maxHourKwh),
        missing_hours: day.missingHours,
        imputed_hours: day.imputedHours,
        backfilled_hours: day.backfilledHours,
        detail: day.reason,
      });
    }
    for (const issue of result.issues) {
      rows.push({
        record_type: 'issue',
        building_id: result.building.id,
        building_name: result.building.name,
        date: issue.date,
        status: issue.type,
        title: issue.title,
        detail: issue.detail,
      });
    }
  }

  downloadText('楼宇能耗看板-导出.csv', toCsv(columns, rows));
  renderNotices($('notice-host'), [{
    tone: 'info',
    title: '已导出 CSV',
    body: '包含楼宇汇总、逐日明细与计量问题记录；缺测日标注为 incomplete。',
  }, ...buildNotices(state.analysis)]);
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : '';
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
