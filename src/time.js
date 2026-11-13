/**
 * Timestamp helpers that do not rely on the browser's local timezone.
 * All building-local dates are derived from an explicit UTC offset, so the
 * dashboard shows the same result on any machine.
 */

const TS_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})?$/;

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

function pad2(value) {
  return String(value).padStart(2, '0');
}

export function parseTimestamp(value, fallbackOffsetMin = 0) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(TS_PATTERN);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, msPart, zone] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s || 0);
  const millis = Number(msPart ? msPart.padEnd(3, '0') : 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  if (Number.isNaN(utcGuess)) return null;
  // Reject impossible calendar dates such as 2025-02-30.
  const check = new Date(utcGuess);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  let offsetMin = fallbackOffsetMin;
  let hasOffset = false;
  if (zone) {
    hasOffset = true;
    if (zone === 'Z') {
      offsetMin = 0;
    } else {
      const sign = zone[0] === '-' ? -1 : 1;
      const raw = zone.slice(1).replace(':', '');
      offsetMin = sign * (Number(raw.slice(0, 2)) * 60 + Number(raw.slice(2)));
    }
  }
  // offsetMin is the displayed offset (east positive). Wall-clock digits are
  // UTC = local - offset, so the instant is digits - offset.
  return {
    ms: utcGuess - offsetMin * MINUTE_MS,
    offsetMin,
    hasOffset,
    naive: !hasOffset,
    raw: value,
    digits: `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}`,
  };
}

export function formatLocal(ms, offsetMin, options = {}) {
  const shifted = new Date(ms + offsetMin * MINUTE_MS);
  const date = `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
  if (options.dateOnly) return date;
  return `${date}T${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`;
}

export function formatLocalDisplay(ms, offsetMin) {
  return formatLocal(ms, offsetMin).replace('T', ' ');
}

export function dateKey(ms, offsetMin) {
  return formatLocal(ms, offsetMin, { dateOnly: true });
}

export function startOfDayMs(dateKeyValue, offsetMin) {
  const parsed = parseTimestamp(`${dateKeyValue}T00:00`, offsetMin);
  return parsed ? parsed.ms : null;
}

export function endOfDayMs(dateKeyValue, offsetMin) {
  return startOfDayMs(dateKeyValue, offsetMin) + DAY_MS;
}

export function isValidDateKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && parseTimestamp(`${value}T00:00`, 0) !== null;
}

export function addDays(dateKeyValue, amount) {
  const ms = startOfDayMs(dateKeyValue, 0);
  return formatLocal(ms + amount * DAY_MS, 0, { dateOnly: true });
}

export function diffDays(startKey, endKey) {
  return Math.round((startOfDayMs(endKey, 0) - startOfDayMs(startKey, 0)) / DAY_MS);
}

export function eachDate(startKey, endKey, guard = 5000) {
  if (!isValidDateKey(startKey) || !isValidDateKey(endKey) || startKey > endKey) return [];
  const dates = [];
  let cursor = startKey;
  while (cursor <= endKey && dates.length < guard) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

/** 0 = Sunday ... 6 = Saturday, computed on the date key (no timezone drift). */
export function dayOfWeek(dateKeyValue) {
  const ms = startOfDayMs(dateKeyValue, 0);
  return new Date(ms).getUTCDay();
}

export function isWeekend(dateKeyValue) {
  const dow = dayOfWeek(dateKeyValue);
  return dow === 0 || dow === 6;
}

export function hoursBetween(startMs, endMs) {
  return (endMs - startMs) / 3_600_000;
}

export function minutesOfClock(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 24 || minute > 59) return null;
  if (hour === 24 && minute !== 0) return null;
  return hour * 60 + minute;
}

export function operatingHours(openTime, closeTime, closed) {
  if (closed) return 0;
  const open = minutesOfClock(openTime);
  const close = minutesOfClock(closeTime);
  if (open == null || close == null) return null;
  const duration = close >= open ? close - open : close + 1440 - open;
  return duration / 60;
}

export function monthLabel(dateKeyValue) {
  const ms = startOfDayMs(dateKeyValue, 0);
  const d = new Date(ms);
  return `${d.getUTCMonth() + 1}月`;
}

export function shortDate(dateKeyValue) {
  const [, mo, d] = dateKeyValue.split('-');
  return `${Number(mo)}/${Number(d)}`;
}

export function longDate(dateKeyValue) {
  return dateKeyValue;
}

export function formatOffset(offsetMin) {
  if (offsetMin === 0) return 'UTC';
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  return `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}
