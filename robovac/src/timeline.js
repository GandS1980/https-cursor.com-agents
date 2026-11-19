// Robot-vacuum motion simulation. Integrates a differential-drive robot at
// 1 kHz through a scripted cleaning run, resolves bumper contacts against
// the scene's 2D collision map, runs a spring-damper chassis over the real
// floor micro-height, and logs every event the sound design needs.
'use strict';
const S = require('./scene');

const DT = 1 / 1000;
const R_BODY = 0.17;              // bumper radius
const CAM = { fwd: 0.155, h: 0.083, tilt: 6.5 * Math.PI / 180 };
const WHEEL_Y = 0.115;            // drive wheels at +-11.5 cm lateral, on the axle through the centre
const CASTER = 0.13;              // front caster ahead of the axle
const ACC = 0.55, ALPHA = 5.0;    // m/s^2, rad/s^2

const DURATION = 53.0;
const rand = S.mulberry32(4242);

// The cleaning run. Distances are maxima: a bumper hit ends a leg early.
const SCRIPT = [
  { wait: 2.8 },                              // docked, facing the room: camera wakes, boot chime, fan spins up
  { fwd: 0.32, v: 0.16 },                     // roll off the dock
  { wait: 0.25 },
  { face: [2.41, 4.26], w: 1.2 },
  { fwd: 3.0, v: 0.28 },                      // oak -> rug edge -> through the cereal -> coffee-table leg
  { fwd: -0.15, v: 0.12 },
  { face: [6.1, 3.95], w: 1.3 },
  { fwd: 4.5, v: 0.28 },                      // past the legs, across the sunlit rug, in under the sofa -> wall
  { fwd: -0.06, v: 0.1 },
  { face: [3.85, 1.05], w: 1.4 },             // swing round in the dark
  { fwd: 4.0, v: 0.28, avoid: 'sock' },       // over the threshold onto tile; vision spots the sock, stops short
  { wait: 0.9 },
  { face: [3.95, 3.2], w: 1.3, event: 'return' }, // heads home
  { fwd: 3.0, v: 0.28 },
  { wait: 99 },
];

const DOCK = { x: 0.30, z: 3.0 };

function circleRectHit(x, z, r, o) {
  const cx = Math.max(o.x0, Math.min(x, o.x1)), cz = Math.max(o.z0, Math.min(z, o.z1));
  return (x - cx) ** 2 + (z - cz) ** 2 < r * r;
}
function collide(obs, x, z, r) {
  for (const o of obs) {
    if (o.type === 'rect' ? circleRectHit(x, z, r, o) : (x - o.x) ** 2 + (z - o.z) ** 2 < (r + o.r) ** 2) return o;
  }
  return null;
}

