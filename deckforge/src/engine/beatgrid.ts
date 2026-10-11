import { medianFilter } from "./tempo";

export type GridMode = "flexible" | "fixed";

/** A run of beats with an (approximately) constant tempo. */
export interface TempoSegment {
  startBeat: number;
  endBeat: number;
  startTime: number;
  endTime: number;
  bpm: number;
}

export interface BeatGrid {
  mode: GridMode;
  /** Beat times in seconds, strictly increasing. */
  beats: number[];
  /** Index (mod 4) of the beats that fall on bar downbeats. */
  downbeatPhase: number;
  /** 0..1, how clearly one bar phase stood out from the other three. */
  downbeatConfidence: number;
  segments: TempoSegment[];
  /** Representative tempo: the tempo covering the most beats. */
  bpm: number;
}

/**
 * Fixed grid: robust least-squares line through the tracked beats (t = t0 + i·P), optionally
 * snapped to an integer BPM when the fit is within 0.02 of one, then re-phased.
 */
export function buildFixedGrid(trackedBeats: number[], duration: number, roughPeriod: number): Omit<BeatGrid, "downbeatPhase" | "downbeatConfidence"> {
  if (trackedBeats.length < 4) throw new Error("Not enough beats to build a grid");
  let period = roughPeriod;
  let t0 = trackedBeats[0];
  // Index beats incrementally from neighbour gaps: indexing from the first beat with a rough
  // period accumulates its error (0.5 BPM off over 3 minutes is several beats).
  let index = 0;
  let inliers = trackedBeats.map((t, k) => {
    if (k > 0) index += Math.max(1, Math.round((t - trackedBeats[k - 1]) / period));
    return { t, i: index };
  });
  for (let pass = 0; pass < 3; pass++) {
    ({ slope: period, intercept: t0 } = linearFit(inliers.map((b) => b.i), inliers.map((b) => b.t)));
    inliers = trackedBeats
      .map((t) => ({ t, i: Math.round((t - t0) / period) }))
      .filter((b) => Math.abs(b.t - (t0 + b.i * period)) < period * 0.12);
    if (inliers.length < 4) break;
  }
  let bpm = 60 / period;
  const rounded = Math.round(bpm);
  if (Math.abs(bpm - rounded) < 0.02) {
    bpm = rounded;
    period = 60 / bpm;
    // Re-phase with the snapped period: median residual is robust to stray beats.
    const residuals = inliers.map((b) => b.t - b.i * period).sort((a, b) => a - b);
    t0 = residuals[residuals.length >> 1];
  }
  const first = t0 - Math.floor(t0 / period) * period;
  const beats: number[] = [];
  for (let t = first; t < duration; t += period) beats.push(t);
  return {
    mode: "fixed",
    beats,
    bpm: round2(bpm),
    segments: [{ startBeat: 0, endBeat: beats.length - 1, startTime: beats[0], endTime: duration, bpm: round2(bpm) }],
  };
}

/**
 * Flexible grid: keeps every tracked beat and splits the track into tempo segments
 * wherever the smoothed local tempo departs from the running segment by more than
 * `toleranceBpm` for at least `minSegmentBeats` beats.
 */
export function buildFlexibleGrid(
  trackedBeats: number[],
  duration: number,
  toleranceBpm = 0.75,
  minSegmentBeats = 8,
): Omit<BeatGrid, "downbeatPhase" | "downbeatConfidence"> {
  if (trackedBeats.length < 4) throw new Error("Not enough beats to build a grid");
  const beats = trackedBeats;
  const ibi = beats.slice(1).map((t, i) => t - beats[i]);
  const localBpm = medianFilter(ibi.map((d) => 60 / d), 7);

  const bounds: number[] = [0];
  let segStart = 0;
  let segMean = localBpm[0];
  for (let i = 1; i < localBpm.length; i++) {
    if (Math.abs(localBpm[i] - segMean) > toleranceBpm) {
      // Confirm the departure persists, otherwise it is one sloppy beat.
      const ahead = localBpm.slice(i, i + minSegmentBeats);
      const persistent = ahead.length >= Math.min(minSegmentBeats, localBpm.length - i) &&
        ahead.every((b) => Math.abs(b - segMean) > toleranceBpm * 0.6);
      if (persistent && i - segStart >= minSegmentBeats) {
        bounds.push(i);
        segStart = i;
        segMean = localBpm[i];
        continue;
      }
    }
    const n = i - segStart + 1;
    segMean += (localBpm[i] - segMean) / n;
  }
  bounds.push(beats.length - 1);

  const segments = bounds.slice(0, -1).map((a, s) => fitSegment(beats, a, bounds[s + 1], duration, s === bounds.length - 2));
  // Merge a short tail (fade-out, last bar) and neighbours that ended up within tolerance.
  for (let merged = true; merged && segments.length > 1;) {
    merged = false;
    for (let s = 1; s < segments.length; s++) {
      const prev = segments[s - 1];
      const cur = segments[s];
      const short = cur.endBeat - cur.startBeat < minSegmentBeats || prev.endBeat - prev.startBeat < minSegmentBeats;
      if (short || Math.abs(cur.bpm - prev.bpm) < toleranceBpm / 2) {
        segments.splice(s - 1, 2, fitSegment(beats, prev.startBeat, cur.endBeat, duration, s === segments.length - 1));
        merged = true;
        break;
      }
    }
  }
  const dominant = segments.reduce((m, s) => (s.endBeat - s.startBeat > m.endBeat - m.startBeat ? s : m));
  return { mode: "flexible", beats, segments, bpm: dominant.bpm };
}

