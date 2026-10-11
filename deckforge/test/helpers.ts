import type { BeatGrid } from "../src/engine/beatgrid";
import { isDownbeat } from "../src/engine/beatgrid";

/** Absolute error (ms) from each interior ground-truth beat to the nearest grid beat. */
export function beatErrorsMs(grid: BeatGrid, truth: number[]): number[] {
  return truth.slice(4, -4).map((t) => {
    let best = Infinity;
    for (const b of grid.beats) best = Math.min(best, Math.abs(b - t));
    return best * 1000;
  });
}

export function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

/** Fraction of detected downbeats (away from the edges) that land on a true downbeat. */
export function downbeatAccuracy(grid: BeatGrid, truth: number[]): number {
  const trueDown = truth.filter((_, i) => i % 4 === 0);
  const last = truth[truth.length - 1];
  const detected = grid.beats.filter((t, i) => isDownbeat(grid, i) && t > 2 && t < last - 2);
  const hits = detected.filter((t) => trueDown.some((d) => Math.abs(d - t) < 0.06));
  return hits.length / detected.length;
}
