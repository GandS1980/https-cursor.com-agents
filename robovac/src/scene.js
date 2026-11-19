// Procedural apartment, built at floor level for a robot vacuum.
// One description feeds three consumers:
//   1. GLSL codegen (unrolled, AABB-culled intersection code for the path tracer)
//   2. the robot's 2D collision map (what the bumper can hit)
//   3. floor surface/height queries used by the motion + audio simulation
// Units: metres. y is up. Room interior is x[0,6] y[0,2.6] z[0,7].
'use strict';

const ROOM = { w: 6.0, h: 2.6, d: 7.0 };
const WINDOW = { x0: 2.0, x1: 4.0, y0: 0.45, y1: 2.2 }; // opening in the north wall (z = 7)
const RUG = { x0: 1.6, x1: 4.2, z0: 3.4, z1: 5.6, h: 0.014 };
const TILE_Z = 2.2; // kitchen tile for z < TILE_Z, oak planks above
const SUN_DIR = norm([-0.45, 0.42, 1.0]); // direction *towards* the sun

const M = {
  FLOOR: 0, WALL: 1, CEIL: 2, BASEBOARD: 3, RUG: 4, WOOD_DARK: 5, FABRIC: 6, PLASTIC_BLACK: 7,
  CHROME: 8, STEEL: 9, BOOK: 10, TERRACOTTA: 11, SOIL: 12, LEAF: 13, SHADE: 14, BULB: 15,
  LED: 16, CABINET: 17, COUNTER: 18, SOCK: 19, CRUMB: 20, DUST: 21, LEGO: 22, PEN: 23,
  FELT: 24, FRAME: 25, BRASS: 26, PLINTH: 27, OUTLET: 28, ALU: 29, OAK: 30,
};

function norm(v) { const l = Math.hypot(...v); return v.map((c) => c / l); }

// deterministic RNG so the world is identical on every run
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- primitive helpers --------------------------------------------------
const box = (min, max, mat, opt = {}) => ({ type: 'box', min, max, mat, ...opt });
const obox = (c, h, yaw, mat, opt = {}) => ({ type: 'obox', c, h, yaw, mat, ...opt });
const cyl = (a, b, r, mat, opt = {}) => ({ type: 'cyl', a, b, r, mat, caps: true, ...opt });
const tube = (a, b, r, mat, opt = {}) => ({ type: 'tube', a, b, r, mat, ...opt });
const ell = (c, r, mat, opt = {}) => ({ type: 'ell', c, r, mat, yaw: 0, ...opt });
const vleg = (x, z, r, y0, y1, mat, opt) => cyl([x, y0, z], [x, y1, z], r, mat, opt);