/**
 * Bar phase: the beat position (mod 4) whose beats carry the most low-frequency onset
 * energy is taken as the downbeat (kick drums land on "1" far more than on "2"–"4").
 */
export function detectDownbeat(beats: number[], lowEnvelope: Float64Array, timeToFrame: (t: number) => number): { phase: number; confidence: number } {
  const sums = [0, 0, 0, 0];
  const counts = [0, 0, 0, 0];
  beats.forEach((t, i) => {
    const f = Math.round(timeToFrame(t));
    let peak = 0;
    for (let j = Math.max(0, f - 2); j <= Math.min(lowEnvelope.length - 1, f + 2); j++) peak = Math.max(peak, lowEnvelope[j]);
    sums[i % 4] += peak;
    counts[i % 4]++;
  });
  const means = sums.map((s, i) => (counts[i] ? s / counts[i] : 0));
  const order = [0, 1, 2, 3].sort((a, b) => means[b] - means[a]);
  const top = means[order[0]];
  const second = means[order[1]];
  return { phase: order[0], confidence: top > 0 ? Math.min(1, (top - second) / top) : 0 };
}

function fitSegment(beats: number[], a: number, b: number, duration: number, isLast: boolean): TempoSegment {
  const idx: number[] = [];
  const ts: number[] = [];
  for (let i = a; i <= b; i++) { idx.push(i); ts.push(beats[i]); }
  const { slope } = linearFit(idx, ts);
  return { startBeat: a, endBeat: b, startTime: beats[a], endTime: isLast ? duration : beats[b], bpm: round2(60 / slope) };
}

export function linearFit(x: number[], y: number[]): { slope: number; intercept: number } {
  const n = x.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return { slope, intercept: (sy - slope * sx) / n };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// ---------------------------------------------------------------------------------------
// Grid queries shared by the deck (loops, quantize) and the waveform renderer (labels).
// ---------------------------------------------------------------------------------------

function periodNear(grid: BeatGrid, i: number): number {
  const b = grid.beats;
  if (b.length < 2) return 0.5;
  const k = Math.max(0, Math.min(b.length - 2, i));
  return b[k + 1] - b[k];
}

/** Fractional beat index at time `t` (extrapolates beyond the first/last beat). */
export function beatIndexAt(grid: BeatGrid, t: number): number {
  const b = grid.beats;
  if (t <= b[0]) return (t - b[0]) / periodNear(grid, 0);
  if (t >= b[b.length - 1]) return b.length - 1 + (t - b[b.length - 1]) / periodNear(grid, b.length - 2);
  let lo = 0, hi = b.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (b[mid] <= t) lo = mid; else hi = mid;
  }
  return lo + (t - b[lo]) / (b[hi] - b[lo]);
}

/** Time of fractional beat index `i` — inverse of `beatIndexAt`. */
export function timeOfBeat(grid: BeatGrid, i: number): number {
  const b = grid.beats;
  if (i <= 0) return b[0] + i * periodNear(grid, 0);
  if (i >= b.length - 1) return b[b.length - 1] + (i - (b.length - 1)) * periodNear(grid, b.length - 2);
  const k = Math.floor(i);
  return b[k] + (i - k) * (b[k + 1] - b[k]);
}

export function nearestBeatTime(grid: BeatGrid, t: number): number {
  return timeOfBeat(grid, Math.round(beatIndexAt(grid, t)));
}

export function bpmAt(grid: BeatGrid, t: number): number {
  for (const s of grid.segments) if (t < s.endTime) return s.bpm;
  return grid.segments[grid.segments.length - 1]?.bpm ?? grid.bpm;
}

export function isDownbeat(grid: BeatGrid, beatIndex: number): boolean {
  return ((beatIndex - grid.downbeatPhase) % 4 + 4) % 4 === 0;
}

export interface BpmLabel {
  time: number;
  bpm: number;
  /** True where the tempo changes; false for periodic reminder labels. */
  isChange: boolean;
}

/** Labels drawn along the scrolling waveform: one per tempo change plus every `everyBars` bars. */
export function bpmLabels(grid: BeatGrid, everyBars = 8): BpmLabel[] {
  const labels: BpmLabel[] = [];
  grid.segments.forEach((seg, si) => {
    labels.push({ time: seg.startTime, bpm: seg.bpm, isChange: si > 0 });
    for (let beat = seg.startBeat + everyBars * 4; beat < seg.endBeat - 4; beat += everyBars * 4) {
      labels.push({ time: grid.beats[beat], bpm: seg.bpm, isChange: false });
    }
  });
  return labels;
}
