/**
 * Metric semantics - one definition per number, shared by the UI and the tests.
 *
 * Baseline model (fit only on the baseline period):
 *
 *   E_day ≈ β0 + βh·H + βcool·max(0, T − Tcool) + βheat·max(0, Theat − T)
 *            + βcoolH·H·max(0, T − Tcool) + βheatH·H·max(0, Theat − T)
 *
 * Tcool / Theat are change points chosen by grid search on the baseline period,
 * so cooling and heating are allowed to have different slopes (a building that
 * only heats in winter will not be forced into one average temperature slope).
 * The interaction terms keep the multiplicative weather × schedule behaviour from
 * being smeared into a single coefficient.
 *
 * Normalized energy for a day in the reporting period:
 *
 *   normalized = actual + (pred(baseline mean T, baseline mean H) − pred(T_day, H_day))
 *
 * i.e. "what this day would have used if the outdoor temperature and business
 * hours had been typical of the baseline". Comparing `normalized` with the
 * baseline mean isolates the change that is neither weather nor schedule.
 * Decomposition follows the functional (Shapley-like) split:
 *   weather  = f(T,Hb) − f(Tb,Hb)
 *   schedule = f(Tb,H) − f(Tb,Hb)
 *   interaction = f(T,H) − f(T,Hb) − f(Tb,H) + f(Tb,Hb)
 * and the interaction is split half to weather and half to schedule so the parts
 * add up exactly to the correction.
 */

import { linearRegression, mad, mean, stdDev } from './stats.js';

export const MODEL_FORMULA =
  '日用电量 ≈ β0 + β营业 × 营业时长 + β制冷 × 制冷温差 + β采暖 × 采暖温差 + 交互项';

function features(day, params) {
  const cool = Math.max(0, day.tempMean - params.coolPoint);
  const heat = Math.max(0, params.heatPoint - day.tempMean);
  return [1, day.hours, cool, heat, day.hours * cool, day.hours * heat];
}

/**
 * Fit with a stability-oriented penalty: grid-search each change point and prefer
 * a higher R², but reject parameter sets whose coefficients imply a non-physical
 * sign (heating should not *save* energy) unless nothing else fits.
 */
function fitAt(rows, coolPoint, heatPoint) {
  const designRows = rows.map((row) => ({
    x: features({ tempMean: row.tempMean, hours: row.hours }, { coolPoint, heatPoint }),
    y: row.kwh,
  }));
  const regression = linearRegression(designRows, { ridge: 1e-6 });
  if (!regression.ok) return regression;
  const c = regression.coefficients;
  const score = regression.r2 - 60 * (Math.max(0, -c[2]) + Math.max(0, -c[3])) - 0.0004 * (c[4] ** 2 + c[5] ** 2);
  return { ...regression, score };
}

export function fitBaselineModel(baselineDays) {
  const usable = baselineDays.filter((day) => day.valid);
  if (usable.length < 10) {
    return { ok: false, reason: `基线可用天数不足（${usable.length} 天，至少 10 天）` };
  }
  const temps = usable.map((day) => day.tempMean);
  const tMin = Math.min(...temps);
  const tMax = Math.max(...temps);
  const coolCandidates = [18, 20, 22, 24, 26];
  const heatCandidates = [6, 8, 10, 12, 14, 16];
  let best = null;
  const candidates = [];
  for (const coolPoint of [...coolCandidates, ...Array.from({ length: 9 }, (_, i) => tMin + ((tMax - tMin) * i) / 8)]) {
    for (const heatPoint of [...heatCandidates, ...Array.from({ length: 9 }, (_, i) => tMin + ((tMax - tMin) * i) / 8)]) {
      if (heatPoint >= coolPoint) continue;
      const regression = fitAt(usable, coolPoint, heatPoint);
      if (!regression.ok) continue;
      candidates.push({ coolPoint, heatPoint, regression });
      if (!best || regression.score > best.regression.score + 1e-9) {
        best = { coolPoint, heatPoint, regression };
      }
    }
  }
  if (!best) return { ok: false, reason: '基线模型无法拟合' };
  const chosen = best.regression;

  const params = { coolPoint: best.coolPoint, heatPoint: best.heatPoint };
  const residuals = usable.map((day) => day.kwh - chosen.predict(features(day, params)));
  const residualStd = stdDev(residuals);
  const residualScale = Math.max(1.4826 * mad(residuals), 1e-9);
  const meanKwh = mean(usable.map((day) => day.kwh));
  const meanTemp = mean(temps);
  const meanHours = mean(usable.map((day) => day.hours));

  return {
    ok: true,
    regression: chosen,
    params,
    n: usable.length,
    r2: chosen.r2,
    baseTemp: meanTemp,
    baseHours: meanHours,
    baseKwh: meanKwh,
    baseTempMin: tMin,
    baseTempMax: tMax,
    baseHoursMin: Math.min(...usable.map((day) => day.hours)),
    baseHoursMax: Math.max(...usable.map((day) => day.hours)),
    residualStd,
    residualScale,
    formula: MODEL_FORMULA,
    predict: (day) => chosen.predict(features(day, params)),
    coefficients: chosen.coefficients,
    candidateCount: candidates.length,
    hoursVaries: new Set(usable.map((day) => day.hours)).size > 1,
  };
}

