#!/usr/bin/env node
// Drives the WebGL2 path tracer in headless Chromium.
//   node src/render.js [--res 960x540] [--spp 6] [--frames 0:1590] [--still 10.5,30]
//                      [--gpu] [--out out] [--remeter]
// Frames land in out/frames/NNNNN.rgb (raw 8-bit RGB), so an interrupted
// render resumes where it stopped. Auto-exposure is metered in a separate
// low-res pass first, which makes every frame independently renderable.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const S = require('./scene');
const T = require('./timeline');
const { packScene } = require('./codegen');
const { stampOSD } = require('./osd');

const ROOT = path.join(__dirname, '..');
const FPS = 30;
const READOUT = 1 / 42;

function args() {
  const a = process.argv.slice(2), o = { res: '960x540', spp: 6, out: path.join(ROOT, 'out'), depth: 4, denoise: 3, sigL: 1.2, maxN: 10 };
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === '--res') o.res = a[++i];
    else if (k === '--spp') o.spp = +a[++i];
    else if (k === '--frames') o.frames = a[++i];
    else if (k === '--still') o.still = a[++i];
    else if (k === '--gpu') o.gpu = true;
    else if (k === '--out') o.out = path.resolve(a[++i]);
    else if (k === '--remeter') o.remeter = true;
    else if (k === '--depth') o.depth = +a[++i];
    else if (k === '--denoise') o.denoise = +a[++i];
    else if (k === '--sigl') o.sigL = +a[++i];
    else if (k === '--maxn') o.maxN = +a[++i];
    else if (k === '--worker') o.worker = a[++i]; // "i/n": render every n-th frame starting at i
    else throw new Error('unknown arg ' + k);
  }
  [o.W, o.H] = o.res.split('x').map(Number);
  return o;
}

function loadShaders(scene) {
  const packed = packScene(scene);
  const pt = fs.readFileSync(path.join(ROOT, 'shaders/pathtrace.frag'), 'utf8')
    .replace('//__SCENE_DEFINES__', packed.defines);
  const post = {};
  const src = fs.readFileSync(path.join(ROOT, 'shaders/post.glsl'), 'utf8');
  for (const part of src.split(/^\/\/\/\/ /m).slice(1)) {
    const nl = part.indexOf('\n');
    const body = part.slice(nl + 1).trim().split('\n');
    const v = body.findIndex((l) => l.startsWith('#version'));
    post[part.slice(0, nl).trim().replace('.', '_')] = [body[v], ...body.slice(0, v), ...body.slice(v + 1)].join('\n') + '\n';
  }
  return { pathtrace: pt, post, sceneUniforms: packed.uniforms };
}

// camera keys spanning rolling readout + exposure
function frameParams(sim, crumbBox, t, shutter) {
  const span = READOUT + shutter;
  const posK = [], rotK = [];
  for (let k = 0; k <= 5; k++) {
    const c = T.cameraAt(sim, t + span * k / 5);
    posK.push(...c.pos); rotK.push(...c.rot);
  }
  return {
    posK, rotK, span, readout: READOUT, shutter, time: t,
    crumbs: T.crumbsAt(sim, t), crumbMin: crumbBox[0], crumbMax: crumbBox[1],
    halfFov: 1.02, fish: 0.45,
  };
}

async function launch(o) {
  const flags = o.gpu
    ? ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=default']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  const browser = await chromium.launch({ args: [...flags, '--disable-gpu-watchdog', '--disable-features=GpuWatchdog'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(0);
  page.on('console', (m) => console.log('[page]', m.text()));
  await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, 'gpu.js'), 'utf8') });
  return { browser, page };
}

// ---- auto exposure --------------------------------------------------------
async function meterAll(page, sim, crumbBox, nFrames, cacheFile) {
  const MW = 96, MH = 54;
  const w = [];
  for (let j = 0; j < MH; j++) for (let i = 0; i < MW; i++) {
    const dx = (i + 0.5) / MW - 0.5, dy = (j + 0.5) / MH - 0.5;
    w.push(Math.exp(-(dx * dx + dy * dy) / 0.08) + 0.15); // centre-weighted
  }
  const lum = [];
  const t0 = Date.now();
  for (let f = 0; f < nFrames; f += 2) {
    const p = { ...frameParams(sim, crumbBox, f / FPS, 0), W: MW, H: MH, spp: 3, frame: f, maxDepth: 3 };
    const px = await page.evaluate((p) => window.RV.meter(p), p);
    let s = 0, ws = 0;
    for (let k = 0; k < px.length; k++) { s += w[k] * Math.log(Math.min(px[k], 8) + 1e-3); ws += w[k]; }
    lum[f] = Math.exp(s / ws);
    if (f % 200 === 0) process.stdout.write(`meter ${f}/${nFrames} ${((Date.now() - t0) / 1000).toFixed(0)}s\r`);
  }
  for (let f = 1; f < nFrames; f += 2) lum[f] = lum[f + 1] !== undefined ? Math.sqrt(lum[f - 1] * lum[f + 1]) : lum[f - 1];
  fs.writeFileSync(cacheFile, JSON.stringify(lum));
  console.log('');
  return lum;
}

