// Burned-in timestamp, like the live view of a robot's camera. 5x7 bitmap
// glyphs are defined right here, so no font files are involved.
'use strict';

const GLYPHS = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '-': ['00000', '00000', '00000', '01110', '00000', '00000', '00000'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

const START = { h: 15, m: 42, s: 7 }; // wall-clock time when the run starts

function stampOSD(buf, W, H, t) {
  const sc = Math.max(1, Math.round(H / 270));
  const total = START.h * 3600 + START.m * 60 + START.s + Math.floor(t);
  const pad = (n) => String(n).padStart(2, '0');
  const text = `2026-11-19 ${pad(Math.floor(total / 3600) % 24)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
  const x0 = 14 * sc, y0 = H - 16 * sc;
  const plot = (x, y, v) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3;
    for (let c = 0; c < 3; c++) buf[i + c] = Math.round(buf[i + c] * (1 - v.a) + v.c * v.a);
  };
  for (const pass of [{ dx: sc, dy: sc, c: 0, a: 0.55 }, { dx: 0, dy: 0, c: 235, a: 0.88 }]) {
    let cx = x0;
    for (const ch of text) {
      const g = GLYPHS[ch];
      for (let r = 0; r < 7; r++) for (let q = 0; q < 5; q++) {
        if (g[r][q] !== '1') continue;
        for (let yy = 0; yy < sc; yy++) for (let xx = 0; xx < sc; xx++) plot(cx + q * sc + xx + pass.dx, y0 + r * sc + yy + pass.dy, pass);
      }
      cx += 6 * sc;
    }
  }
}

module.exports = { stampOSD };