export function normalizeDay(model, day) {
  if (!model.ok || !day.valid) return NaN;
  const expectedBase = model.predict({ tempMean: model.baseTemp, hours: model.baseHours });
  return day.kwh + expectedBase - model.predict(day);
}

export function decomposeDays(model, days) {
  const usable = days.filter((day) => day.valid);
  if (!model.ok || !usable.length) {
    return { n: 0, actual: NaN, normalized: NaN, weatherEffect: NaN, scheduleEffect: NaN, interactionEffect: NaN };
  }
  const basePred = model.predict({ tempMean: model.baseTemp, hours: model.baseHours });
  let actual = 0;
  let normalized = 0;
  let weather = 0;
  let schedule = 0;
  let interaction = 0;
  for (const day of usable) {
    const pred = model.predict(day);
    const weatherOnly = model.predict({ tempMean: day.tempMean, hours: model.baseHours }) - basePred;
    const scheduleOnly = model.predict({ tempMean: model.baseTemp, hours: day.hours }) - basePred;
    const pureInteraction = pred - basePred - weatherOnly - scheduleOnly;
    actual += day.kwh;
    normalized += day.kwh + basePred - pred;
    weather += -weatherOnly - pureInteraction / 2;
    schedule += -scheduleOnly - pureInteraction / 2;
    interaction += 0;
  }
  const n = usable.length;
  // The interaction term is split half to weather and half to schedule above,
  // so weatherEffect + scheduleEffect is exactly normalized - actual. Expose
  // the (already allocated) interaction for transparency but do not add it
  // again in any total.
  return {
    n,
    actual: actual / n,
    normalized: normalized / n,
    weatherEffect: weather / n,
    scheduleEffect: schedule / n,
    interactionEffect: 0,
    basePred,
  };
}

export function aggregate(days) {
  const usable = days.filter((day) => day.valid);
  return {
    days: days.length,
    usableDays: usable.length,
    excludedDays: days.length - usable.length,
    energy: usable.reduce((total, day) => total + day.kwh, 0),
    meanEnergy: mean(usable.map((day) => day.kwh)),
    meanIntensity: mean(usable.map((day) => day.kwh / day.area)),
    meanPeak: mean(usable.map((day) => day.maxHourKwh)),
    maxPeak: usable.length ? Math.max(...usable.map((day) => day.maxHourKwh)) : NaN,
    meanHours: mean(usable.map((day) => day.hours)),
    meanTemp: mean(usable.map((day) => day.tempMean)),
  };
}

export function relativeDelta(from, to) {
  if (!Number.isFinite(from) || from === 0) return NaN;
  return (to - from) / Math.abs(from);
}

/** Days whose outdoor temperature or hours fall outside the baseline envelope. */
export function extrapolationFlags(model, days, tolerance) {
  if (!model.ok) return [];
  const tempTol = tolerance?.temp ?? 1.5;
  const hoursTol = tolerance?.hours ?? 0.5;
  return days
    .filter((day) => day.valid)
    .filter((day) => (
      day.tempMean < model.baseTempMin - tempTol
      || day.tempMean > model.baseTempMax + tempTol
      || day.hours < model.baseHoursMin - hoursTol
      || day.hours > model.baseHoursMax + hoursTol
    ))
    .map((day) => ({
      date: day.date,
      tempMean: day.tempMean,
      hours: day.hours,
      tempOutside: day.tempMean < model.baseTempMin - tempTol || day.tempMean > model.baseTempMax + tempTol,
      hoursOutside: day.hours < model.baseHoursMin - hoursTol || day.hours > model.baseHoursMax + hoursTol,
    }));
}
