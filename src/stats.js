/**
 * Minimal statistics helpers used by the correction model.
 * Everything is deterministic and integer/float only - no external packages.
 */

export function mean(values) {
  if (!values.length) return NaN;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function median(values) {
  if (!values.length) return NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function stdDev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const sumSquares = values.reduce((total, value) => total + (value - m) ** 2, 0);
  return Math.sqrt(sumSquares / (values.length - 1));
}

export function mad(values) {
  const m = median(values);
  return median(values.map((value) => Math.abs(value - m)));
}

export function robustZ(value, center, scale) {
  if (!Number.isFinite(scale) || scale <= 0) return 0;
  return (value - center) / scale;
}

/**
 * Ordinary least squares with a tiny ridge term for numerical stability.
 * Returns { coefficients, predict(x), r2, n, ok, reason }.
 */
export function linearRegression(rows, options = {}) {
  const ridge = options.ridge ?? 1e-8;
  if (!rows.length) {
    return { ok: false, reason: '无可用样本', coefficients: [], r2: 0, n: 0, predict: () => NaN };
  }
  const k = rows[0].x.length;
  const matrix = [];
  const rhs = [];
  for (let i = 0; i < k; i += 1) {
    matrix.push(new Array(k).fill(0));
    rhs.push(0);
  }
  for (const row of rows) {
    for (let i = 0; i < k; i += 1) {
      rhs[i] += row.x[i] * row.y;
      for (let j = 0; j < k; j += 1) matrix[i][j] += row.x[i] * row.x[j];
    }
  }
  for (let i = 0; i < k; i += 1) matrix[i][i] += ridge;

  // Augmented Gauss-Jordan elimination; singular columns are left out.
  const augmented = matrix.map((line, i) => [...line, rhs[i]]);
  const pivots = [];
  for (let col = 0; col < k; col += 1) {
    let best = col;
    for (let row = col + 1; row < k; row += 1) {
      if (Math.abs(augmented[row][col]) > Math.abs(augmented[best][col])) best = row;
    }
    if (Math.abs(augmented[best][col]) < 1e-12) continue;
    [augmented[col], augmented[best]] = [augmented[best], augmented[col]];
    const pivotValue = augmented[col][col];
    for (let j = col; j <= k; j += 1) augmented[col][j] /= pivotValue;
    for (let row = 0; row < k; row += 1) {
      if (row === col) continue;
      const factor = augmented[row][col];
      if (factor === 0) continue;
      for (let j = col; j <= k; j += 1) augmented[row][j] -= factor * augmented[col][j];
    }
    pivots.push(col);
  }
  if (pivots.length === 0) {
    return { ok: false, reason: '设计矩阵不可解', coefficients: [], r2: 0, n: rows.length, predict: () => NaN };
  }
  const coefficients = new Array(k).fill(0);
  for (const col of pivots) coefficients[col] = augmented[col][k];

  const predict = (x) => x.reduce((total, value, index) => total + value * coefficients[index], 0);
  const meanY = mean(rows.map((row) => row.y));
  let ssRes = 0;
  let ssTot = 0;
  for (const row of rows) {
    const residual = row.y - predict(row.x);
    ssRes += residual * residual;
    ssTot += (row.y - meanY) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { ok: true, coefficients, r2, n: rows.length, predict, ssRes, ssTot };
}

export function pctChange(from, to) {
  if (!Number.isFinite(from) || from === 0) return NaN;
  return (to - from) / Math.abs(from);
}

export function roundTo(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function sum(values) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}
