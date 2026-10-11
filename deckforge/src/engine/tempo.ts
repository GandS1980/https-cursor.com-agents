/** Tempo estimation and dynamic-programming beat tracking over an onset envelope. */

export interface TempoRange {
  minBpm: number;
  maxBpm: number;
}

export const DEFAULT_TEMPO_RANGE: TempoRange = { minBpm: 70, maxBpm: 180 };

function autocorrelation(env: Float64Array, start: number, end: number, maxLag: number): Float64Array {
  const ac = new Float64Array(maxLag + 2);
  for (let lag = 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = start + lag; i < end; i++) s += env[i] * env[i - lag];
    ac[lag] = s / Math.max(1, end - start - lag);
  }
  return ac;
}

function parabolicPeak(y: Float64Array, i: number): number {
  if (i <= 0 || i >= y.length - 1) return i;
  const a = y[i - 1], b = y[i], c = y[i + 1];
  const denom = a - 2 * b + c;
  if (denom >= 0) return i;
  return i + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom));
}

/**
 * Global tempo from the envelope's autocorrelation, weighted by a log-Gaussian prior
 * centred on 120 BPM so that half/double-tempo aliases lose to the musically likely one.
 * Harmonics (2×, 3×, 4× the period) are summed in so a lag must explain the whole
 * rhythmic hierarchy, not just one strong offbeat pattern.
 */
export function estimateTempo(env: Float64Array, frameRate: number, range: TempoRange = DEFAULT_TEMPO_RANGE): number {
  const minLag = Math.floor((60 * frameRate) / range.maxBpm);
  const maxLag = Math.ceil((60 * frameRate) / range.minBpm);
  const ac = autocorrelation(env, 0, env.length, Math.min(env.length - 2, maxLag * 4));
  const score = new Float64Array(maxLag + 2);
  let best = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let h = 1; h <= 4; h++) {
      const l = lag * h;
      if (l < ac.length) s += ac[l] / h;
    }
    const bpm = (60 * frameRate) / lag;
    const octaves = Math.log2(bpm / 120);
    score[lag] = s * Math.exp(-0.5 * (octaves / 0.9) ** 2);
    if (score[lag] > score[best]) best = lag;
  }
  return (60 * frameRate) / parabolicPeak(score, best);
}

/**
 * Per-frame beat period (in frames), estimated in sliding windows and constrained to
 * ±maxDeviation of the global period so a local estimate cannot jump an octave.
 */
export function localPeriodCurve(
  env: Float64Array,
  frameRate: number,
  globalBpm: number,
  windowSec = 8,
  hopSec = 1,
  maxDeviation = 0.2,
): Float64Array {
  const globalPeriod = (60 * frameRate) / globalBpm;
  const win = Math.round(windowSec * frameRate);
  const hop = Math.max(1, Math.round(hopSec * frameRate));
  const minLag = Math.max(2, Math.floor(globalPeriod * (1 - maxDeviation)));
  const maxLag = Math.ceil(globalPeriod * (1 + maxDeviation));
  const centres: number[] = [];
  const periods: number[] = [];

  if (env.length <= win) {
    return new Float64Array(env.length).fill(globalPeriod);
  }
  for (let start = 0; start + win <= env.length; start += hop) {
    const ac = autocorrelation(env, start, start + win, maxLag * 2 + 1);
    let best = minLag;
    let bestScore = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const s = ac[lag] + 0.5 * (2 * lag < ac.length ? ac[2 * lag] : 0);
      if (s > bestScore) { bestScore = s; best = lag; }
    }
    const refined = new Float64Array(ac.length);
    for (let lag = minLag; lag <= maxLag; lag++) refined[lag] = ac[lag] + 0.5 * (2 * lag < ac.length ? ac[2 * lag] : 0);
    centres.push(start + win / 2);
    periods.push(parabolicPeak(refined, best));
  }
  const smoothed = medianFilter(periods, 5);
  const curve = new Float64Array(env.length);
  let j = 0;
  for (let t = 0; t < env.length; t++) {
    while (j < centres.length - 1 && centres[j + 1] <= t) j++;
    if (t <= centres[0]) curve[t] = smoothed[0];
    else if (j >= centres.length - 1) curve[t] = smoothed[centres.length - 1];
    else {
      const a = (t - centres[j]) / (centres[j + 1] - centres[j]);
      curve[t] = smoothed[j] * (1 - a) + smoothed[j + 1] * a;
    }
  }
  return curve;
}

export function medianFilter(values: readonly number[], size: number): number[] {
  const r = size >> 1;
  return values.map((_, i) => {
    const w = values.slice(Math.max(0, i - r), Math.min(values.length, i + r + 1)).sort((a, b) => a - b);
    return w[w.length >> 1];
  });
}

/**
 * Dynamic-programming beat tracker (Ellis, "Beat Tracking by Dynamic Programming", 2007),
 * extended to a time-varying target period.
 *
 * score[t] = onset[t] + max_τ ( score[τ] − tightness · log((t−τ)/period[t])² )
 *
 * High tightness forces a metronomic grid; low tightness lets beats follow a drifting
 * live drummer. Returns beat positions in (fractional) frames.
 */
export function trackBeats(env: Float64Array, period: Float64Array, tightness: number): number[] {
  const n = env.length;
  const score = new Float64Array(n);
  const backlink = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    const p = period[t];
    const lo = Math.max(0, Math.floor(t - 2 * p));
    const hi = Math.floor(t - p / 2);
    let best = -Infinity;
    let bestTau = -1;
    for (let tau = lo; tau <= hi; tau++) {
      const pen = Math.log((t - tau) / p);
      const s = score[tau] - tightness * pen * pen;
      if (s > best) { best = s; bestTau = tau; }
    }
    if (bestTau >= 0 && best > 0) {
      score[t] = env[t] + best;
      backlink[t] = bestTau;
    } else {
      score[t] = env[t];
    }
  }
  // End on the strongest local maximum of the cumulative score within the final period.
  const tail = Math.max(0, Math.floor(n - period[n - 1] * 1.5));
  let end = n - 1;
  let maxScore = -Infinity;
  for (let t = tail; t < n; t++) {
    const isPeak = (t === 0 || score[t] >= score[t - 1]) && (t === n - 1 || score[t] >= score[t + 1]);
    if (isPeak && score[t] > maxScore) { maxScore = score[t]; end = t; }
  }
  const beats: number[] = [];
  for (let t = end; t >= 0; t = backlink[t]) {
    beats.push(t);
    if (backlink[t] < 0) break;
  }
  beats.reverse();
  return beats.map((b) => refineFrame(env, b));
}

/** Snap to the nearby envelope peak with parabolic sub-frame interpolation. */
function refineFrame(env: Float64Array, f: number): number {
  let best = f;
  for (let i = Math.max(0, f - 2); i <= Math.min(env.length - 1, f + 2); i++) if (env[i] > env[best]) best = i;
  return parabolicPeak(env, best);
}
