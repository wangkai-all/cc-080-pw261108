/**
 * Display formatting shared by the views and the controller. Values are always
 * formatted for zh-CN and never rely on the browser's timezone.
 */

import { dayOfWeek } from './time.js';

export const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function weekdayLabel(dateKeyValue) {
  return WEEKDAY_LABELS[dayOfWeek(dateKeyValue)];
}

/** 2025-07-01 -> 7/1 */
export function shortestDate(dateKeyValue) {
  if (!dateKeyValue) return '';
  const [, month, day] = dateKeyValue.split('-');
  return `${Number(month)}/${Number(day)}`;
}

/** 2025-07-01 -> 2025/7/1 */
export function slashDate(dateKeyValue) {
  if (!dateKeyValue) return '';
  const [year, month, day] = dateKeyValue.split('-');
  return `${year}/${Number(month)}/${Number(day)}`;
}

export function pct(value, digits = 1) {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(digits)}%`;
}

export function number(value, digits = 0) {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function intensity(value) {
  if (!Number.isFinite(value)) return '—';
  // Three decimals: at ~0.2 kWh/m²·day, two decimals would round 0.204 and
  // 0.196 to the same string and hide the very difference the board measures.
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

export function hours(value) {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
}

export function dayCountLabel(baselineStart, baselineEnd, rangeStart, rangeEnd) {
  const ms = (dateKeyValue) => {
    if (!dateKeyValue) return NaN;
    const [year, month, day] = dateKeyValue.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  const days = (start, end) => {
    const startMs = ms(start);
    const endMs = ms(end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return 0;
    return Math.round((endMs - startMs) / 86_400_000) + 1;
  };
  return `${days(baselineStart, baselineEnd)} 天基线 · ${days(rangeStart, rangeEnd)} 天对比`;
}