function buildScene() {
  const rnd = mulberry32(1977);
  const groups = [];
  const G = (name, items, opt = {}) => { groups.push({ name, items, ...opt }); return items; };
  const DETAIL = { detail: true };

  // ---- baseboards + outlets ---------------------------------------------
  const bb = 0.09, bt = 0.012;
  G('baseboards', [
    box([0, 0, 0], [bt, bb, ROOM.d], M.BASEBOARD, { solid: 'wall' }),
    box([ROOM.w - bt, 0, 0], [ROOM.w, bb, ROOM.d], M.BASEBOARD, { solid: 'wall' }),
    box([0, 0, 0], [ROOM.w, bb, bt], M.BASEBOARD, { solid: 'wall' }),
    box([0, 0, ROOM.d - bt], [ROOM.w, bb, ROOM.d], M.BASEBOARD, { solid: 'wall' }),
  ]);
  G('outlets', [
    box([0, 0.28, 2.1], [0.008, 0.36, 2.15], M.OUTLET),
    box([0.008, 0.31, 2.112], [0.010, 0.33, 2.118], M.PLASTIC_BLACK),
    box([5.992, 0.28, 6.1], [6.0, 0.36, 6.15], M.OUTLET),
    box([1.2, 0.28, 6.992], [1.25, 0.36, 7.0], M.OUTLET),
  ], DETAIL);

  // ---- window reveal, frame, mullions, sill -------------------------------
  const { x0, x1, y0, y1 } = WINDOW;
  G('window', [
    box([x0 - 0.2, y0, 7.0], [x0, y1, 7.2], M.WALL),
    box([x1, y0, 7.0], [x1 + 0.2, y1, 7.2], M.WALL),
    box([x0, y1, 7.0], [x1, y1 + 0.1, 7.2], M.WALL),
    box([x0 - 0.05, y0 - 0.04, 6.93], [x1 + 0.05, y0, 7.2], M.FRAME), // sill
    box([x0, y0, 7.04], [x0 + 0.05, y1, 7.1], M.FRAME),
    box([x1 - 0.05, y0, 7.04], [x1, y1, 7.1], M.FRAME),
    box([x0, y0, 7.04], [x1, y0 + 0.05, 7.1], M.FRAME),
    box([x0, y1 - 0.05, 7.04], [x1, y1, 7.1], M.FRAME),
    box([2.98, y0, 7.05], [3.02, y1, 7.09], M.FRAME),
    box([x0, 1.31, 7.05], [x1, 1.35, 7.09], M.FRAME),
  ]);

  // ---- charging dock (west wall) -----------------------------------------
  const dz = 3.0;
  G('dock', [
    box([0.012, 0, dz - 0.17], [0.11, 0.105, dz + 0.17], M.PLASTIC_BLACK, { solid: 'dock' }),
    box([0.012, 0.105, dz - 0.15], [0.085, 0.13, dz + 0.15], M.PLASTIC_BLACK),
    box([0.11, 0, dz - 0.14], [0.2, 0.007, dz + 0.14], M.PLASTIC_BLACK), // ramp plate
  ]);
  G('dockdetail', [
    box([0.15, 0.007, dz - 0.09], [0.19, 0.009, dz - 0.05], M.ALU),
    box([0.15, 0.007, dz + 0.05], [0.19, 0.009, dz + 0.09], M.ALU),
    box([0.109, 0.075, dz - 0.012], [0.112, 0.081, dz + 0.012], M.LED),
    cyl([0.06, 0.13, dz], [0.06, 0.134, dz], 0.02, M.CHROME),
  ], DETAIL);

  // ---- bookshelf (west wall) ---------------------------------------------
  const sz0 = 4.6, sz1 = 5.6, sd = 0.34;
  const shelf = [
    box([0.012, 0, sz0], [sd, 1.8, sz0 + 0.02], M.OAK, { solid: 'shelf' }),
    box([0.012, 0, sz1 - 0.02], [sd, 1.8, sz1], M.OAK, { solid: 'shelf' }),
    box([sd - 0.03, 0, sz0 + 0.02], [sd - 0.01, 0.07, sz1 - 0.02], M.OAK, { solid: 'shelf' }),
    box([0.012, 0.07, sz0 + 0.02], [sd, 0.09, sz1 - 0.02], M.OAK),
    box([0.012, 0.42, sz0 + 0.02], [sd, 0.44, sz1 - 0.02], M.OAK),
    box([0.012, 0.80, sz0 + 0.02], [sd, 0.82, sz1 - 0.02], M.OAK),
    box([0.012, 1.78, sz0 + 0.02], [sd, 1.8, sz1 - 0.02], M.OAK),
  ];
  let bzp = sz0 + 0.03; let bid = 0;
  while (bzp < sz1 - 0.06) { // bottom row of books, slightly ragged
    const t = 0.018 + rnd() * 0.035, h = 0.20 + rnd() * 0.11, dpt = 0.17 + rnd() * 0.09;
    if (rnd() < 0.08) { bzp += 0.02; continue; }
    shelf.push(box([0.03, 0.09, bzp], [0.03 + dpt, 0.09 + h, bzp + t], M.BOOK, { id: bid++ }));
    bzp += t + 0.001;
  }
  bzp = sz0 + 0.03;
  while (bzp < sz1 - 0.3) {
    const t = 0.02 + rnd() * 0.03, h = 0.18 + rnd() * 0.12, dpt = 0.16 + rnd() * 0.1;
    shelf.push(box([0.03, 0.44, bzp], [0.03 + dpt, 0.44 + h, bzp + t], M.BOOK, { id: bid++ }));
    bzp += t + 0.001;
  }
  shelf.push(obox([0.17, 0.44 + 0.03, 5.35], [0.1, 0.03, 0.13], 0.3, M.BOOK, { id: 99 })); // a lying stack
  G('bookshelf', shelf.filter((it) => it.mat !== M.BOOK));
  G('books', shelf.filter((it) => it.mat === M.BOOK), DETAIL);

  // ---- potted plant (north-west corner) ------------------------------------
  const px = 0.5, pz = 6.5;
  const plant = [
    cyl([px, 0, pz], [px, 0.34, pz], 0.17, M.TERRACOTTA, { solid: 'pot' }),
    cyl([px, 0.34, pz], [px, 0.37, pz], 0.185, M.TERRACOTTA),
    cyl([px, 0.30, pz], [px, 0.345, pz], 0.165, M.SOIL),
  ];
  const leaves = [];
  for (let i = 0; i < 9; i++) {
    const a = i * 2.4 + rnd(), r = 0.06 + rnd() * 0.18, y = 0.45 + rnd() * 0.55;
    leaves.push(ell([px + Math.cos(a) * r, y, pz + Math.sin(a) * r], [0.16, 0.03, 0.07], M.LEAF, { yaw: a + 1.57, id: i }));
  }
  G('plant', plant);
  G('leaves', leaves, DETAIL);

  // ---- coffee table on the rug -------------------------------------------
  const ct = { x: 2.9, z: 4.5, w: 1.1, d: 0.6 };
  const ctLegs = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const lx = ct.x + sx * (ct.w / 2 - 0.06), lz = ct.z + sz * (ct.d / 2 - 0.06);
    ctLegs.push(vleg(lx, lz, 0.022, RUG.h, 0.40, M.WOOD_DARK, { solid: 'leg' }));
  }
  G('coffeetable', [
    box([ct.x - ct.w / 2, 0.40, ct.z - ct.d / 2], [ct.x + ct.w / 2, 0.44, ct.z + ct.d / 2], M.WOOD_DARK),
    box([ct.x - ct.w / 2 + 0.04, 0.36, ct.z - ct.d / 2 + 0.04], [ct.x + ct.w / 2 - 0.04, 0.40, ct.z + ct.d / 2 - 0.04], M.WOOD_DARK),
    ...ctLegs,
  ]);
  G('rug', [box([RUG.x0, 0, RUG.z0], [RUG.x1, RUG.h, RUG.z1], M.RUG)]);

  // ---- sofa (east wall), raised on legs so the robot fits underneath -------
  const sf = { x0: 5.05, x1: 5.99, z0: 3.3, z1: 5.7, yb: 0.125 };
  const sofa = [
    box([sf.x0, sf.yb, sf.z0], [sf.x1, 0.42, sf.z1], M.FABRIC),
    box([sf.x0 + 0.02, 0.42, sf.z0 + 0.2], [sf.x1 - 0.2, 0.52, (sf.z0 + sf.z1) / 2 - 0.005], M.FABRIC, { id: 1 }),
    box([sf.x0 + 0.02, 0.42, (sf.z0 + sf.z1) / 2 + 0.005], [sf.x1 - 0.2, 0.52, sf.z1 - 0.2], M.FABRIC, { id: 2 }),
    box([sf.x1 - 0.22, 0.42, sf.z0], [sf.x1, 0.95, sf.z1], M.FABRIC, { id: 3 }),
    box([sf.x0, 0.42, sf.z0], [sf.x1, 0.66, sf.z0 + 0.2], M.FABRIC, { id: 4 }),
    box([sf.x0, 0.42, sf.z1 - 0.2], [sf.x1, 0.66, sf.z1], M.FABRIC, { id: 5 }),
  ];
  for (const lx of [sf.x0 + 0.06, sf.x1 - 0.06]) for (const lz of [sf.z0 + 0.06, sf.z1 - 0.06, (sf.z0 + sf.z1) / 2]) {
    if (lz === (sf.z0 + sf.z1) / 2 && lx < 5.5) continue;
    sofa.push(cyl([lx, 0, lz], [lx, sf.yb, lz], 0.022, M.WOOD_DARK, { solid: 'leg', r1: 0.016 }));
  }
  G('sofa', sofa);
  // what lives under the sofa
  G('undersofa', [
    ell([5.45, 0.012, 3.64], [0.035, 0.012, 0.03], M.DUST, { id: 0 }),
    ell([5.8, 0.014, 4.36], [0.05, 0.015, 0.035], M.DUST, { id: 1, yaw: 0.7 }),
    ell([5.22, 0.01, 4.4], [0.03, 0.01, 0.026], M.DUST, { id: 2 }),
    ell([5.88, 0.012, 3.55], [0.04, 0.013, 0.03], M.DUST, { id: 3 }),
    cyl([5.55, 0, 4.3], [5.55, 0.0018, 4.3], 0.0115, M.BRASS),
    obox([5.36, 0.0095, 3.7], [0.016, 0.0095, 0.008], 0.5, M.LEGO),
    cyl([5.6, 0.0045, 3.62], [5.71, 0.0045, 3.53], 0.0045, M.PEN),
  ], DETAIL);

  // ---- floor lamp (north-east corner) -------------------------------------
  const lx = 5.55, lz = 6.6;
  G('lamp', [
    cyl([lx, 0, lz], [lx, 0.025, lz], 0.15, M.PLASTIC_BLACK, { solid: 'lampbase' }),
    cyl([lx, 0.025, lz], [lx, 1.4, lz], 0.012, M.PLASTIC_BLACK),
    tube([lx, 1.33, lz], [lx, 1.6, lz], 0.21, M.SHADE),
    ell([lx, 1.47, lz], [0.045, 0.045, 0.045], M.BULB),
  ]);

  // ---- slippers by the sofa ------------------------------------------------
  G('slippers', [
    ell([4.72, 0.022, 3.05], [0.13, 0.024, 0.05], M.FELT, { yaw: 0.25, id: 0 }),
    ell([4.68, 0.022, 2.88], [0.13, 0.024, 0.05], M.FELT, { yaw: -0.12, id: 1 }),
  ], DETAIL);

  // ---- kitchen: cabinets with toe-kick, fridge -----------------------------
  const kx0 = 0.6, kx1 = 4.4, kd = 0.6;
  const kitchen = [
    box([kx0, 0, 0.012], [kx1, 0.1, kd - 0.07], M.PLINTH, { solid: 'plinth' }),
    box([kx0, 0.1, 0.012], [kx1, 0.88, kd], M.CABINET),
    box([kx0 - 0.01, 0.88, 0], [kx1 + 0.01, 0.92, kd + 0.03], M.COUNTER),
  ];
  const handles = [];
  for (let x = kx0; x < kx1 - 0.1; x += 0.6) {
    handles.push(box([x + 0.25, 0.78, kd], [x + 0.35, 0.79, kd + 0.025], M.STEEL));
  }
  G('kitchen', kitchen);
  G('handles', handles, DETAIL);
  G('fridge', [
    box([4.45, 0.012, 0.012], [5.3, 1.85, 0.72], M.STEEL, { solid: 'fridge' }),
    box([5.1, 0.95, 0.72], [5.12, 1.5, 0.75], M.STEEL),
  ]);

  // ---- dining table + chairs on the tile ----------------------------------
  const dt = { x: 2.3, z: 1.55, w: 1.3, d: 0.8 };
  const dining = [box([dt.x - dt.w / 2, 0.72, dt.z - dt.d / 2], [dt.x + dt.w / 2, 0.75, dt.z + dt.d / 2], M.OAK)];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    dining.push(vleg(dt.x + sx * (dt.w / 2 - 0.05), dt.z + sz * (dt.d / 2 - 0.05), 0.025, 0, 0.72, M.OAK, { solid: 'leg' }));
  }
  G('dining', dining);
  const chair = (cx, cz, yaw) => {
    const items = [obox([cx, 0.455, cz], [0.21, 0.015, 0.21], yaw, M.OAK, { id: 7 })];
    const c = Math.cos(yaw), s = Math.sin(yaw);
    for (const [ax, az] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]]) {
      const wx = cx + ax * c - az * s, wz = cz + ax * s + az * c;
      items.push(vleg(wx, wz, 0.011, 0, 0.44, M.CHROME, { solid: 'leg' }));
    }
    // backrest uprights + rail
    const bx = cx + 0.19 * c, bz = cz + 0.19 * s;
    for (const o of [-0.18, 0.18]) items.push(vleg(bx - o * s, bz + o * c, 0.011, 0.44, 0.88, M.CHROME));
    items.push(obox([bx, 0.8, bz], [0.012, 0.07, 0.2], yaw, M.OAK, { id: 8 }));
    return items;
  };
  G('chair1', chair(1.33, 1.5, Math.PI));
  G('chair2', chair(3.27, 1.62, 0.0));
  G('threshold', [box([0.012, 0, TILE_Z - 0.02], [ROOM.w - 0.012, 0.005, TILE_Z + 0.02], M.ALU)], DETAIL);

  // ---- a sock on the tile (the robot's obstacle-avoidance moment) -----------
  // a crumpled sock: foot, heel, bent ankle, ribbed cuff
  const sk = { x: 3.84, z: 1.03, a: 0.55 };
  const along = (d, a = sk.a) => [sk.x + Math.cos(a) * d, sk.z + Math.sin(a) * d];
  const [hx, hz] = along(0.1);
  const ank = sk.a + 1.25;
  const ax = (d) => [hx + Math.cos(ank) * d, hz + Math.sin(ank) * d];
  G('sock', [
    ell([sk.x, 0.017, sk.z], [0.105, 0.018, 0.041], M.SOCK, { yaw: sk.a, id: 0 }),
    ell([hx, 0.021, hz], [0.04, 0.022, 0.04], M.SOCK, { yaw: sk.a, id: 2 }),
    ell([ax(0.06)[0], 0.02, ax(0.06)[1]], [0.07, 0.02, 0.039], M.SOCK, { yaw: ank, id: 1 }),
    ell([ax(0.125)[0], 0.022, ax(0.125)[1]], [0.025, 0.022, 0.043], M.SOCK, { yaw: ank, id: 3 }),
  ], DETAIL);

  // cereal crumbs on the rug, robot drives through them (dynamic: uniforms)
  const crumbs = [];
  for (let i = 0; i < 24; i++) {
    const a = rnd() * 6.283, r = Math.sqrt(rnd()) * 0.22;
    crumbs.push({
      x: 1.98 + Math.cos(a) * r * 1.3, z: 3.93 + Math.sin(a) * r * 0.8,
      r: 0.0035 + rnd() * 0.004,
    });
  }

  return { groups, crumbs };
}

