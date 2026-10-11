/** In-place iterative radix-2 FFT. `re.length` must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n !== im.length || (n & (n - 1)) !== 0) {
    throw new Error(`FFT size must be a power of two, got ${n}`);
  }
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    const half = len >> 1;
    for (let start = 0; start < n; start += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const hannCache = new Map<number, Float64Array>();

export function hann(size: number): Float64Array {
  let w = hannCache.get(size);
  if (!w) {
    w = new Float64Array(size);
    for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
    hannCache.set(size, w);
  }
  return w;
}

/**
 * Magnitude spectrum of `signal[offset .. offset+size)` (zero-padded past the end),
 * Hann-windowed. Returns `size / 2 + 1` bins.
 */
export function magnitudeSpectrum(signal: Float32Array, offset: number, size: number, out?: Float64Array): Float64Array {
  const w = hann(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const end = Math.min(size, signal.length - offset);
  for (let i = 0; i < end; i++) re[i] = signal[offset + i] * w[i];
  fft(re, im);
  const bins = (size >> 1) + 1;
  const mag = out ?? new Float64Array(bins);
  for (let k = 0; k < bins; k++) mag[k] = Math.hypot(re[k], im[k]);
  return mag;
}
