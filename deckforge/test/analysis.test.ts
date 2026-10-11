import { describe, expect, it } from "vitest";
import { analyzeTrack, prepareMono, summarize } from "../src/engine/analyzer";
import { beatIndexAt, bpmAt, bpmLabels, nearestBeatTime, timeOfBeat } from "../src/engine/beatgrid";
import { synthesize } from "../src/engine/synth";
import { beatErrorsMs, downbeatAccuracy, percentile } from "./helpers";

describe("fixed mode: constant-tempo, digitally sequenced material", () => {
  it.each([92, 124, 128, 140.5, 174])("locks %s BPM with millisecond phase and the right downbeat", (bpm) => {
    const s = synthesize({ durationSec: 60, bpmAt: () => bpm, tonic: 9, mode: "minor", seed: Math.round(bpm) });
    const { grid } = analyzeTrack(s.audio, { mode: "fixed" });
    expect(grid.mode).toBe("fixed");
    expect(grid.bpm).toBeCloseTo(bpm, 1);
    expect(grid.segments).toHaveLength(1);
    expect(percentile(beatErrorsMs(grid, s.beats), 0.95)).toBeLessThan(5);
    expect(downbeatAccuracy(grid, s.beats)).toBe(1);
  });

  it("snaps a near-integer fit to the integer BPM producers actually use", () => {
    const s = synthesize({ durationSec: 60, bpmAt: () => 126, tonic: 0, mode: "major", seed: 5 });
    expect(analyzeTrack(s.audio, { mode: "fixed" }).grid.bpm).toBe(126);
  });

  it("does not lock onto the off-beat hi-hats", () => {
    const s = synthesize({ durationSec: 45, bpmAt: () => 122, tonic: 4, mode: "minor", seed: 8 });
    const errors = beatErrorsMs(analyzeTrack(s.audio, { mode: "fixed" }).grid, s.beats);
    // Off-beat lock would put every beat ~246 ms away.
    expect(Math.max(...errors)).toBeLessThan(20);
  });

  it("handles 44.1 kHz stereo input", () => {
    const s = synthesize({ durationSec: 30, sampleRate: 44_100, stereo: true, bpmAt: () => 124, tonic: 2, mode: "minor", seed: 9 });
    const a = analyzeTrack(s.audio, { mode: "fixed" });
    expect(a.grid.bpm).toBe(124);
    expect(a.duration).toBeCloseTo(30, 3);
    expect(percentile(beatErrorsMs(a.grid, s.beats), 0.95)).toBeLessThan(5);
  });
});

describe("flexible mode: fluctuating tempo (live drummers, disco, funk)", () => {
  it("splits a tempo change into two segments at the right place", () => {
    const s = synthesize({ durationSec: 90, bpmAt: (t) => (t < 45 ? 120 : 126), tonic: 0, mode: "major", groove: "backbeat", seed: 4 });
    const { grid } = analyzeTrack(s.audio, { mode: "flexible" });
    expect(grid.segments.map((x) => x.bpm)).toEqual([120, 126]);
    expect(grid.segments[1].startTime).toBeGreaterThan(44);
    expect(grid.segments[1].startTime).toBeLessThan(46.5);
    expect(bpmAt(grid, 20)).toBe(120);
    expect(bpmAt(grid, 70)).toBe(126);
    expect(percentile(beatErrorsMs(grid, s.beats), 0.95)).toBeLessThan(8);
  });

  it("follows a humanised accelerating drummer where a fixed grid cannot", () => {
    const s = synthesize({ durationSec: 90, bpmAt: (t) => 110 + (10 * t) / 90, tonic: 7, mode: "major", groove: "backbeat", humanizeMs: 8, seed: 5 });
    const flexible = analyzeTrack(s.audio, { mode: "flexible" }).grid;
    const fixed = analyzeTrack(s.audio, { mode: "fixed" }).grid;
    const flexP95 = percentile(beatErrorsMs(flexible, s.beats), 0.95);
    const fixedMedian = percentile(beatErrorsMs(fixed, s.beats), 0.5);
    expect(flexP95).toBeLessThan(25); // within humanisation noise
    expect(fixedMedian).toBeGreaterThan(40); // a straight line drifts off the music
    expect(flexible.segments.length).toBeGreaterThan(3);
    const tempos = flexible.segments.map((x) => x.bpm);
    expect(tempos[0]).toBeLessThan(113);
    expect(tempos[tempos.length - 1]).toBeGreaterThan(117);
    expect(downbeatAccuracy(flexible, s.beats)).toBeGreaterThan(0.9);
  });

  it("reports a single segment for a steady track", () => {
    const s = synthesize({ durationSec: 60, bpmAt: () => 140.5, tonic: 9, mode: "minor", seed: 140 });
    const { grid } = analyzeTrack(s.audio, { mode: "flexible" });
    expect(grid.segments).toHaveLength(1);
    expect(grid.bpm).toBeCloseTo(140.5, 1);
  });
});

describe("grid queries and waveform labels", () => {
  const s = synthesize({ durationSec: 90, bpmAt: (t) => (t < 45 ? 120 : 126), tonic: 0, mode: "major", seed: 4 });
  const analysis = analyzeTrack(s.audio, { mode: "flexible" });
  const grid = analysis.grid;

  it("round-trips beat index ↔ time, including beyond the ends", () => {
    for (const i of [-2, 0, 3.5, 50, grid.beats.length + 3]) {
      expect(beatIndexAt(grid, timeOfBeat(grid, i))).toBeCloseTo(i, 6);
    }
    expect(nearestBeatTime(grid, grid.beats[10] + 0.05)).toBeCloseTo(grid.beats[10], 6);
  });

  it("places a labelled BPM change on the waveform where the tempo changes", () => {
    const labels = bpmLabels(grid, 8);
    const changes = labels.filter((l) => l.isChange);
    expect(changes).toHaveLength(1);
    expect(changes[0].bpm).toBe(126);
    expect(Math.abs(changes[0].time - 45)).toBeLessThan(1.5);
    // periodic reminders keep a label on screen when zoomed in
    expect(labels.filter((l) => !l.isChange).length).toBeGreaterThan(3);
    for (let i = 1; i < labels.length; i++) expect(labels[i].time).toBeGreaterThan(labels[i - 1].time);
  });

  it("produces a three-band waveform at ~150 buckets/second", () => {
    const w = analysis.waveform;
    expect(w.resolution).toBeGreaterThan(140);
    expect(w.low.length).toBeCloseTo(90 * w.resolution, -2);
    expect(Math.max(...w.low)).toBeLessThanOrEqual(1);
    expect(Math.max(...w.high)).toBeGreaterThan(0.05);
  });

  it("summarises for library pre-analysis", () => {
    const summary = summarize(analysis);
    expect(summary).toMatchObject({ bpm: 126, key: "C", camelot: "8B", variableTempo: true });
  });
});

describe("prepareMono", () => {
  it("mixes stereo and decimates 44.1 kHz to 22.05 kHz", () => {
    const left = new Float32Array(44_100).fill(0.5);
    const right = new Float32Array(44_100).fill(-0.1);
    const { mono, sampleRate } = prepareMono({ sampleRate: 44_100, channels: [left, right] });
    expect(sampleRate).toBe(22_050);
    expect(mono.length).toBe(22_050);
    expect(mono[100]).toBeCloseTo(0.2, 5);
  });
});
