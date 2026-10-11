import {
  buildFixedGrid,
  buildFlexibleGrid,
  detectDownbeat,
  type BeatGrid,
  type GridMode,
} from "./beatgrid";
import { detectKey, type MusicalKey } from "./key";
import { ANALYSIS_HOP, onsetEnvelopes } from "./onset";
import { estimateTempo, localPeriodCurve, trackBeats, DEFAULT_TEMPO_RANGE, type TempoRange } from "./tempo";
import { buildWaveform, type WaveformData } from "./waveform";

export interface PcmAudio {
  sampleRate: number;
  channels: Float32Array[];
}

export interface TrackAnalysis {
  duration: number;
  grid: BeatGrid;
  key: MusicalKey;
  waveform: WaveformData;
  analysisMs: number;
}

/** Compact, cacheable summary shown in library crates before a track is loaded. */
export interface TrackSummary {
  bpm: number;
  key: string;
  camelot: string;
  duration: number;
  /** True when the track has more than one tempo segment. */
  variableTempo: boolean;
}

export interface AnalyzeOptions {
  mode?: GridMode;
  tempoRange?: TempoRange;
  /** Skip the colour waveform (pre-analysis of library crates only needs BPM and key). */
  waveform?: boolean;
}

const ANALYSIS_RATE_TARGET = 22_050;

/** Mono mixdown, decimated by an integer factor towards ~22 kHz with a box pre-filter. */
export function prepareMono(audio: PcmAudio): { mono: Float32Array; sampleRate: number } {
  const factor = Math.max(1, Math.floor(audio.sampleRate / ANALYSIS_RATE_TARGET));
  const len = Math.floor(audio.channels[0].length / factor);
  const mono = new Float32Array(len);
  const scale = 1 / (factor * audio.channels.length);
  for (const ch of audio.channels) {
    for (let i = 0; i < len; i++) {
      let s = 0;
      const base = i * factor;
      for (let j = 0; j < factor; j++) s += ch[base + j];
      mono[i] += s * scale;
    }
  }
  return { mono, sampleRate: audio.sampleRate / factor };
}

/**
 * Delay between an attack and the onset-envelope frame that reports it (window centring plus
 * Hann-window build-up). Calibrated against synthetic tracks in test/analysis.test.ts.
 */
const ONSET_LATENCY_SEC = 0.0335;

export function analyzeTrack(audio: PcmAudio, options: AnalyzeOptions = {}): TrackAnalysis {
  const started = performance.now();
  const mode = options.mode ?? "flexible";
  const { mono, sampleRate } = prepareMono(audio);
  const duration = audio.channels[0].length / audio.sampleRate;
  const env = onsetEnvelopes(mono, sampleRate);
  const frameToTime = (f: number) => (f * ANALYSIS_HOP) / sampleRate + ONSET_LATENCY_SEC;
  const timeToFrame = (t: number) => ((t - ONSET_LATENCY_SEC) * sampleRate) / ANALYSIS_HOP;

  // Fixed mode tracks against the sharper transient envelope; flexible uses broadband flux,
  // which follows swung or live-played material more gracefully.
  const tracking = mode === "fixed" ? blend(env.transient, env.flux, 0.6) : env.flux;
  const globalBpm = estimateTempo(env.flux, env.frameRate, options.tempoRange ?? DEFAULT_TEMPO_RANGE);

  // Both modes track with a locally varying period; fixed mode then collapses the beats onto
  // one straight line (a strict tracker with a slightly wrong period drifts, a fit does not).
  const period = localPeriodCurve(tracking, env.frameRate, globalBpm);
  const tracked = trackBeats(tracking, period, 60).map(frameToTime);
  const beats = alignToKick(tracked, env.low, timeToFrame);
  const base: Omit<BeatGrid, "downbeatPhase" | "downbeatConfidence"> = mode === "fixed"
    ? buildFixedGrid(beats, duration, 60 / globalBpm)
    : buildFlexibleGrid(beats, duration);
  const downbeat = detectDownbeat(base.beats, env.low, timeToFrame);
  const grid: BeatGrid = { ...base, downbeatPhase: downbeat.phase, downbeatConfidence: downbeat.confidence };

  return {
    duration,
    grid,
    key: detectKey(mono, sampleRate),
    waveform: options.waveform === false
      ? { resolution: 0, low: new Float32Array(0), mid: new Float32Array(0), high: new Float32Array(0) }
      : buildWaveform(mono, sampleRate),
    analysisMs: performance.now() - started,
  };
}

export function summarize(a: TrackAnalysis): TrackSummary {
  return {
    bpm: a.grid.bpm,
    key: a.key.name,
    camelot: a.key.camelot,
    duration: a.duration,
    variableTempo: a.grid.segments.length > 1,
  };
}

/**
 * A tracker can lock onto the off-beat (hi-hats between the kicks) since both form a perfectly
 * regular pulse. Kicks and bass carry the beat in nearly all dance music, so if the half-beat
 * midpoints hold clearly more low-frequency onset energy than the beats, shift by half a beat.
 */
export function alignToKick(beats: number[], low: Float64Array, timeToFrame: (t: number) => number): number[] {
  if (beats.length < 4) return beats;
  const peakAt = (t: number) => {
    const f = Math.round(timeToFrame(t));
    let m = 0;
    for (let j = Math.max(0, f - 2); j <= Math.min(low.length - 1, f + 2); j++) m = Math.max(m, low[j]);
    return m;
  };
  let onBeat = 0;
  let offBeat = 0;
  for (let i = 0; i < beats.length - 1; i++) {
    onBeat += peakAt(beats[i]);
    offBeat += peakAt((beats[i] + beats[i + 1]) / 2);
  }
  if (offBeat <= onBeat * 1.25) return beats;
  const shifted = beats.slice(0, -1).map((t, i) => (t + beats[i + 1]) / 2);
  const firstGap = beats[1] - beats[0];
  if (beats[0] - firstGap / 2 >= 0) shifted.unshift(beats[0] - firstGap / 2);
  return shifted;
}

function blend(a: Float64Array, b: Float64Array, wa: number): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = wa * a[i] + (1 - wa) * b[i];
  return out;
}