function simulate() {
  const scene = S.buildScene();
  const obs = S.obstacles2D(scene);
  const sock = scene.groups.find((g) => g.name === 'sock').items;
  const sockPt = { x: sock[0].c[0], z: sock[0].c[2] };

  const N = Math.round(DURATION / DT) + 1;
  const out = {
    dt: DT, n: N, x: new Float64Array(N), z: new Float64Array(N), yaw: new Float64Array(N),
    v: new Float64Array(N), w: new Float64Array(N), pitch: new Float64Array(N), roll: new Float64Array(N),
    heave: new Float64Array(N), fan: new Float64Array(N), events: [], surface: new Array(N),
  };

  let x = DOCK.x, z = DOCK.z, yaw = 0, v = 0, w = 0;
  let ci = 0, cmd = null, cmdState = null;
  // chassis suspension state (pitch, roll, heave) as damped springs
  const sp = { p: 0, pv: 0, r: 0, rv: 0, h: 0, hv: 0 };
  const springs = { k: (2 * Math.PI * 9) ** 2, c: 2 * 0.35 * (2 * Math.PI * 9) };
  let jolt = 0; // bumper impulse state
  let prevSurf = S.surfaceAt(x + CASTER * Math.cos(yaw), z + CASTER * Math.sin(yaw));
  const lastGrout = { c: null, l: null, r: null };
  const crumbs = scene.crumbs.map((c) => ({ ...c, eaten: -1 }));

  function startCmd(c, t) {
    cmd = c; cmdState = { t0: t, x0: x, z0: z, yaw0: yaw };
    if (c.face) { c = { ...c, turn: Math.atan2(c.face[1] - z, c.face[0] - x) * 180 / Math.PI - yaw * 180 / Math.PI }; cmd = c; }
    if (c.event) out.events.push({ t, type: c.event });
    if (c.turn !== undefined) {
      let ang;
      ang = c.turn * Math.PI / 180;
      ang = Math.atan2(Math.sin(ang), Math.cos(ang));
      cmdState.target = yaw + ang;
      out.events.push({ t, type: 'turn', ang });
    }
    if (c.fwd !== undefined) {
      const d = c.fwd;
      cmdState.dist = Math.abs(d); cmdState.dir = Math.sign(d) || 1;
    }
    if (c.wait !== undefined) cmdState.until = t + c.wait;
  }

  out.events.push({ t: 0.85, type: 'boot' });
  out.events.push({ t: 1.7, type: 'fan_on' });
  let fan = 0;

  for (let i = 0; i < N; i++) {
    const t = i * DT;
    if (!cmd || cmdState.done) {
      if (ci < SCRIPT.length) startCmd(SCRIPT[ci++], t);
    }
    // ---- command -> target velocities
    let vt = 0, wt = 0;
    if (cmd.wait !== undefined) {
      if (t >= cmdState.until) cmdState.done = true;
    } else if (cmd.turn !== undefined) {
      const rem = cmdState.target - yaw;
      const wmax = cmd.w;
      // trapezoid: decelerate to land exactly
      const wstop = Math.sqrt(2 * ALPHA * Math.abs(rem));
      wt = Math.sign(rem) * Math.min(wmax, wstop);
      if (Math.abs(rem) < 0.002 && Math.abs(w) < 0.05) { cmdState.done = true; wt = 0; w = 0; }
    } else if (cmd.fwd !== undefined) {
      const trav = Math.hypot(x - cmdState.x0, z - cmdState.z0);
      const rem = cmdState.dist - trav;
      let vmax = cmd.v;
      if (cmd.avoid === 'sock') {
        const ds = Math.hypot(sockPt.x - x, sockPt.z - z) - R_BODY - 0.4;
        if (ds < 0.25) vmax = Math.min(vmax, Math.max(0, ds) * 1.2);
        if (ds < 0.02 && !cmdState.spotted) { cmdState.spotted = true; out.events.push({ t, type: 'avoid' }); }
        if (ds < 0.005) { cmdState.done = true; }
      }
      const vstop = Math.sqrt(2 * ACC * Math.max(rem, 0));
      vt = cmdState.dir * Math.min(vmax, vstop);
      if (rem < 0.0008) { cmdState.done = true; vt = 0; }
    }
    // ---- accelerate toward targets
    const dv = vt - v, dw = wt - w;
    v += Math.sign(dv) * Math.min(Math.abs(dv), ACC * DT);
    w += Math.sign(dw) * Math.min(Math.abs(dw), ALPHA * DT);

    // ---- integrate with bumper collision
    const nx = x + v * Math.cos(yaw) * DT, nz = z + v * Math.sin(yaw) * DT;
    const hit = collide(obs, nx, nz, R_BODY);
    if (hit && Math.abs(v) > 1e-4) {
      out.events.push({ t, type: 'bump', kind: hit.kind, v: Math.abs(v) });
      jolt = Math.abs(v) / 0.27;
      v = 0; cmdState.done = true;
    } else { x = nx; z = nz; }
    yaw += w * DT;

    // ---- fan state
    if (t > 1.7) fan = Math.min(1, fan + DT / 1.4);

    // ---- floor under the wheels -> suspension
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const fx = x + CASTER * c, fz = z + CASTER * s;
    const lx = x - WHEEL_Y * s, lz = z + WHEEL_Y * c, rx = x + WHEEL_Y * s, rz = z - WHEEL_Y * c;
    const hF = S.floorHeight(fx, fz), hL = S.floorHeight(lx, lz), hR = S.floorHeight(rx, rz);
    const axleH = (hL + hR) / 2;
    const pitchT = Math.atan2(hF - axleH, CASTER);
    const rollT = Math.atan2(hL - hR, 2 * WHEEL_Y);
    const surf = S.surfaceAt(x, z);
    // rug pile + motor vibration as broadband excitation
    const rough = surf === 'rug' ? 0.004 : surf === 'tile' ? 0.0008 : 0.0011;
    const sp_ = Math.abs(v) / 0.27 + Math.abs(w) * 0.15;
    const ex = (rand() - 0.5) * rough * sp_ * 60;
    const step = (state, key, vkey, target) => {
      const a = springs.k * (target - state[key]) - springs.c * state[vkey];
      state[vkey] += a * DT; state[key] += state[vkey] * DT;
    };
    step(sp, 'p', 'pv', pitchT);
    step(sp, 'r', 'rv', rollT);
    step(sp, 'h', 'hv', axleH);
    sp.pv += ex * 0.6; sp.rv += ex * 0.5 * (rand() - 0.5) * 2;
    // fan vibration: tiny high-frequency shimmer
    const buzz = fan * 0.00035 * Math.sin(t * 2 * Math.PI * 61) + fan * 0.0002 * Math.sin(t * 2 * Math.PI * 97.3);
    if (jolt > 0) { sp.pv -= jolt * 1.6; sp.rv += (rand() - 0.5) * jolt * 0.8; jolt = 0; }

    out.x[i] = x; out.z[i] = z; out.yaw[i] = yaw; out.v[i] = v; out.w[i] = w;
    out.pitch[i] = sp.p + buzz; out.roll[i] = sp.r + buzz * 0.6; out.heave[i] = sp.h; out.fan[i] = fan;
    out.surface[i] = surf;

    // ---- events for the sound designer
    const fs = S.surfaceAt(fx, fz);
    if (fs !== prevSurf) { out.events.push({ t, type: 'surface', from: prevSurf, to: fs }); prevSurf = fs; }
    for (const [key, px, pz] of [['c', fx, fz], ['l', lx, lz], ['r', rx, rz]]) {
      if (S.surfaceAt(px, pz) !== 'tile') { lastGrout[key] = null; continue; }
      const id = Math.floor(px / 0.3) * 1000 + Math.floor(pz / 0.3);
      if (lastGrout[key] !== null && lastGrout[key] !== id) out.events.push({ t, type: 'grout', wheel: key, v: Math.abs(v) });
      lastGrout[key] = id;
    }
    for (const cr of crumbs) {
      if (cr.eaten < 0 && Math.hypot(cr.x - x, cr.z - z) < 0.11) {
        cr.eaten = t; out.events.push({ t, type: 'crumb', r: cr.r });
      }
    }
    if (S.surfaceAt(x, z) && x > 5.05 && z > 3.3 && z < 5.7 && !out._under) { out._under = true; out.events.push({ t, type: 'under_sofa' }); }
    if (out._under && !(x > 5.0 && z > 3.3 && z < 5.7)) { out._under = false; out.events.push({ t, type: 'out_sofa' }); }
  }
  out.events.sort((a, b) => a.t - b.t);
  out.crumbs = crumbs;
  out.scene = scene;
  return out;
}

// camera pose (position + yaw/pitch/roll) at time t, linearly interpolated
function cameraAt(sim, t) {
  const fi = Math.max(0, Math.min(sim.n - 1.001, t / sim.dt));
  const i = Math.floor(fi), a = fi - i;
  const L = (arr) => arr[i] * (1 - a) + arr[i + 1] * a;
  const x = L(sim.x), z = L(sim.z), yaw = L(sim.yaw), pitch = L(sim.pitch), roll = L(sim.roll), heave = L(sim.heave);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  // camera sits ahead of the axle: chassis pitch lifts/lowers it
  const y = CAM.h + heave + Math.sin(pitch) * CAM.fwd;
  return { pos: [x + CAM.fwd * c, y, z + CAM.fwd * s], rot: [yaw, CAM.tilt + pitch, roll] };
}

// which crumbs still exist at time t
function crumbsAt(sim, t) {
  const arr = [];
  for (const c of sim.crumbs) arr.push(c.x, c.r * 0.6, c.z, c.eaten >= 0 && t >= c.eaten ? 0 : c.r);
  return arr;
}

module.exports = { simulate, cameraAt, crumbsAt, DURATION, CAM, R_BODY, DOCK };
