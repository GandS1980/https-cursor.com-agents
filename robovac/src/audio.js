#!/usr/bin/env node
// Synthesizes the soundtrack from the same simulation that moves the camera.
// Everything is generated sample-by-sample: oscillators, filtered noise,
// impulse-excited resonators and a small Schroeder room reverb.
//   node src/audio.js out/audio.wav
'use strict';
const fs = require('fs');
const T = require('./timeline');
const { mulberry32 } = require('./scene');

const SR = 48000;
const DUR = T.DURATION;
const N = Math.round(DUR * SR);
const rand = mulberry32(90210);
const white = () => rand() * 2 - 1;

// ---------------------------------------------------------------- filters
class Biquad {
  constructor(type, f, q, gainDb = 0) { this.z1 = 0; this.z2 = 0; this.set(type, f, q, gainDb); }
  set(type, f, q, gainDb = 0) {
    const w = 2 * Math.PI * Math.min(f, SR * 0.45) / SR, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    const A = Math.pow(10, gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (type === 'peak') { b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  run(x) { // transposed direct form II
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}
class OnePole { constructor(f) { this.a = Math.exp(-2 * Math.PI * f / SR); this.y = 0; } run(x) { return (this.y = x + this.a * (this.y - x)); } }
// pink noise (Paul Kellet's economy filter)
function pinkGen() {
  let b0 = 0, b1 = 0, b2 = 0;
  return () => { const w = white(); b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965386; b2 = 0.57 * b2 + w * 1.0526913; return (b0 + b1 + b2 + w * 0.1848) * 0.2; };
}
const db = (d) => Math.pow(10, d / 20);

// ---------------------------------------------------------------- sim data
const sim = T.simulate();
const at = (arr, t) => arr[Math.min(sim.n - 1, Math.max(0, Math.round(t / sim.dt)))];
const out = { L: new Float32Array(N), R: new Float32Array(N) };
const dry = new Float32Array(N);      // mechanical sounds, centred
const wet = new Float32Array(N);      // send to the room reverb
const spk = new Float32Array(N);      // robot loudspeaker (chimes)

// smoothed control signals per sample
const ctrl = { fan: new Float32Array(N), rug: new Float32Array(N), tile: new Float32Array(N), speed: new Float32Array(N), turn: new Float32Array(N), encl: new Float32Array(N), vl: new Float32Array(N), vr: new Float32Array(N) };
{
  const sm = { rug: 0, tile: 0, encl: 0 };
  const k = 1 - Math.exp(-1 / (0.03 * SR)), ke = 1 - Math.exp(-1 / (0.35 * SR));
  for (let i = 0; i < N; i++) {
    const t = i / SR, j = Math.min(sim.n - 1, Math.floor(t / sim.dt));
    const s = sim.surface[j];
    sm.rug += ((s === 'rug' ? 1 : 0) - sm.rug) * k;
    sm.tile += ((s === 'tile' ? 1 : 0) - sm.tile) * k;
    const x = sim.x[j], z = sim.z[j];
    sm.encl += ((x > 5.05 && z > 3.3 && z < 5.7 ? 1 : 0) - sm.encl) * ke;
    ctrl.fan[i] = sim.fan[j]; ctrl.rug[i] = sm.rug; ctrl.tile[i] = sm.tile; ctrl.encl[i] = sm.encl;
    ctrl.speed[i] = Math.abs(sim.v[j]); ctrl.turn[i] = Math.abs(sim.w[j]);
    ctrl.vl[i] = Math.abs(sim.v[j] - sim.w[j] * 0.115); ctrl.vr[i] = Math.abs(sim.v[j] + sim.w[j] * 0.115);
  }
}

// ---------------------------------------------------------------- 1. suction fan
{
  const pink = pinkGen();
  const air1 = new Biquad('bp', 1400, 0.55), air2 = new Biquad('bp', 3800, 0.9), airLow = new Biquad('bp', 420, 0.8);
  const hiss = new Biquad('hp', 6000, 0.7);
  let ph = 0, wob = 0;
  for (let i = 0; i < N; i++) {
    const f = ctrl.fan[i];
    if (f <= 0) continue;
    const load = ctrl.rug[i] * 0.04 + ctrl.encl[i] * 0.015;
    wob += (white() * 0.002 - wob) * 0.0005;
    const frot = 288 * Math.pow(f, 0.8) * (1 - load) * (1 + wob + 0.0015 * Math.sin(i / SR * 2 * Math.PI * 0.7));
    ph += 2 * Math.PI * frot / SR;
    const amp = Math.pow(f, 1.6);
    // tonal: shaft, 2nd harmonic, 7-blade pass and its harmonic
    const tone = 0.010 * Math.sin(ph) + 0.006 * Math.sin(2 * ph + 0.3) + 0.022 * Math.sin(7 * ph) + 0.008 * Math.sin(14 * ph + 1.1) + 0.003 * Math.sin(21 * ph);
    const n = pink();
    const airflow = air1.run(n) * 0.55 + air2.run(n) * 0.28 * (1 - ctrl.rug[i] * 0.4) + airLow.run(n) * (0.25 + ctrl.rug[i] * 0.25);
    const s = amp * (tone + airflow * 0.38 + hiss.run(white()) * 0.03);
    dry[i] += s; wet[i] += s * 0.15;
  }
}

// ---------------------------------------------------------------- 2. brush roll + 3. side brush
{
  const pink = pinkGen();
  const lowBand = new Biquad('bp', 260, 0.7), midBand = new Biquad('bp', 900, 0.8), tick = new Biquad('bp', 4200, 2.5);
  let phB = 0, phS = 0;
  for (let i = 0; i < N; i++) {
    const f = ctrl.fan[i];
    if (f <= 0) continue;
    phB += 2 * Math.PI * 19.5 * f / SR;           // main brush ~1170 rpm
    phS += 2 * Math.PI * 2.4 * f / SR;            // side brush
    const rug = ctrl.rug[i], hard = 1 - rug;
    const n = pink();
    const am = 0.65 + 0.35 * Math.sin(2 * phB) + rug * 0.5 * Math.max(0, Math.sin(phB * 4));
    const brush = (lowBand.run(n) * (0.12 + 0.55 * rug) + midBand.run(n) * (0.10 + 0.25 * rug)) * am * f;
    // side-brush arms flick the floor 3 times a turn: short ticks on hard floors
    const arm = Math.pow(Math.max(0, Math.sin(phS * 3)), 40);
    const sideTick = tick.run(white()) * arm * 0.35 * hard * f;
    const s = brush * 0.5 + sideTick;
    dry[i] += s; wet[i] += s * 0.1;
  }
}

// ---------------------------------------------------------------- 4. wheel gear motors + rolling noise
{
  const roll = new Biquad('bp', 700, 0.6), rollHi = new Biquad('hp', 2500, 0.7);
  const pink = pinkGen();
  let pl = 0, pr = 0;
  for (let i = 0; i < N; i++) {
    const vl = ctrl.vl[i], vr = ctrl.vr[i];
    if (vl + vr < 1e-4) continue;
    pl += 2 * Math.PI * (180 + 2600 * vl) / SR;
    pr += 2 * Math.PI * (183 + 2600 * vr) / SR;
    const gear = (Math.sin(pl) + 0.4 * Math.sin(2 * pl) + Math.sin(pr) + 0.4 * Math.sin(2 * pr)) * 0.0045;
    const spd = (vl + vr) / 2 / 0.28;
    const rug = ctrl.rug[i], tile = ctrl.tile[i];
    const n = pink();
    const rolling = roll.run(n) * 0.05 * (1 - rug * 0.6) + rollHi.run(white()) * 0.012 * tile;
    dry[i] += gear * Math.min(1, (vl + vr) * 6) + rolling * spd;
  }
}

// ---------------------------------------------------------------- impulsive events
function resonator(f, q) { return new Biquad('bp', f, q); }
function addImpulse(buf, t0, dur, gen, wetAmt = 0.25) {
  const i0 = Math.round(t0 * SR), n = Math.round(dur * SR);
  for (let k = 0; k < n && i0 + k < N; k++) {
    if (i0 + k < 0) continue;
    const s = gen(k / SR, k);
    buf[i0 + k] += s; wet[i0 + k] += s * wetAmt;
  }
}
function click(t, f, q, amp, decay = 0.004, buf = dry, wetAmt = 0.15) {
  const r = resonator(f, q);
  addImpulse(buf, t, decay * 12, (tt, k) => r.run(k < 24 ? white() : 0) * amp * Math.exp(-tt / decay), wetAmt);
}
function thud(t, f, amp, decay) {
  addImpulse(dry, t, decay * 8, (tt) => Math.sin(2 * Math.PI * f * tt * (1 - tt * 2)) * amp * Math.exp(-tt / decay), 0.35);
}

for (const e of sim.events) {
  switch (e.type) {
    case 'boot':
      click(e.t - 0.15, 3200, 4, 0.5, 0.002);               // power relay
      break;
    case 'bump': {
      const k = Math.min(1, e.v / 0.25);
      click(e.t, 4600, 6, 0.9 * k, 0.0025);                 // bumper micro-switch closes
      thud(e.t, 105, 0.45 * k, 0.05);                       // chassis body
      if (e.kind === 'leg') { click(e.t + 0.001, 740, 9, 1.2 * k, 0.03); click(e.t + 0.001, 1580, 7, 0.5 * k, 0.015); } // wood knock
      else { thud(e.t, 70, 0.4 * k, 0.07); click(e.t, 380, 2, 0.5 * k, 0.02); }    // wall / baseboard
      click(e.t + 0.13 + rand() * 0.04, 4300, 6, 0.55 * k, 0.002);                    // switch releases
      break;
    }
    case 'crumb': {
      const nclk = 3 + Math.floor(rand() * 5);
      for (let c = 0; c < nclk; c++) click(e.t + rand() * 0.06, 2200 + rand() * 4500, 5, 0.4 + rand() * 0.45, 0.0012 + rand() * 0.002);
      // rattling into the bin a moment later
      for (let c = 0; c < 2; c++) click(e.t + 0.12 + rand() * 0.25, 5000 + rand() * 3000, 8, 0.1, 0.002);
      break;
    }
    case 'grout': {
      const k = Math.min(1, e.v / 0.25);
      if (e.wheel === 'c') click(e.t, 2600, 5, 0.32 * k, 0.003);   // hard caster
      else { thud(e.t, 160, 0.06 * k, 0.012); click(e.t, 1300, 3, 0.1 * k, 0.003); }
      break;
    }
    case 'surface':
      if (e.to === 'threshold' || e.from === 'threshold') { thud(e.t, 90, 0.35, 0.03); click(e.t, 1900, 5, 0.45, 0.006); }
      if (e.to === 'rug') { thud(e.t, 75, 0.3, 0.05); }       // climbing the rug edge
      if (e.from === 'rug') { thud(e.t, 85, 0.35, 0.04); click(e.t + 0.01, 900, 3, 0.2, 0.01); }
      break;
    default: break;
  }
}

// ---------------------------------------------------------------- robot loudspeaker chimes
function bell(t, freq, dur, amp) {
  addImpulse(spk, t, dur + 0.6, (tt) => {
    const env = Math.min(1, tt / 0.008) * Math.exp(-tt / (dur * 0.6));
    const mod = Math.sin(2 * Math.PI * freq * 2.0 * tt) * 1.2 * Math.exp(-tt / 0.15);
    return amp * env * (Math.sin(2 * Math.PI * freq * tt + mod) + 0.25 * Math.sin(2 * Math.PI * freq * 3 * tt) * Math.exp(-tt / 0.1));
  }, 0.0);
}
const note = (n) => 440 * Math.pow(2, (n - 69) / 12);
for (const e of sim.events) {
  if (e.type === 'boot') { [72, 76, 79, 84].forEach((n, k) => bell(e.t + 0.1 + k * 0.13, note(n), k === 3 ? 0.6 : 0.18, 0.22)); }
  if (e.type === 'avoid') { bell(e.t + 0.15, note(84), 0.12, 0.2); bell(e.t + 0.3, note(84), 0.12, 0.2); }
  if (e.type === 'return') { [84, 79, 76, 72].forEach((n, k) => bell(e.t + 0.05 + k * 0.14, note(n), k === 3 ? 0.5 : 0.16, 0.2)); }
}
{ // tiny speaker: band-limited, a little breakup
  const hp = new Biquad('hp', 520, 0.8), lp = new Biquad('lp', 6500, 0.7), pk = new Biquad('peak', 1800, 1.5, 5);
  for (let i = 0; i < N; i++) {
    let s = pk.run(lp.run(hp.run(spk[i])));
    s = Math.tanh(s * 1.8) / 1.8;
    dry[i] += s * 0.9; wet[i] += s * 0.55;
  }
}

// ---------------------------------------------------------------- enclosure EQ (under the sofa)
{
  const boom = new Biquad('peak', 240, 1.2, 0), dull = new Biquad('lp', 8000, 0.7);
  let lastE = -1;
  for (let i = 0; i < N; i++) {
    const e = ctrl.encl[i];
    if (Math.abs(e - lastE) > 0.01) { boom.set('peak', 240, 1.2, e * 6); dull.set('lp', 9000 - e * 5500, 0.7); lastE = e; }
    dry[i] = dull.run(boom.run(dry[i])) * (1 + e * 0.2);
  }
}

// ---------------------------------------------------------------- room reverb (Schroeder/Freeverb-ish)
function reverb(input, seedOffs) {
  const combs = [1557, 1617, 1491, 1422, 1277, 1356].map((d) => ({ buf: new Float32Array(Math.round((d + seedOffs) * SR / 44100)), i: 0, f: 0 }));
  const aps = [556, 441, 341].map((d) => ({ buf: new Float32Array(Math.round((d + seedOffs * 0.3) * SR / 44100)), i: 0 }));
  const o = new Float32Array(N);
  const fb = 0.72, damp = 0.35;
  for (let n = 0; n < N; n++) {
    const x = input[n];
    let s = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.f = y * (1 - damp) + c.f * damp;
      c.buf[c.i] = x + c.f * fb;
      c.i = (c.i + 1) % c.buf.length;
      s += y;
    }
    for (const a of aps) {
      const y = a.buf[a.i];
      a.buf[a.i] = s + y * 0.5;
      a.i = (a.i + 1) % a.buf.length;
      s = y - s * 0.5;
    }
    o[n] = s * 0.12;
  }
  return o;
}
const revL = reverb(wet, 0), revR = reverb(wet, 23);

// ---------------------------------------------------------------- ambience: room tone, birds through the window
const amb = { L: new Float32Array(N), R: new Float32Array(N) };
{
  const pl = pinkGen(), pr = pinkGen();
  const lpL = new Biquad('lp', 500, 0.7), lpR = new Biquad('lp', 500, 0.7);
  for (let i = 0; i < N; i++) { amb.L[i] = lpL.run(pl()) * db(-36); amb.R[i] = lpR.run(pr()) * db(-36); }
  // a few birds outside: FM chirps, panned toward the window side
  let t = 3.0;
  while (t < DUR - 1) {
    const f0 = 2600 + rand() * 2200, nCh = 2 + Math.floor(rand() * 4), pan = 0.3 + rand() * 0.5;
    for (let c = 0; c < nCh; c++) {
      const tc = t + c * (0.09 + rand() * 0.05), len = 0.05 + rand() * 0.06, sweep = (rand() - 0.3) * 1800;
      const i0 = Math.round(tc * SR);
      let ph = 0;
      for (let k = 0; k < len * SR && i0 + k < N; k++) {
        const tt = k / SR, env = Math.sin(Math.PI * tt / len) ** 2;
        ph += 2 * Math.PI * (f0 + sweep * tt / len + 300 * Math.sin(2 * Math.PI * 38 * tt)) / SR;
        const s = Math.sin(ph) * env * db(-44);
        amb.L[i0 + k] += s * (1 - pan); amb.R[i0 + k] += s * pan;
      }
    }
    t += 2.5 + rand() * 6;
  }
}

// ---------------------------------------------------------------- mix, mic response, master
{
  const hpL = new Biquad('hp', 70, 0.7), hpR = new Biquad('hp', 70, 0.7);
  const micPkL = new Biquad('peak', 3500, 1, 2.5), micPkR = new Biquad('peak', 3500, 1, 2.5);
  const decor = new Float32Array(37);
  let di = 0;
  for (let i = 0; i < N; i++) {
    // tiny inter-channel delay on the mechanical sound gives it body without moving it off-centre
    const d = dry[i];
    const dd = decor[di]; decor[di] = d; di = (di + 1) % decor.length;
    let L = d * 0.98 + dd * 0.02 + revL[i] + amb.L[i];
    let R = d * 0.96 + dd * 0.04 + revR[i] + amb.R[i];
    L = micPkL.run(hpL.run(L)); R = micPkR.run(hpR.run(R));
    out.L[i] = L; out.R[i] = R;
  }
  // camera stream starts at 0.6 s: audio fades in with it
  for (let i = 0; i < N; i++) {
    const t = i / SR, g = t < 0.6 ? 0 : Math.min(1, (t - 0.6) / 0.05);
    out.L[i] *= g; out.R[i] *= g;
  }
  // normalise to a comfortable level, then soft-limit
  let ss = 0;
  for (let i = 0; i < N; i++) ss += out.L[i] ** 2 + out.R[i] ** 2;
  const rms = Math.sqrt(ss / (2 * N));
  const gain = db(-19) / rms;
  for (let i = 0; i < N; i++) {
    out.L[i] = Math.tanh(out.L[i] * gain * 1.1) / 1.1;
    out.R[i] = Math.tanh(out.R[i] * gain * 1.1) / 1.1;
  }
  console.log('pre-gain rms', (20 * Math.log10(rms)).toFixed(1), 'dBFS, gain', (20 * Math.log10(gain)).toFixed(1), 'dB');
}

// ---------------------------------------------------------------- write 16-bit WAV
function writeWav(file) {
  const buf = Buffer.alloc(44 + N * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
  const dither = mulberry32(7);
  for (let i = 0; i < N; i++) {
    const tpdf = (dither() - dither()) / 32768;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((out.L[i] + tpdf) * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((out.R[i] + tpdf) * 32767))), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}
const file = process.argv[2] || 'out/audio.wav';
writeWav(file);
console.log('wrote', file, DUR + 's', SR + 'Hz');
