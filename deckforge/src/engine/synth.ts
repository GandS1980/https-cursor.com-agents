import type { PcmAudio } from "./analyzer";

/**
 * Procedural drum-and-chords generator with exact ground truth. Used by the test suite to
 * score the analyzers, and by the demo provider so the app is playable without any music.
 */
export interface SynthSpec {
  durationSec: number;
  sampleRate?: number;
  /** Tempo as a function of elapsed time (seconds) → BPM. */
  bpmAt: (t: number) => number;
  tonic: number;
  mode: "major" | "minor";
  /** Standard deviation of per-hit timing error in ms (live drummer feel). */
  humanizeMs?: number;
  /** "four" = kick on every beat (house/techno); "backbeat" = kick 1 & 3, snare 2 & 4 (funk/rock). */
  groove?: "four" | "backbeat";
  firstBeatSec?: number;
  seed?: number;
  stereo?: boolean;
}

export interface SynthResult {
  audio: PcmAudio;
  /** Ground-truth beat times; index 0 is a downbeat. */
  beats: number[];
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  const u = Math.max(1e-9, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

/** Triads as semitone offsets from the tonic: i–iv–V–i (harmonic minor) / I–IV–V–I. */
function progression(mode: "major" | "minor"): number[][] {
  return mode === "minor"
    ? [[0, 3, 7], [5, 8, 12], [7, 11, 14], [0, 3, 7]]
    : [[0, 4, 7], [5, 9, 12], [7, 11, 14], [0, 4, 7]];
}

export function synthesize(spec: SynthSpec): SynthResult {
  const sr = spec.sampleRate ?? 22_050;
  const n = Math.floor(spec.durationSec * sr);
  const out = new Float32Array(n);
  const rand = mulberry32(spec.seed ?? 1);
  const groove = spec.groove ?? "four";

  const beats: number[] = [];
  for (let t = spec.firstBeatSec ?? 0.25; t < spec.durationSec; t += 60 / spec.bpmAt(t)) beats.push(t);

  const hit = (t: number) => t + ((spec.humanizeMs ?? 0) / 1000) * gaussian(rand);
  const add = (startSec: number, lenSec: number, fn: (i: number, t: number) => number) => {
    const s0 = Math.max(0, Math.round(startSec * sr));
    const s1 = Math.min(n, s0 + Math.round(lenSec * sr));
    for (let s = s0; s < s1; s++) out[s] += fn(s - s0, (s - s0) / sr);
  };
  const kick = (t: number, amp: number) => {
    let phase = 0;
    add(hit(t), 0.25, (_, x) => {
      const f = 50 + 90 * Math.exp(-x * 35);
      phase += (2 * Math.PI * f) / sr;
      return amp * Math.sin(phase) * Math.exp(-x * 14);
    });
  };
  const noise = (t: number, amp: number, decay: number, bright: boolean) => {
    let prev = 0;
    add(hit(t), 0.15, (_, x) => {
      const w = rand() * 2 - 1;
      const v = bright ? w - prev : w;
      prev = w;
      return amp * v * Math.exp(-x * decay);
    });
  };
  const tone = (t: number, len: number, midi: number, amp: number, decay: number) => {
    const f = midiHz(midi);
    add(t, len, (_, x) => {
      const env = Math.min(1, x * 200) * Math.exp(-x * decay);
      return amp * env * (Math.sin(2 * Math.PI * f * x) + 0.3 * Math.sin(4 * Math.PI * f * x));
    });
  };

  const chords = progression(spec.mode);
  const root = 48 + spec.tonic; // C3 + tonic
  beats.forEach((t, i) => {
    const beatInBar = i % 4;
    const len = (beats[i + 1] ?? t + 60 / spec.bpmAt(t)) - t;
    if (groove === "four") kick(t, beatInBar === 0 ? 0.8 : 0.6);
    else if (beatInBar === 0 || beatInBar === 2) kick(t, 0.8);
    if (groove === "backbeat" && (beatInBar === 1 || beatInBar === 3)) noise(t, 0.35, 25, false);
    noise(t + len / 2, 0.12, 60, true);
    if (beatInBar === 0) {
      const chord = chords[Math.floor(i / 4) % chords.length];
      const barLen = len * 4;
      tone(t, barLen * 0.6, root - 12 + chord[0], 0.35, 3); // bass on the downbeat
      for (const iv of chord) tone(t, barLen, root + 12 + iv, 0.08, 0.6);
    }
  });

  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0.95) for (let i = 0; i < n; i++) out[i] *= 0.95 / peak;
  // Stereo shares one buffer (the synth is mono); consumers must not mutate channels in place.
  const channels = spec.stereo ? [out, out] : [out];
  return { audio: { sampleRate: sr, channels }, beats };
}
