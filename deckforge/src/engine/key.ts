import { magnitudeSpectrum } from "./fft";

const PITCH_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"] as const;

// Krumhansl & Kessler (1982) probe-tone key profiles.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export interface MusicalKey {
  tonic: number;
  mode: "major" | "minor";
  /** e.g. "Am", "F#", "Eb" */
  name: string;
  /** Camelot wheel code used for harmonic mixing, e.g. "8A". */
  camelot: string;
  /** Pearson correlation of the winning profile, -1..1. */
  confidence: number;
}

export function keyFrom(tonic: number, mode: "major" | "minor", confidence = 1): MusicalKey {
  const relMajor = mode === "major" ? tonic : (tonic + 3) % 12;
  const num = (((relMajor * 7) % 12) + 7) % 12 + 1;
  return {
    tonic,
    mode,
    name: PITCH_NAMES[tonic] + (mode === "minor" ? "m" : ""),
    camelot: `${num}${mode === "minor" ? "A" : "B"}`,
    confidence,
  };
}

/** Harmonically compatible Camelot codes: same, ±1 on the wheel, and relative major/minor. */
export function compatibleCamelot(code: string): string[] {
  const m = /^(\d{1,2})([AB])$/.exec(code);
  if (!m) return [];
  const n = Number(m[1]);
  const letter = m[2];
  const wrap = (x: number) => ((x - 1 + 12) % 12) + 1;
  return [code, `${wrap(n - 1)}${letter}`, `${wrap(n + 1)}${letter}`, `${n}${letter === "A" ? "B" : "A"}`];
}

/** 12-bin pitch-class profile summed over the track. */
export function chromagram(mono: Float32Array, sampleRate: number, frameSize = 8192): Float64Array {
  const chroma = new Float64Array(12);
  const bins = frameSize / 2 + 1;
  const binHz = sampleRate / frameSize;
  const pcOfBin = new Int8Array(bins).fill(-1);
  for (let k = 1; k < bins; k++) {
    const f = k * binHz;
    if (f < 60 || f > 2100) continue;
    const midi = 12 * Math.log2(f / 440) + 69;
    // Only bins close to an equal-tempered pitch: reduces smearing between neighbours.
    if (Math.abs(midi - Math.round(midi)) > 0.35) continue;
    pcOfBin[k] = ((Math.round(midi) % 12) + 12) % 12;
  }
  const mag = new Float64Array(bins);
  const frame = new Float64Array(12);
  for (let off = 0; off + frameSize <= mono.length; off += frameSize) {
    magnitudeSpectrum(mono, off, frameSize, mag);
    frame.fill(0);
    for (let k = 1; k < bins; k++) if (pcOfBin[k] >= 0) frame[pcOfBin[k]] += mag[k];
    // Per-frame normalisation so one loud breakdown does not decide the whole key.
    const max = Math.max(...frame);
    if (max > 1e-6) for (let i = 0; i < 12; i++) chroma[i] += frame[i] / max;
  }
  return chroma;
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

export function detectKey(mono: Float32Array, sampleRate: number): MusicalKey {
  const chroma = chromagram(mono, sampleRate);
  let best = keyFrom(0, "major", -2);
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [mode, profile] of [["major", MAJOR], ["minor", MINOR]] as const) {
      const rotated = Array.from({ length: 12 }, (_, i) => profile[(i - tonic + 12) % 12]);
      const r = pearson(chroma, rotated);
      if (r > best.confidence) best = keyFrom(tonic, mode, r);
    }
  }
  return best;
}