// ---- 2D collision map: what the bumper touches ------------------------------
function obstacles2D(scene) {
  const out = [];
  // room walls (inner faces); baseboards are part of them
  const bt = 0.012;
  out.push({ kind: 'wall', type: 'rect', x0: -1, x1: bt, z0: -1, z1: 8 });
  out.push({ kind: 'wall', type: 'rect', x0: ROOM.w - bt, x1: 7, z0: -1, z1: 8 });
  out.push({ kind: 'wall', type: 'rect', x0: -1, x1: 7, z0: -1, z1: bt });
  out.push({ kind: 'wall', type: 'rect', x0: -1, x1: 7, z0: ROOM.d - bt, z1: 8 });
  for (const g of scene.groups) for (const it of g.items) {
    if (!it.solid || it.solid === 'wall') continue;
    if (it.type === 'box') out.push({ kind: it.solid, type: 'rect', x0: it.min[0], x1: it.max[0], z0: it.min[2], z1: it.max[2] });
    else if (it.type === 'cyl') out.push({ kind: it.solid, type: 'circle', x: it.a[0], z: it.a[2], r: it.r });
  }
  return out;
}

// ---- floor queries shared by motion sim and audio ----------------------------
function surfaceAt(x, z) {
  if (x > RUG.x0 && x < RUG.x1 && z > RUG.z0 && z < RUG.z1) return 'rug';
  if (Math.abs(z - TILE_Z) < 0.02) return 'threshold';
  if (z < TILE_Z) return 'tile';
  return 'wood';
}

