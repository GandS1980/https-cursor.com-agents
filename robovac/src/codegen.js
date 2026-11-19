// Packs the scene into uniform arrays for the path tracer's traversal loop.
// Primitives are sorted by group and by type; each group has an AABB and
// index ranges per primitive type. On a real GPU and on SwiftShader alike,
// data-driven loops keep the shader small and let rays skip whole groups
// (a loop exits when no lane needs it; a masked `if` body does not).
'use strict';

function bounds(it) {
  switch (it.type) {
    case 'box': return [it.min, it.max];
    case 'obox': {
      const c = Math.abs(Math.cos(it.yaw)), s = Math.abs(Math.sin(it.yaw));
      const ex = it.h[0] * c + it.h[2] * s, ez = it.h[0] * s + it.h[2] * c;
      return [[it.c[0] - ex, it.c[1] - it.h[1], it.c[2] - ez], [it.c[0] + ex, it.c[1] + it.h[1], it.c[2] + ez]];
    }
    case 'cyl': case 'tube': {
      const mn = [0, 1, 2].map((i) => Math.min(it.a[i], it.b[i]) - it.r);
      const mx = [0, 1, 2].map((i) => Math.max(it.a[i], it.b[i]) + it.r);
      return [mn, mx];
    }
    case 'ell': {
      const m = Math.max(it.r[0], it.r[2]);
      return [[it.c[0] - m, it.c[1] - it.r[1], it.c[2] - m], [it.c[0] + m, it.c[1] + it.r[1], it.c[2] + m]];
    }
  }
  throw new Error('unknown prim ' + it.type);
}

function packScene(scene) {
  const box = [], obox = [], cyl = [], ell = [], grp = [];
  for (const g of scene.groups) {
    let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (const it of g.items) {
      const [a, b] = bounds(it);
      mn = mn.map((v, i) => Math.min(v, a[i])); mx = mx.map((v, i) => Math.max(v, b[i]));
    }
    const r = { b0: box.length / 8, o0: obox.length / 12, c0: cyl.length / 12, e0: ell.length / 12 };
    for (const it of g.items) {
      const id = it.id ?? 0;
      if (it.type === 'box') box.push(...it.min, it.mat, ...it.max, id);
      else if (it.type === 'obox') obox.push(...it.c, it.mat, ...it.h, id, Math.cos(it.yaw), Math.sin(it.yaw), 0, 0);
      else if (it.type === 'cyl' || it.type === 'tube') cyl.push(...it.a, it.mat, ...it.b, id, it.r, it.type === 'tube' ? 0 : 1, 0, 0);
      else if (it.type === 'ell') ell.push(...it.c, it.mat, ...it.r, id, Math.cos(it.yaw), Math.sin(it.yaw), 0, 0);
    }
    grp.push(mn[0] - 0.002, mn[1] - 0.002, mn[2] - 0.002, r.b0, mx[0] + 0.002, mx[1] + 0.002, mx[2] + 0.002, box.length / 8,
      r.o0, obox.length / 12, r.c0, cyl.length / 12, r.e0, ell.length / 12, g.detail ? 1 : 0, 0);
  }
  const n = { NG: grp.length / 16, NB: box.length / 8, NO: obox.length / 12, NC: cyl.length / 12, NE: ell.length / 12 };
  const defines = Object.entries(n).map(([k, v]) => `#define ${k} ${Math.max(v, 1)}`).join('\n');
  const pad = (a, len) => { while (a.length < len) a.push(0); return a; };
  return {
    defines,
    counts: n,
    uniforms: {
      uGrp: grp, uBox: pad(box, Math.max(n.NB, 1) * 8), uOBox: pad(obox, Math.max(n.NO, 1) * 12),
      uCyl: pad(cyl, Math.max(n.NC, 1) * 12), uEll: pad(ell, Math.max(n.NE, 1) * 12),
    },
  };
}

module.exports = { packScene };