// camera firmware: lagging AE loop -> shutter time + analog gain
function exposureSchedule(lum) {
  const KEY = 0.115;
  const target = lum.map((l) => KEY / l);
  const ref = target[Math.round(11 * FPS)];       // a typical bright living-room view
  const K = ref * 160;                            // that view -> 1/160 s at gain 1
  const WAKE = Math.round(0.6 * FPS);             // camera stream starts here, overexposed
  let logm = Math.log(target[WAKE] * 6);
  return target.map((tg, f) => {
    if (f < WAKE) return { exposure: 0, shutter: 1 / 30, gain: 1, dark: true };
    const k = 1 - Math.exp(-(1 / FPS) / 0.42);     // ~0.4 s adaptation, like a cheap ISP
    logm += (Math.log(tg) - logm) * k;
    const m = Math.exp(logm);
    const shutter = Math.min(Math.max(m / K, 1 / 4000), 1 / 30);
    const gain = Math.min(Math.max(m / (K * shutter), 1), 14);
    return { exposure: K * shutter * gain, shutter, gain };
  });
}

function crumbBounds(sim) {
  const mn = [1e9, 0, 1e9], mx = [-1e9, 0.02, -1e9];
  for (const c of sim.crumbs) {
    mn[0] = Math.min(mn[0], c.x - 0.02); mn[2] = Math.min(mn[2], c.z - 0.02);
    mx[0] = Math.max(mx[0], c.x + 0.02); mx[2] = Math.max(mx[2], c.z + 0.02);
  }
  return [mn, mx];
}

async function main() {
  const o = args();
  const sim = T.simulate();
  const nFrames = Math.round(T.DURATION * FPS);
  const crumbBox = crumbBounds(sim);
  fs.mkdirSync(path.join(o.out, 'frames'), { recursive: true });
  fs.writeFileSync(path.join(o.out, 'events.json'), JSON.stringify(sim.events, null, 0));

  const { browser, page } = await launch(o);
  const info = await page.evaluate((cfg) => window.RV.init(cfg), loadShaders(sim.scene));
  console.log('GL:', info);

  const meterFile = path.join(o.out, 'meter.json');
  let lum;
  if (!o.remeter && fs.existsSync(meterFile)) lum = JSON.parse(fs.readFileSync(meterFile, 'utf8'));
  if (!lum || lum.length !== nFrames) lum = await meterAll(page, sim, crumbBox, nFrames, meterFile);
  const ae = exposureSchedule(lum);
  fs.writeFileSync(path.join(o.out, 'exposure.json'), JSON.stringify(ae));

  let list;
  if (o.still) list = o.still.split(',').map((s) => Math.round(parseFloat(s) * FPS));
  else {
    const [a, b] = (o.frames || `0:${nFrames}`).split(':').map(Number);
    list = []; for (let f = a; f < Math.min(b, nFrames); f++) list.push(f);
    if (o.worker) { const [wi, wn] = o.worker.split('/').map(Number); list = list.filter((f) => f % wn === wi); }
  }

  const t0 = Date.now(); let done = 0;
  const fileOf = (f) => path.join(o.out, 'frames', String(f).padStart(5, '0') + '.rgb');
  if (!o.still) { // skip finished frames, but re-run a short warm-up so temporal history exists
    const first = list.findIndex((f) => !fs.existsSync(fileOf(f)));
    list = first < 0 ? [] : list.slice(Math.max(0, first - 8));
  }
  for (const f of list) {
    const file = fileOf(f);
    const warm = !o.still && fs.existsSync(file);
    const t = f / FPS, e = ae[f];
    if (e.dark && !o.still) { // sensor not streaming yet: black frames
      const blk = Buffer.alloc(o.W * o.H * 3, 0);
      stampOSD(blk, o.W, o.H, t);
      fs.writeFileSync(file, blk); continue;
    }
    const pe = ae[Math.max(f - 1, 0)];
    const prevCam = T.cameraAt(sim, (f - 1) / FPS + 0.5 * READOUT + 0.5 * pe.shutter);
    const p = {
      ...frameParams(sim, crumbBox, t, e.shutter), W: o.W, H: o.H, spp: o.spp, frame: f, maxDepth: o.depth,
      exposure: e.exposure, gain: e.gain, sceneMean: lum[f], denoise: o.denoise, sigL: o.sigL,
      temporal: !o.still, maxN: o.maxN, prevPos: prevCam.pos, prevRot: prevCam.rot,
    };
    const r = await page.evaluate((p) => window.RV.frame(p), p);
    const buf = Buffer.from(r.b64, 'base64');
    stampOSD(buf, o.W, o.H, t);
    if (o.still) {
      const png = path.join(o.out, `still_${t.toFixed(2)}s.png`);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${o.W}x${o.H}`, '-i', '-', png], { input: buf });
      console.log(`${png}  ${r.ms.toFixed(0)} ms  shutter 1/${(1 / e.shutter).toFixed(0)} gain ${e.gain.toFixed(2)}`);
    } else if (!warm) {
      fs.writeFileSync(file + '.tmp', buf);
      fs.renameSync(file + '.tmp', file);
      done++;
      const el = (Date.now() - t0) / 1000;
      if (done % 10 === 0) console.log(`frame ${f}  ${r.ms.toFixed(0)} ms  avg ${(el / done).toFixed(2)} s/f  eta ${((list.length - done) * el / done / 60).toFixed(1)} min`);
    }
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
