import { describe, expect, it } from "vitest";
import { fft } from "../src/engine/fft";
import { compatibleCamelot, detectKey, keyFrom } from "../src/engine/key";
import { synthesize } from "../src/engine/synth";

describe("FFT", () => {
  it("puts a pure tone in the right bin", () => {
    const n = 1024;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 37 * i) / n);
    fft(re, im);
    const mags = Array.from({ length: n / 2 }, (_, k) => Math.hypot(re[k], im[k]));
    expect(mags.indexOf(Math.max(...mags))).toBe(37);
    expect(mags[37]).toBeCloseTo(n / 2, 6);
  });

  it("rejects non-power-of-two sizes", () => {
    expect(() => fft(new Float64Array(100), new Float64Array(100))).toThrow();
  });
});

describe("Camelot notation", () => {
  it.each([
    [0, "major", "C", "8B"], [7, "major", "G", "9B"], [5, "major", "F", "7B"], [6, "major", "F#", "2B"],
    [9, "minor", "Am", "8A"], [4, "minor", "Em", "9A"], [0, "minor", "Cm", "5A"], [8, "minor", "Abm", "1A"],
  ] as const)("tonic %i %s → %s / %s", (tonic, mode, name, camelot) => {
    const k = keyFrom(tonic, mode);
    expect(k.name).toBe(name);
    expect(k.camelot).toBe(camelot);
  });

  it("lists harmonic-mixing neighbours with wraparound", () => {
    expect(compatibleCamelot("8A")).toEqual(["8A", "7A", "9A", "8B"]);
    expect(compatibleCamelot("12B")).toEqual(["12B", "11B", "1B", "12A"]);
    expect(compatibleCamelot("1A")).toEqual(["1A", "12A", "2A", "1B"]);
  });
});

describe("key detection", () => {
  it.each([
    [9, "minor", "Am"], [0, "major", "C"], [2, "minor", "Dm"], [7, "major", "G"],
    [4, "minor", "Em"], [10, "major", "Bb"], [6, "minor", "F#m"], [3, "major", "Eb"],
  ] as const)("detects tonic %i %s as %s", (tonic, mode, expected) => {
    const s = synthesize({ durationSec: 30, bpmAt: () => 120, tonic, mode, seed: tonic + 1 });
    const key = detectKey(s.audio.channels[0], s.audio.sampleRate);
    expect(key.name).toBe(expected);
    expect(key.confidence).toBeGreaterThan(0.6);
  });
});
