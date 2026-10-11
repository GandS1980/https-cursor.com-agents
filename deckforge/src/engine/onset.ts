import { magnitudeSpectrum } from "./fft";

export const ANALYSIS_FRAME = 1024;
export const ANALYSIS_HOP = 256;

/** Frame-rate onset-strength envelopes used by tempo, beat and downbeat tracking. */
export interface OnsetEnvelopes {
  /** Frames per second of every envelope. */
  frameRate: number;
  /** Band-equalised log-spectral flux: the general "something hit here" signal. */
  flux: Float64Array;
  /** Flux with sharper transient emphasis (high-frequency weighted, adaptive threshold). */
  transient: Float64Array;
  /** Linear-magnitude flux below ~150 Hz: kick drums and bass, used to place beats and downbeats. */
  low: Float64Array;
}

/**
 * Spectral-flux onset detection.
 *
 * Each frame is log-compressed (`log1p(γ·|X|)`) so quiet hi-hats still register next to a
 * loud kick, then the positive frame-to-frame differences are summed. The local moving
 * average is subtracted so slow crescendos do not read as onsets.
 */
export function onsetEnvelopes(mono: Float32Array, sampleRate: number): OnsetEnvelopes {
  const frames = Math.max(1, Math.floor((mono.length - ANALYSIS_FRAME) / ANALYSIS_HOP) + 1);
  const bins = ANALYSIS_FRAME / 2 + 1;
  const binHz = sampleRate / ANALYSIS_FRAME;
  const lowCut = Math.max(2, Math.round(150 / binHz));
  const topBin = Math.min(bins - 1, Math.round(11_000 / binHz));

  // 24 log-spaced bands from 30 Hz up: each band contributes its *mean* positive change,
  // so a kick (a few low bins) weighs as much as a hi-hat (hundreds of high bins).
  const bandEdges: number[] = [];
  for (let b = 0; b <= 24; b++) bandEdges.push(Math.max(1, Math.round((30 * (11_000 / 30) ** (b / 24)) / binHz)));
  const bandOf = new Int16Array(bins).fill(-1);
  const bandSize = new Float64Array(24);
  for (let b = 0; b < 24; b++) {
    for (let k = bandEdges[b]; k < Math.max(bandEdges[b] + 1, bandEdges[b + 1]) && k <= topBin; k++) {
      if (bandOf[k] === -1) { bandOf[k] = b; bandSize[b]++; }
    }
  }
  const bandFlux = new Float64Array(24);

  const flux = new Float64Array(frames);
  const transient = new Float64Array(frames);
  const low = new Float64Array(frames);
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);
  let prevRaw = new Float64Array(bins);
  let raw = new Float64Array(bins);

  for (let f = 0; f < frames; f++) {
    magnitudeSpectrum(mono, f * ANALYSIS_HOP, ANALYSIS_FRAME, cur);
    raw.set(cur);
    bandFlux.fill(0);
    let hfc = 0;
    let lo = 0;
    for (let k = 1; k <= topBin; k++) {
      const v = Math.log1p(100 * cur[k]);
      cur[k] = v;
      const d = v - prev[k];
      if (d > 0) {
        if (bandOf[k] >= 0) bandFlux[bandOf[k]] += d;
        hfc += d * (k / topBin);
      }
    }
    // Linear (not log) magnitudes in the low band: keeps the level difference between an
    // accented downbeat kick + bass note and the other beats, which log compression flattens.
    for (let k = 1; k <= lowCut; k++) lo += Math.max(0, raw[k] - prevRaw[k]);
    let all = 0;
    for (let b = 0; b < 24; b++) if (bandSize[b] > 0) all += bandFlux[b] / bandSize[b];
    flux[f] = all;
    transient[f] = hfc;
    low[f] = lo;
    const t = prev; prev = cur; cur = t;
    const r = prevRaw; prevRaw = raw; raw = r;
  }
  // The very first frame diffs against silence; it is not a real onset.
  flux[0] = transient[0] = low[0] = 0;

  const frameRate = sampleRate / ANALYSIS_HOP;
  return {
    frameRate,
    flux: normalize(subtractLocalMean(flux, Math.round(frameRate * 0.1))),
    transient: normalize(adaptiveThreshold(transient, Math.round(frameRate * 0.05))),
    low: normalize(subtractLocalMean(low, Math.round(frameRate * 0.1))),
  };
}

function subtractLocalMean(x: Float64Array, radius: number): Float64Array {
  const out = new Float64Array(x.length);
  const prefix = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) prefix[i + 1] = prefix[i] + x[i];
  for (let i = 0; i < x.length; i++) {
    const a = Math.max(0, i - radius);
    const b = Math.min(x.length, i + radius + 1);
    const mean = (prefix[b] - prefix[a]) / (b - a);
    out[i] = Math.max(0, x[i] - mean);
  }
  return out;
}

/** Keeps only values above a local median + margin: crisper peaks for quantized material. */
function adaptiveThreshold(x: Float64Array, radius: number): Float64Array {
  const out = new Float64Array(x.length);
  const window: number[] = [];
  for (let i = 0; i < x.length; i++) {
    window.length = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(x.length - 1, i + radius); j++) window.push(x[j]);
    window.sort((a, b) => a - b);
    const median = window[window.length >> 1];
    out[i] = Math.max(0, x[i] - median * 1.1);
  }
  return out;
}

function normalize(x: Float64Array): Float64Array {
  let sum = 0;
  let sq = 0;
  for (const v of x) { sum += v; sq += v * v; }
  const mean = sum / x.length;
  const std = Math.sqrt(Math.max(1e-12, sq / x.length - mean * mean));
  for (let i = 0; i < x.length; i++) x[i] /= std;
  return x;
}
