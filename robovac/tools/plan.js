// Top-down debug map of the room, collision map and simulated route.
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');
const S = require('../src/scene');
const T = require('../src/timeline');
const sim = T.simulate();
const PX = 120, W = 6 * PX, H = 7 * PX;
const img = Buffer.alloc(W * H * 3, 0);
const put = (x, z, c) => { const i = Math.round(x * PX), j = Math.round((7 - z) * PX); if (i >= 0 && j >= 0 && i < W && j < H) img.set(c, (j * W + i) * 3); };
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
  const x = i / PX, z = 7 - j / PX, s = S.surfaceAt(x, z);
  img.set(s === 'rug' ? [90, 30, 30] : s === 'tile' ? [110, 110, 105] : s === 'threshold' ? [200, 200, 200] : [120, 85, 50], (j * W + i) * 3);
}
for (const o of S.obstacles2D(sim.scene)) {
  if (o.type === 'rect') for (let x = o.x0; x <= o.x1; x += 0.004) for (let z = o.z0; z <= o.z1; z += 0.004) put(x, z, [255, 255, 0]);
  else for (let a = 0; a < 6.3; a += 0.05) for (let r = 0; r <= o.r; r += 0.003) put(o.x + Math.cos(a) * r, o.z + Math.sin(a) * r, [255, 255, 0]);
}
for (const g of sim.scene.groups) for (const it of g.items) if (it.type === 'box' && !it.solid && it.min[1] > 0.1) {
  for (let x = it.min[0]; x <= it.max[0]; x += 0.03) { put(x, it.min[2], [0, 200, 255]); put(x, it.max[2], [0, 200, 255]); }
  for (let z = it.min[2]; z <= it.max[2]; z += 0.03) { put(it.min[0], z, [0, 200, 255]); put(it.max[0], z, [0, 200, 255]); }
}
for (const c of sim.crumbs) put(c.x, c.z, c.eaten >= 0 ? [0, 255, 0] : [255, 0, 255]);
for (let i = 0; i < sim.n; i += 20) {
  const k = i / sim.n; put(sim.x[i], sim.z[i], [255 * k, 255, 255 * (1 - k)]);
  if (i % 3000 === 0) for (let a = 0; a < 6.3; a += 0.04) put(sim.x[i] + Math.cos(a) * 0.17, sim.z[i] + Math.sin(a) * 0.17, [255, 255, 255]);
}
// sun patch on the floor (where light through the window lands)
const sun = S.SUN_DIR;
for (let y = 0.45; y < 2.2; y += 0.01) for (let x = 2; x < 4; x += 0.01) {
  const t = y / sun[1]; put(x - sun[0] * t, 7 - sun[2] * t, [255, 240, 150]);
}
const out = process.argv[2] || 'plan.png';
fs.writeFileSync('/tmp/plan.ppm', Buffer.concat([Buffer.from(`P6 ${W} ${H} 255\n`), img]));
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', '/tmp/plan.ppm', out]);
const ev = sim.events.filter((e) => !['grout'].includes(e.type));
for (const e of ev) console.log(e.t.toFixed(2), e.type, e.kind || e.to || '', e.ang ? (e.ang * 57.3).toFixed(0) : '');
console.log('grout clicks', sim.events.filter((e) => e.type === 'grout').length, 'crumbs eaten', sim.crumbs.filter((c) => c.eaten >= 0).length);
const end = sim.n - 1; console.log('end pose', sim.x[end].toFixed(2), sim.z[end].toFixed(2), (sim.yaw[end] * 57.3 % 360).toFixed(0));