function hash2(i, j) {
  let h = (i * 374761393 + j * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// micro height of the floor under a wheel (metres). Drives the suspension model.
function floorHeight(x, z) {
  const s = surfaceAt(x, z);
  if (s === 'rug') {
    const pile = (hash2(Math.floor(x * 400), Math.floor(z * 400)) - 0.5) * 0.0012;
    return RUG.h + pile;
  }
  if (s === 'threshold') return 0.005;
  if (s === 'tile') {
    const gx = Math.abs(((x + 0.15) % 0.3) - 0.15), gz = Math.abs(((z + 0.15) % 0.3) - 0.15);
    return (gx < 0.0025 || gz < 0.0025) ? -0.0009 : 0;
  }
  // oak: individual planks sit very slightly proud of each other
  const row = Math.floor(z / 0.19);
  const off = hash2(row, 7) * 1.4;
  const col = Math.floor((x + off) / 1.4);
  const seam = (z / 0.19 - row) < 0.012 || ((x + off) / 1.4 - col) < 0.002;
  return (hash2(row, col) - 0.5) * 0.0005 + (seam ? -0.0003 : 0);
}

module.exports = { ROOM, WINDOW, RUG, TILE_Z, SUN_DIR, M, buildScene, obstacles2D, surfaceAt, floorHeight, mulberry32 };
