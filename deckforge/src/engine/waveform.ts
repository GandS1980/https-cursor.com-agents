/**
 * Three-band peak waveform (lows / mids / highs), the data behind a colour waveform display.
 * Bands are split with one-pole filters: cheap, phase-smeared, and plenty for drawing.
 */
export interface WaveformData {
  /** Buckets per second of audio. */
  resolution: number;
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
}

export function buildWaveform(mono: Float32Array, sampleRate: number, resolution = 150): WaveformData {
  const perBucket = Math.max(1, Math.round(sampleRate / resolution));
  const buckets = Math.ceil(mono.length / perBucket);
  const low = new Float32Array(buckets);
  const mid = new Float32Array(buckets);
  const high = new Float32Array(buckets);
  const aLow = 1 - Math.exp((-2 * Math.PI * 250) / sampleRate);
  const aHigh = 1 - Math.exp((-2 * Math.PI * 2500) / sampleRate);
  let lp1 = 0;
  let lp2 = 0;
  for (let i = 0; i < mono.length; i++) {
    const x = mono[i];
    lp1 += aLow * (x - lp1);
    lp2 += aHigh * (x - lp2);
    const b = (i / perBucket) | 0;
    const l = Math.abs(lp1);
    const m = Math.abs(lp2 - lp1);
    const h = Math.abs(x - lp2);
    if (l > low[b]) low[b] = l;
    if (m > mid[b]) mid[b] = m;
    if (h > high[b]) high[b] = h;
  }
  const peak = Math.max(1e-6, ...[low, mid, high].map((a) => a.reduce((m, v) => (v > m ? v : m), 0)));
  for (const a of [low, mid, high]) for (let i = 0; i < a.length; i++) a[i] /= peak;
  return { resolution: sampleRate / perBucket, low, mid, high };
}
