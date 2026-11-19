#version 300 es
// Unidirectional path tracer for the robot-vacuum film.
// One draw = one sample per pixel; results are additively blended into
// float targets (radiance, first-hit albedo, first-hit normal+depth).
precision highp float;
precision highp int;

layout(location = 0) out vec4 oCol;
layout(location = 1) out vec4 oAlb;
layout(location = 2) out vec4 oNrm;

uniform vec2  uRes;
uniform uint  uSeed;          // frame * 1024 + sample index
uniform vec3  uPosK[6];       // camera position keys across the readout window
uniform vec3  uRotK[6];       // yaw, pitch, roll keys
uniform float uSpan;          // seconds covered by the keys
uniform float uReadout;       // rolling-shutter readout time (s)
uniform float uShutter;       // exposure time (s)
uniform float uTime;          // scene time at frame start (s), drives the wind
uniform vec4  uCrumbs[24];    // xyz, radius (0 = already eaten)
uniform vec3  uCrumbMin, uCrumbMax;
uniform int   uMaxDepth;
uniform int   uHQ;            // 0 for exposure metering renders
uniform float uHalfFov;       // radians, horizontal half field of view
uniform float uFish;          // 0 = rectilinear-ish, 1 = equidistant fisheye

const float PI = 3.14159265359;
// SIMD back-ends run both sides of a divergent `if` under a mask, but must
// leave a loop once no lane is active: WHEN(c) only costs anything if some
// lane in the SIMD group actually needs the branch.
#define WHEN(c) for (int when_ = 0; when_ < ((c) ? 1 : 0); when_++)
const float EPS = 2e-4;
const float FAR = 1e4;

#define M_FLOOR 0
#define M_WALL 1
#define M_CEIL 2
#define M_BASEBOARD 3
#define M_RUG 4
#define M_WOOD_DARK 5
#define M_FABRIC 6
#define M_PLASTIC_BLACK 7
#define M_CHROME 8
#define M_STEEL 9
#define M_BOOK 10
#define M_TERRACOTTA 11
#define M_SOIL 12
#define M_LEAF 13
#define M_SHADE 14
#define M_BULB 15
#define M_LED 16
#define M_CABINET 17
#define M_COUNTER 18
#define M_SOCK 19
#define M_CRUMB 20
#define M_DUST 21
#define M_LEGO 22
#define M_PEN 23
#define M_FELT 24
#define M_FRAME 25
#define M_BRASS 26
#define M_PLINTH 27
#define M_OUTLET 28
#define M_ALU 29
#define M_OAK 30

// scene constants (kept in sync with src/scene.js)
const vec3 ROOM = vec3(6.0, 2.6, 7.0);
const vec4 WIN = vec4(2.0, 4.0, 0.45, 2.2);     // x0 x1 y0 y1
const vec4 RUGR = vec4(1.6, 4.2, 3.4, 5.6);     // x0 x1 z0 z1
const float TILE_Z = 2.2;
const vec3 SUN = vec3(-0.38322, 0.35767, 0.85159);
const float SUN_COS = 0.99980;                  // ~1.15 degree cone (soft-ish sun)
const vec3 SUN_E = vec3(1.0, 0.92, 0.80) * 7.0; // irradiance
const vec3 BULB_P = vec3(5.55, 1.47, 6.6);
const float BULB_R = 0.045;
const vec3 BULB_L = vec3(1.0, 0.66, 0.34) * 95.0;
const float HAZE = 0.035;                       // dust in the air (1/m)

// ------------------------------------------------------------------ rng
uint rs;
uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float rnd() { rs = pcg(rs); return float(rs) * (1.0 / 4294967296.0); }
float hcell(vec2 c) {
  uvec2 u = uvec2(ivec2(c) + ivec2(65536));
  return float(pcg(u.x + pcg(u.y))) * (1.0 / 4294967296.0);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hcell(i), hcell(i + vec2(1, 0)), f.x),
             mix(hcell(i + vec2(0, 1)), hcell(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p, int oct) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) {
    if (i >= oct) break;
    s += a * vnoise(p);
    p = p * 2.03 + vec2(17.1, 9.3);
    a *= 0.5;
  }
  return s;
}

// ------------------------------------------------------------ intersection
struct Hit { float t; vec3 n; int mat; float id; vec3 lp; };

bool aabb(vec3 ro, vec3 ird, vec3 mn, vec3 mx, float tmax) {
  vec3 t0 = (mn - ro) * ird, t1 = (mx - ro) * ird;
  vec3 a = min(t0, t1), b = max(t0, t1);
  float tn = max(max(a.x, a.y), a.z), tf = min(min(b.x, b.y), b.z);
  return tf >= max(tn, 0.0) && tn < tmax;
}

void hitBox(vec3 ro, vec3 rd, vec3 ird, vec3 mn, vec3 mx, int mat, float id, inout Hit h) {
  vec3 t0 = (mn - ro) * ird, t1 = (mx - ro) * ird;
  vec3 a = min(t0, t1), b = max(t0, t1);
  float tn = max(max(a.x, a.y), a.z), tf = min(min(b.x, b.y), b.z);
  if (tn > tf || tn < EPS || tn >= h.t) return;
  h.t = tn; h.mat = mat; h.id = id;
  h.n = (tn == a.x) ? vec3(-sign(rd.x), 0, 0) : (tn == a.y) ? vec3(0, -sign(rd.y), 0) : vec3(0, 0, -sign(rd.z));
  h.lp = ro + rd * tn - mn;
}

void hitOBox(vec3 ro, vec3 rd, vec3 c, vec3 hs, float cy, float sy, int mat, float id, inout Hit h) {
  vec3 d = ro - c;
  vec3 lo = vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy);
  vec3 ld = vec3(rd.x * cy + rd.z * sy, rd.y, -rd.x * sy + rd.z * cy);
  vec3 ird = 1.0 / ld;
  vec3 t0 = (-hs - lo) * ird, t1 = (hs - lo) * ird;
  vec3 a = min(t0, t1), b = max(t0, t1);
  float tn = max(max(a.x, a.y), a.z), tf = min(min(b.x, b.y), b.z);
  if (tn > tf || tn < EPS || tn >= h.t) return;
  vec3 n = (tn == a.x) ? vec3(-sign(ld.x), 0, 0) : (tn == a.y) ? vec3(0, -sign(ld.y), 0) : vec3(0, 0, -sign(ld.z));
  h.t = tn; h.mat = mat; h.id = id;
  h.n = vec3(n.x * cy - n.z * sy, n.y, n.x * sy + n.z * cy);
  h.lp = lo + ld * tn + hs;
}

void hitCyl(vec3 ro, vec3 rd, vec3 a, vec3 b, float r, int mat, float id, inout Hit h) {
  vec3 ba = b - a, oc = ro - a;
  float baba = dot(ba, ba), bard = dot(ba, rd), baoc = dot(ba, oc);
  float k2 = baba - bard * bard;
  float k1 = baba * dot(oc, rd) - baoc * bard;
  float k0 = baba * dot(oc, oc) - baoc * baoc - r * r * baba;
  float hh = k1 * k1 - k2 * k0;
  if (hh < 0.0) return;
  hh = sqrt(hh);
  float t = (-k1 - hh) / k2;
  float y = baoc + t * bard;
  float L = sqrt(baba);
  if (y > 0.0 && y < baba) {
    if (t > EPS && t < h.t) {
      h.t = t; h.mat = mat; h.id = id;
      h.n = (oc + t * rd - ba * y / baba) / r;
      vec3 q = oc + t * rd;
      h.lp = vec3(y / L, atan(q.z, q.x), 1.0);
    }
    return;
  }
  t = (((y < 0.0) ? 0.0 : baba) - baoc) / bard;
  if (abs(k1 + k2 * t) < hh && t > EPS && t < h.t) {
    h.t = t; h.mat = mat; h.id = id;
    h.n = ba * sign(y) / L;
    vec3 q = oc + t * rd;
    h.lp = vec3((y < 0.0) ? 0.0 : L, atan(q.z, q.x), 0.0);
  }
}

void hitTube(vec3 ro, vec3 rd, vec3 a, vec3 b, float r, int mat, float id, inout Hit h) {
  vec3 ba = b - a, oc = ro - a;
  float baba = dot(ba, ba), bard = dot(ba, rd), baoc = dot(ba, oc);
  float k2 = baba - bard * bard;
  float k1 = baba * dot(oc, rd) - baoc * bard;
  float k0 = baba * dot(oc, oc) - baoc * baoc - r * r * baba;
  float hh = k1 * k1 - k2 * k0;
  if (hh < 0.0) return;
  hh = sqrt(hh);
  for (int i = 0; i < 2; i++) {
    float t = (-k1 + (i == 0 ? -hh : hh)) / k2;
    float y = baoc + t * bard;
    if (y > 0.0 && y < baba && t > EPS && t < h.t) {
      h.t = t; h.mat = mat; h.id = id;
      h.n = (oc + t * rd - ba * y / baba) / r;
      h.lp = vec3(y / sqrt(baba), 0.0, 0.0);
      return;
    }
  }
}

void hitEll(vec3 ro, vec3 rd, vec3 c, vec3 r, float cy, float sy, int mat, float id, inout Hit h) {
  vec3 d = ro - c;
  vec3 lo = vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy) / r;
  vec3 ld = vec3(rd.x * cy + rd.z * sy, rd.y, -rd.x * sy + rd.z * cy) / r;
  float A = dot(ld, ld), B = dot(lo, ld), C = dot(lo, lo) - 1.0;
  float D = B * B - A * C;
  if (D < 0.0) return;
  float t = (-B - sqrt(D)) / A;
  if (t < EPS || t >= h.t) return;
  vec3 lp = lo + ld * t;
  vec3 ln = normalize(lp / r);
  h.t = t; h.mat = mat; h.id = id;
  h.n = vec3(ln.x * cy - ln.z * sy, ln.y, ln.x * sy + ln.z * cy);
  h.lp = lp;
}

// interior of the room: we are always inside, so take the exit face
void hitRoom(vec3 ro, vec3 rd, vec3 ird, inout Hit h) {
  vec3 t0 = -ro * ird, t1 = (ROOM - ro) * ird;
  vec3 b = max(t0, t1);
  float tf = min(min(b.x, b.y), b.z);
  if (tf < EPS || tf >= h.t) return;
  vec3 p = ro + rd * tf;
  vec3 n = (tf == b.x) ? vec3(-sign(rd.x), 0, 0) : (tf == b.y) ? vec3(0, -sign(rd.y), 0) : vec3(0, 0, -sign(rd.z));
  if (n.z < -0.5 && p.x > WIN.x && p.x < WIN.y && p.y > WIN.z && p.y < WIN.w) return; // window opening
  h.t = tf; h.n = n; h.id = 0.0; h.lp = p;
  h.mat = n.y > 0.5 ? M_FLOOR : (n.y < -0.5 ? M_CEIL : M_WALL);
}

//__SCENE_DEFINES__
uniform vec4 uGrp[NG * 4];
uniform vec4 uBox[NB * 2];
uniform vec4 uOBox[NO * 3];
uniform vec4 uCyl[NC * 3];
uniform vec4 uEll[NE * 3];

// t-only intersectors: traversal tracks (t, kind, index); the winner is
// re-intersected once with the full routine to get normal, material, uv.
float tBox(vec3 ro, vec3 ird, vec3 mn, vec3 mx) {
  vec3 t0 = (mn - ro) * ird, t1 = (mx - ro) * ird;
  vec3 a = min(t0, t1), b = max(t0, t1);
  float tn = max(max(a.x, a.y), a.z), tf = min(min(b.x, b.y), b.z);
  return (tn <= tf && tn > EPS) ? tn : FAR;
}
float tOBox(vec3 ro, vec3 rd, vec3 c, vec3 hs, float cy, float sy) {
  vec3 d = ro - c;
  vec3 lo = vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy);
  vec3 ld = vec3(rd.x * cy + rd.z * sy, rd.y, -rd.x * sy + rd.z * cy);
  return tBox(lo, 1.0 / ld, -hs, hs);
}
float tCyl(vec3 ro, vec3 rd, vec3 a, vec3 b, float r, bool caps) {
  vec3 ba = b - a, oc = ro - a;
  float baba = dot(ba, ba), bard = dot(ba, rd), baoc = dot(ba, oc);
  float k2 = baba - bard * bard;
  float k1 = baba * dot(oc, rd) - baoc * bard;
  float k0 = baba * dot(oc, oc) - baoc * baoc - r * r * baba;
  float hh = k1 * k1 - k2 * k0;
  if (hh < 0.0) return FAR;
  hh = sqrt(hh);
  float t = (-k1 - hh) / k2, y = baoc + t * bard;
  if (y > 0.0 && y < baba && t > EPS) return t;
  if (caps) {
    if (y > 0.0 && y < baba) return FAR;
    float tc = (((y < 0.0) ? 0.0 : baba) - baoc) / bard;
    return (abs(k1 + k2 * tc) < hh && tc > EPS) ? tc : FAR;
  }
  t = (-k1 + hh) / k2; y = baoc + t * bard;
  return (y > 0.0 && y < baba && t > EPS) ? t : FAR;
}
float tEll(vec3 ro, vec3 rd, vec3 c, vec3 r, float cy, float sy) {
  vec3 d = ro - c;
  vec3 lo = vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy) / r;
  vec3 ld = vec3(rd.x * cy + rd.z * sy, rd.y, -rd.x * sy + rd.z * cy) / r;
  float A = dot(ld, ld), B = dot(lo, ld), C = dot(lo, lo) - 1.0;
  float D = B * B - A * C;
  if (D < 0.0) return FAR;
  float t = (-B - sqrt(D)) / A;
  return t > EPS ? t : FAR;
}

Hit trace(vec3 ro, vec3 rd, float tmax, bool lod) {
  Hit h; h.t = tmax; h.mat = -1; h.id = 0.0; h.n = vec3(0, 1, 0); h.lp = vec3(0);
  vec3 ird = 1.0 / rd;
  hitRoom(ro, rd, ird, h);
  float best = h.t; int kind = 0, idx = 0;
  for (int g = 0; g < NG; g++) {
    vec4 A = uGrp[g * 4], Bm = uGrp[g * 4 + 1], C = uGrp[g * 4 + 2], D = uGrp[g * 4 + 3];
    if ((lod && D.z > 0.5) || !aabb(ro, ird, A.xyz, Bm.xyz, best)) continue;
    for (int i = int(A.w); i < int(Bm.w); i++) {
      float t = tBox(ro, ird, uBox[i * 2].xyz, uBox[i * 2 + 1].xyz);
      if (t < best) { best = t; kind = 1; idx = i; }
    }
    for (int i = int(C.x); i < int(C.y); i++) {
      vec4 c = uOBox[i * 3 + 2];
      float t = tOBox(ro, rd, uOBox[i * 3].xyz, uOBox[i * 3 + 1].xyz, c.x, c.y);
      if (t < best) { best = t; kind = 2; idx = i; }
    }
    for (int i = int(C.z); i < int(C.w); i++) {
      vec4 c = uCyl[i * 3 + 2];
      float t = tCyl(ro, rd, uCyl[i * 3].xyz, uCyl[i * 3 + 1].xyz, c.x, c.y > 0.5);
      if (t < best) { best = t; kind = 3; idx = i; }
    }
    for (int i = int(D.x); i < int(D.y); i++) {
      vec4 c = uEll[i * 3 + 2];
      float t = tEll(ro, rd, uEll[i * 3].xyz, uEll[i * 3 + 1].xyz, c.x, c.y);
      if (t < best) { best = t; kind = 4; idx = i; }
    }
  }
  if (!lod && aabb(ro, ird, uCrumbMin, uCrumbMax, best)) {
    for (int i = 0; i < 24; i++) {
      vec4 c = uCrumbs[i];
      float t = c.w > 0.0 ? tEll(ro, rd, c.xyz, vec3(c.w, c.w * 0.6, c.w * 1.2), 0.8, 0.6) : FAR;
      if (t < best) { best = t; kind = 5; idx = i; }
    }
  }
  if (kind > 0) {
    h.t = best * 1.0001 + 1e-6;
    if (kind == 1) {
      vec4 a = uBox[idx * 2], b = uBox[idx * 2 + 1];
      hitBox(ro, rd, ird, a.xyz, b.xyz, int(a.w), b.w, h);
    } else if (kind == 2) {
      vec4 a = uOBox[idx * 3], b = uOBox[idx * 3 + 1], c = uOBox[idx * 3 + 2];
      hitOBox(ro, rd, a.xyz, b.xyz, c.x, c.y, int(a.w), b.w, h);
    } else if (kind == 3) {
      vec4 a = uCyl[idx * 3], b = uCyl[idx * 3 + 1], c = uCyl[idx * 3 + 2];
      if (c.y > 0.5) hitCyl(ro, rd, a.xyz, b.xyz, c.x, int(a.w), b.w, h);
      else hitTube(ro, rd, a.xyz, b.xyz, c.x, int(a.w), b.w, h);
    } else if (kind == 4) {
      vec4 a = uEll[idx * 3], b = uEll[idx * 3 + 1], c = uEll[idx * 3 + 2];
      hitEll(ro, rd, a.xyz, b.xyz, c.x, c.y, int(a.w), b.w, h);
    } else {
      vec4 c = uCrumbs[idx];
      hitEll(ro, rd, c.xyz, vec3(c.w, c.w * 0.6, c.w * 1.2), 0.8, 0.6, M_CRUMB, float(idx), h);
    }
  }
  return h;
}

// ------------------------------------------------------------ environment
vec2 wind() {
  return vec2(sin(uTime * 0.71) * 0.05 + sin(uTime * 1.93 + 1.0) * 0.018,
              sin(uTime * 1.13) * 0.02 + sin(uTime * 2.7) * 0.008);
}
// tree canopy on a plane 2 m outside the window
float foliage(vec3 ro, vec3 rd) {
  if (rd.z <= 0.0) return 0.0;
  vec3 q = ro + rd * ((9.0 - ro.z) / rd.z);
  float hgt = smoothstep(1.4, 3.2, q.y);
  vec2 w = wind() * (0.5 + 0.5 * hgt);
  float n = fbm(q.xy * vec2(2.2, 2.6) + w * 3.0, 4);
  float clump = fbm(q.xy * 0.6 + vec2(3.0, 1.0), 2);
  return smoothstep(0.42, 0.58, n * 0.75 + clump * 0.45) * hgt;
}
vec3 sky(vec3 ro, vec3 rd) {
  vec3 c;
  if (rd.y < 0.0) c = vec3(0.16, 0.2, 0.1) * 0.9;
  else c = mix(vec3(0.85, 0.92, 1.0) * 2.0, vec3(0.38, 0.56, 1.0) * 1.2, pow(rd.y, 0.6));
  float f = foliage(ro, rd);
  vec3 leaf = mix(vec3(0.03, 0.06, 0.02), vec3(0.22, 0.32, 0.08), fbm(rd.xy * 40.0, 2));
  return mix(c, leaf, f);
}

// ---------------------------------------------------------------- materials
struct Mat { vec3 alb; float rough; float f0; float metal; vec3 emit; vec3 n; float specW; };

vec3 bookColor(float id) {
  float h = hcell(vec2(id, 3.0));
  vec3 c = h < 0.2 ? vec3(0.45, 0.06, 0.05) : h < 0.35 ? vec3(0.05, 0.12, 0.3) : h < 0.5 ? vec3(0.75, 0.68, 0.52)
         : h < 0.62 ? vec3(0.08, 0.25, 0.14) : h < 0.75 ? vec3(0.85, 0.55, 0.1) : h < 0.87 ? vec3(0.08, 0.08, 0.09) : vec3(0.6, 0.6, 0.62);
  return c * (0.8 + 0.4 * hcell(vec2(id, 9.0)));
}

Mat material(Hit h, vec3 p, bool hq) {
  Mat m; m.alb = vec3(0.7); m.rough = 1.0; m.f0 = 0.04; m.metal = 0.0; m.emit = vec3(0); m.n = h.n; m.specW = 0.0;
  int oct = hq ? 4 : 2;
  for (int k_ = 0; k_ < ((h.mat == M_FLOOR) ? 1 : 0); k_++) {
    WHEN(p.z < TILE_Z) { // glazed ceramic tile, 30 cm grid
      vec2 g = abs(fract(p.xz / 0.3 + 0.5) - 0.5) * 0.3;
      float hid = hcell(floor(p.xz / 0.3) + 40.0);
      if (min(g.x, g.y) < 0.0025) { m.alb = vec3(0.3, 0.28, 0.26); m.rough = 0.9; m.specW = 0.3; }
      else {
        m.alb = vec3(0.74, 0.72, 0.68) * (0.9 + 0.12 * hid) * (0.94 + 0.08 * fbm(p.xz * 9.0, oct));
        m.rough = 0.06 + 0.06 * fbm(p.xz * 4.0 + 3.0, 2); m.f0 = 0.05; m.specW = 1.0;
        m.n = normalize(vec3((hid - 0.5) * 0.004, 1.0, (hcell(floor(p.xz / 0.3) + 71.0) - 0.5) * 0.004));
      }
    }
    WHEN(p.z >= TILE_Z) { // oiled oak planks
      float W = 0.19, LP = 1.4;
      float row = floor(p.z / W);
      float off = hcell(vec2(row, 7.0)) * LP;
      float u = (p.x + off) / LP, col = floor(u);
      float hid = hcell(vec2(row, col));
      float fu = fract(u), fv = fract(p.z / W);
      float seam = (fv < 0.006 || fu < 0.0012) ? 1.0 : 0.0;
      float g = fbm(vec2((p.x + off) * 2.6, p.z * 52.0) + hid * 17.0, oct);
      float rings = sin(p.z * 260.0 + g * 9.0 + hid * 50.0 + sin(p.x * 3.0 + hid * 9.0) * 4.0) * 0.5 + 0.5;
      m.alb = mix(vec3(0.42, 0.26, 0.14), vec3(0.66, 0.45, 0.27), clamp(hid * 0.75 + 0.35 * g, 0.0, 1.0));
      m.alb *= 0.84 + 0.16 * rings;
      vec2 sc = floor(p.xz * 70.0);
      if (hcell(sc + 300.0) > 0.992 && length(fract(p.xz * 70.0) - 0.5) < 0.22) m.alb *= 0.35; // grit
      m.alb *= 1.0 - seam * 0.6;
      m.rough = 0.12 + 0.22 * smoothstep(0.5, 0.75, fbm(p.xz * 2.5 + 5.0, 2)) + seam * 0.6;
      m.specW = 1.0; m.f0 = 0.04;
      m.n = normalize(vec3((hid - 0.5) * 0.012, 1.0, (hcell(vec2(row, col + 3.0)) - 0.5) * 0.012));
    }
  }
  for (int k_ = 0; k_ < ((h.mat == M_WALL || h.mat == M_CEIL) ? 1 : 0); k_++) {
    vec2 q = abs(h.n.x) > 0.5 ? p.zy : abs(h.n.z) > 0.5 ? p.xy : p.xz;
    m.alb = (h.mat == M_WALL ? vec3(0.80, 0.78, 0.74) : vec3(0.86)) * (0.96 + 0.05 * fbm(q * 6.0, 2));
    m.rough = 0.95; m.specW = 0.15;
  }
  for (int k_ = 0; k_ < ((h.mat == M_BASEBOARD || h.mat == M_FRAME || h.mat == M_OUTLET) ? 1 : 0); k_++) {
    m.alb = vec3(0.86, 0.86, 0.84); m.rough = 0.3; m.specW = 1.0;
  }
  for (int k_ = 0; k_ < ((h.mat == M_RUG) ? 1 : 0); k_++) {
    vec2 q = h.lp.xz;                                   // metres from the rug corner
    vec2 e = min(q, vec2(2.6, 2.2) - q);
    float d = min(e.x, e.y);
    vec2 wq = q + 0.025 * vec2(fbm(q * 2.5, 2), fbm(q * 2.5 + 5.0, 2));
    float pa = wq.x / 0.34 + wq.y / 0.52, pb = wq.x / 0.34 - wq.y / 0.52;
    float dl = min(min(fract(pa), 1.0 - fract(pa)), min(fract(pb), 1.0 - fract(pb)));
    float lineW = 0.03 + 0.015 * vnoise(q * 6.0);
    float ink = (1.0 - smoothstep(lineW * 0.6, lineW, dl)) * step(0.22, vnoise(q * 9.0 + 3.0));
    ink = max(ink, (1.0 - smoothstep(0.008, 0.016, abs(d - 0.11))) * step(0.15, vnoise(q * 7.0)));
    vec3 c = mix(vec3(0.80, 0.76, 0.68), vec3(0.13, 0.11, 0.10), ink * 0.92);
    c *= 0.92 + 0.12 * fbm(q * 3.0 + 11.0, 2);           // yellowing, wear
    float tuft = hq ? vnoise(p.xz * 650.0) : 0.5;
    c *= 0.78 + 0.38 * tuft;
    if (h.n.y < 0.5) c = vec3(0.7, 0.66, 0.58) * (0.8 + 0.3 * tuft);
    m.alb = c; m.rough = 1.0; m.specW = 0.0;
    if (hq && h.n.y > 0.5) m.n = normalize(vec3(vnoise(p.xz * 650.0) - 0.5, 0.9, vnoise(p.zx * 650.0 + 7.0) - 0.5));
  }
  for (int k_ = 0; k_ < ((h.mat == M_WOOD_DARK || h.mat == M_OAK) ? 1 : 0); k_++) {
    vec2 q = abs(h.n.y) > 0.5 ? p.xz * vec2(1.0, 8.0) : vec2(p.x + p.z, p.y * 0.2) * vec2(20.0, 4.0);
    float g = fbm(q * 3.0 + h.id, oct);
    m.alb = h.mat == M_OAK ? vec3(0.56, 0.38, 0.22) : vec3(0.2, 0.11, 0.06);
    m.alb *= 0.75 + 0.45 * g;
    m.rough = h.mat == M_OAK ? 0.45 : 0.32; m.specW = 1.0;
  }
  for (int k_ = 0; k_ < ((h.mat == M_FABRIC) ? 1 : 0); k_++) {
    if (h.n.y < -0.5) { m.alb = vec3(0.025); }
    else {
      float weave = hq ? (0.5 + 0.5 * sin(p.y * 1400.0) * sin((p.x + p.z) * 1400.0)) : 0.5;
      m.alb = vec3(0.11, 0.14, 0.19) * (0.85 + 0.2 * weave + 0.15 * fbm(vec2(p.x + p.z, p.y) * 12.0, 2));
    }
    m.rough = 1.0;
  }
  for (int k_ = 0; k_ < ((h.mat == M_PLASTIC_BLACK) ? 1 : 0); k_++) {
    m.alb = vec3(0.018); m.rough = 0.22; m.specW = 1.0; m.f0 = 0.045;
  }
  for (int k_ = 0; k_ < ((h.mat == M_CHROME) ? 1 : 0); k_++) {
    m.alb = vec3(0.92); m.metal = 1.0; m.rough = 0.07;
  }
  for (int k_ = 0; k_ < ((h.mat == M_STEEL) ? 1 : 0); k_++) {
    m.alb = vec3(0.74, 0.73, 0.71); m.metal = 1.0; m.rough = 0.2 + 0.1 * vnoise(vec2(p.x * 3.0, p.y * 400.0));
  }
  for (int k_ = 0; k_ < ((h.mat == M_ALU) ? 1 : 0); k_++) {
    m.alb = vec3(0.85); m.metal = 1.0; m.rough = 0.3;
  }
  for (int k_ = 0; k_ < ((h.mat == M_BRASS) ? 1 : 0); k_++) {
    m.alb = vec3(0.88, 0.64, 0.32); m.metal = 1.0; m.rough = 0.25;
  }
  for (int k_ = 0; k_ < ((h.mat == M_BOOK) ? 1 : 0); k_++) {
    m.alb = bookColor(h.id);
    if (h.n.x > 0.5 && (abs(h.lp.y - 0.03) < 0.005 || abs(h.lp.y - 0.17) < 0.003)) m.alb = vec3(0.7, 0.55, 0.2);
    if (h.n.y > 0.5) m.alb = vec3(0.8, 0.77, 0.68);
    m.rough = 0.55; m.specW = 0.6;
  }
  for (int k_ = 0; k_ < ((h.mat == M_TERRACOTTA) ? 1 : 0); k_++) {
    m.alb = vec3(0.56, 0.26, 0.14) * (0.85 + 0.25 * fbm(vec2(h.lp.y * 30.0, h.lp.z * 6.0), oct)); m.rough = 0.95;
  }
  for (int k_ = 0; k_ < ((h.mat == M_SOIL) ? 1 : 0); k_++) {
    m.alb = vec3(0.07, 0.05, 0.035);
  }
  for (int k_ = 0; k_ < ((h.mat == M_LEAF) ? 1 : 0); k_++) {
    m.alb = vec3(0.07, 0.24, 0.05) * (0.7 + 0.6 * hcell(vec2(h.id, 2.0))); m.rough = 0.45; m.specW = 0.7;
  }
  for (int k_ = 0; k_ < ((h.mat == M_SHADE) ? 1 : 0); k_++) {
    m.alb = vec3(0.86, 0.8, 0.66); m.emit = vec3(1.0, 0.7, 0.38) * 1.2;
  }
  for (int k_ = 0; k_ < ((h.mat == M_BULB) ? 1 : 0); k_++) {
    m.emit = BULB_L; m.alb = vec3(0);
  }
  for (int k_ = 0; k_ < ((h.mat == M_LED) ? 1 : 0); k_++) {
    m.emit = vec3(0.15, 0.45, 3.0) * 2.2; m.alb = vec3(0);
  }
  for (int k_ = 0; k_ < ((h.mat == M_CABINET) ? 1 : 0); k_++) {
    float gx = abs(fract((p.x - 0.6) / 0.6 + 0.5) - 0.5) * 0.6;
    m.alb = gx < 0.0025 ? vec3(0.08) : vec3(0.86, 0.86, 0.84); m.rough = 0.28; m.specW = 1.0;
  }
  for (int k_ = 0; k_ < ((h.mat == M_COUNTER) ? 1 : 0); k_++) {
    m.alb = vec3(0.22, 0.22, 0.24) * (0.7 + 0.6 * vnoise(p.xz * 300.0)); m.rough = 0.18; m.specW = 1.0; m.f0 = 0.05;
  }
  for (int k_ = 0; k_ < ((h.mat == M_SOCK) ? 1 : 0); k_++) {
    // navy heather knit; grey toe, heel and cuff
    m.alb = vec3(0.09, 0.11, 0.17);
    if ((h.id < 0.5 && h.lp.x < -0.65) || (h.id > 1.5 && h.id < 2.5) || h.id > 2.5) m.alb = vec3(0.42, 0.42, 0.44);
    float rib = h.id > 2.5 ? 0.5 + 0.5 * sin(atan(h.lp.z, h.lp.y) * 18.0) : 0.5 + 0.5 * sin(h.lp.x * 55.0);
    m.alb *= 0.78 + 0.3 * rib;
    m.alb *= hq ? 0.8 + 0.4 * vnoise(p.xz * 900.0 + p.y * 400.0) : 1.0;
  }
  for (int k_ = 0; k_ < ((h.mat == M_CRUMB) ? 1 : 0); k_++) {
    m.alb = vec3(0.62, 0.38, 0.12) * (0.75 + 0.5 * hcell(vec2(h.id, 5.0))); m.rough = 0.7; m.specW = 0.4;
  }
  for (int k_ = 0; k_ < ((h.mat == M_DUST) ? 1 : 0); k_++) {
    m.alb = vec3(0.42, 0.41, 0.4) * (0.8 + 0.4 * vnoise(p.xz * 300.0));
    if (hq) m.n = normalize(h.n + 0.9 * (vec3(vnoise(p.xy * 500.0), vnoise(p.yz * 500.0), vnoise(p.zx * 500.0)) - 0.5));
  }
  for (int k_ = 0; k_ < ((h.mat == M_LEGO) ? 1 : 0); k_++) {
    m.alb = vec3(0.62, 0.03, 0.02); m.rough = 0.12; m.specW = 1.0; m.f0 = 0.05;
  }
  for (int k_ = 0; k_ < ((h.mat == M_PEN) ? 1 : 0); k_++) {
    m.alb = vec3(0.04, 0.1, 0.5); m.rough = 0.18; m.specW = 1.0;
  }
  for (int k_ = 0; k_ < ((h.mat == M_FELT) ? 1 : 0); k_++) {
    m.alb = vec3(0.3, 0.3, 0.33) * (h.id > 0.5 ? 0.9 : 1.0);
  }
  for (int k_ = 0; k_ < ((h.mat == M_PLINTH) ? 1 : 0); k_++) {
    m.alb = vec3(0.1, 0.1, 0.11); m.rough = 0.5; m.specW = 1.0;
  }
  return m;
}

// ------------------------------------------------------------------- BSDF
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float D_GGX(float NoH, float a) { float a2 = a * a; float d = NoH * NoH * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
float G1(float NoX, float a) { float k = a * 0.5; return NoX / (NoX * (1.0 - k) + k); }
vec3 fres(vec3 f0, float c) { return f0 + (1.0 - f0) * pow(1.0 - c, 5.0); }

void onb(vec3 n, out vec3 t, out vec3 b) {
  float s = n.z >= 0.0 ? 1.0 : -1.0;
  float a = -1.0 / (s + n.z), c = n.x * n.y * a;
  t = vec3(1.0 + s * n.x * n.x * a, s * c, -s * n.x);
  b = vec3(c, s + n.y * n.y * a, -n.y);
}

vec3 specF0(Mat m) { return m.metal > 0.5 ? m.alb : vec3(m.f0); }
float specProb(Mat m, float NoV) {
  if (m.metal > 0.5) return 1.0;
  if (m.specW <= 0.0) return 0.0;
  float F = m.f0 + (1.0 - m.f0) * pow(1.0 - NoV, 5.0);
  return clamp(F * m.specW * 1.3 + 0.04, 0.04, 0.92);
}
// full BSDF * cos, used for sun NEE (both lobes)
vec3 evalBSDF(Mat m, vec3 V, vec3 L) {
  vec3 N = m.n;
  float NoL = dot(N, L), NoV = max(dot(N, V), 1e-4);
  if (NoL <= 0.0) return vec3(0);
  float a = max(m.rough * m.rough, 0.0025);
  vec3 H = normalize(V + L);
  float NoH = max(dot(N, H), 0.0), VoH = max(dot(V, H), 0.0);
  vec3 spec = vec3(0);
  if (m.metal > 0.5 || m.specW > 0.0) {
    vec3 F = fres(specF0(m), VoH) * (m.metal > 0.5 ? 1.0 : m.specW);
    spec = D_GGX(NoH, a) * G1(NoL, a) * G1(NoV, a) * F / (4.0 * NoV);
  } // (NoL cancels with the /NoL of the microfacet model)
  vec3 diff = vec3(0);
  if (m.metal < 0.5) {
    float Fv = m.specW > 0.0 ? m.f0 + (1.0 - m.f0) * pow(1.0 - NoV, 5.0) : 0.0;
    diff = m.alb / PI * (1.0 - Fv * m.specW) * NoL;
  }
  return spec + diff;
}
vec3 evalDiffuse(Mat m, vec3 V, vec3 L) {
  if (m.metal > 0.5) return vec3(0);
  float NoL = dot(m.n, L);
  if (NoL <= 0.0) return vec3(0);
  float NoV = max(dot(m.n, V), 1e-4);
  float Fv = m.specW > 0.0 ? m.f0 + (1.0 - m.f0) * pow(1.0 - NoV, 5.0) : 0.0;
  return m.alb / PI * (1.0 - Fv * m.specW) * NoL;
}

vec3 sampleCone(vec3 axis, float cosMax) {
  float c = 1.0 - rnd() * (1.0 - cosMax);
  float s = sqrt(max(0.0, 1.0 - c * c));
  float ph = 2.0 * PI * rnd();
  vec3 t, b; onb(axis, t, b);
  return normalize(t * cos(ph) * s + b * sin(ph) * s + axis * c);
}

vec3 fixDir(vec3 d) { return mix(d, d + 1e-6, vec3(equal(d, vec3(0)))); }

// ------------------------------------------------------------------ camera
mat3 camBasis(vec3 r) { // yaw (heading in xz), pitch (up), roll
  float cy = cos(r.x), sy = sin(r.x), cp = cos(r.y), sp = sin(r.y);
  vec3 fw = vec3(cy * cp, sp, sy * cp);
  vec3 rt = normalize(cross(fw, vec3(0, 1, 0)));
  vec3 up = cross(rt, fw);
  float cr = cos(r.z), sr = sin(r.z);
  vec3 rt2 = rt * cr + up * sr, up2 = up * cr - rt * sr;
  return mat3(rt2, up2, fw);
}

void main() {
  vec2 px = floor(gl_FragCoord.xy);
  rs = pcg(uint(px.x) + pcg(uint(px.y) + pcg(uSeed)));

  vec2 pix = px + vec2(rnd(), rnd());
  vec2 ndc = (pix - uRes * 0.5) / (uRes.x * 0.5);
  float r = length(ndc);
  float th = mix(atan(r * tan(uHalfFov)), r * uHalfFov, uFish);
  vec3 dc = vec3(ndc / max(r, 1e-6) * sin(th), cos(th));

  // rolling shutter: each row starts exposing a little later; motion blur within the exposure
  float row = 1.0 - pix.y / uRes.y;
  float tau = row * uReadout + rnd() * uShutter;
  float k = clamp(tau / uSpan, 0.0, 1.0) * 5.0;
  int i0 = min(int(k), 4);
  float fk = k - float(i0);
  vec3 cpos = mix(uPosK[i0], uPosK[i0 + 1], fk);
  vec3 crot = mix(uRotK[i0], uRotK[i0 + 1], fk);
  mat3 B = camBasis(crot);

  bool hq = uHQ == 1;
  vec3 L = vec3(0), thr = vec3(1);
  vec3 aov_alb = vec3(1), aov_n = vec3(0);
  float aov_d = 50.0;
  bool lastSpec = true, alive = true;
  int depth = 0;
  vec3 pro = cpos, prd = fixDir(normalize(B * dc));

  // Single trace() call site: path rays and shadow rays share one loop so
  // the (large, unrolled) scene code is inlined exactly once.
  bool pA = false, pB = false;     // pending NEE shadow ray, pending haze shadow ray
  int ak = 0;
  vec3 aro = vec3(0), ard = vec3(0), ac = vec3(0), bro = vec3(0), brd = vec3(0), bc = vec3(0);

  for (int it = 0; it < 16; it++) {
    int mode = pB ? 2 : (pA ? 1 : 0);
    if (mode == 0 && !alive) break;
    vec3 cro = mode == 2 ? bro : (mode == 1 ? aro : pro);
    vec3 crd = mode == 2 ? brd : (mode == 1 ? ard : prd);
    // detail geometry only for primary rays and the shadow rays leaving primary hits
    bool lod = mode == 2 || (mode == 1 ? depth > 0 : depth > 0);
    Hit h = trace(cro, crd, FAR, lod);

    if (mode > 0) {
      bool sunlike = (mode == 2 || ak == 1) && h.mat < 0;
      float vis = (mode == 1 && ((ak == 2 && h.mat < 0) || (ak == 3 && h.mat == M_BULB))) ? 1.0 : 0.0;
      WHEN(sunlike) vis = 1.0 - 0.92 * foliage(cro, crd);
      L += (mode == 2 ? bc : ac) * vis;
      if (mode == 2) pB = false; else pA = false;
      continue;
    }

    // ---------------- path vertex
    vec3 ro = pro, rd = prd;
    if (depth == 0 && hq) { // single-scatter haze in the sunbeam, primary rays only
      float seg = min(h.t, 8.0);
      vec3 q = ro + rd * (rnd() * seg);
      if (q.z < 7.0) {
        float g = 0.55, c = dot(SUN, rd);
        float phase = (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * c, 1.5));
        bro = q; brd = fixDir(sampleCone(SUN, SUN_COS)); bc = HAZE * seg * phase * SUN_E; pB = true;
      }
    }

    if (h.mat < 0) { // escaped through the window
      WHEN(depth == 0 || lastSpec) L += thr * sky(ro, rd);
      if (depth == 0) { aov_alb = vec3(1); aov_n = -rd; aov_d = 50.0; }
      alive = false; continue;
    }

    vec3 p = ro + rd * h.t;
    vec3 V = -rd;
    vec3 ng = dot(h.n, V) < 0.0 ? -h.n : h.n;
    Mat m = material(h, p, hq && depth < 2);
    if (dot(m.n, ng) < 0.0) m.n = ng;
    if (dot(m.n, V) < 0.0) m.n = normalize(m.n + ng * (0.01 - dot(m.n, V)));

    if (depth == 0) { aov_alb = m.metal > 0.5 ? m.alb : max(m.alb, vec3(0.02)); aov_n = ng; aov_d = h.t; }

    if (dot(m.emit, m.emit) > 0.0) {
      bool isBulb = h.mat == M_BULB;
      if (!isBulb || depth == 0 || lastSpec) {
        vec3 e = thr * m.emit;
        if (depth > 0) e = min(e, vec3(12.0));
        L += e;
      }
      if (h.mat != M_SHADE) { if (depth == 0) aov_alb = vec3(1); alive = false; continue; }
    }

    vec3 po = p + ng * 4e-4;
    float NoV = max(dot(m.n, V), 1e-4);
    float ps = specProb(m, NoV);

    // --- next event estimation: one light per vertex, visibility resolved next iteration
    float pick = rnd();
    WHEN(pick < 0.5) { // sun, both lobes
      vec3 Ls = sampleCone(SUN, SUN_COS);
      vec3 f = evalBSDF(m, V, Ls);
      if (max(f.r, max(f.g, f.b)) > 0.0 && dot(Ls, ng) > 0.0) {
        pA = true; ak = 1; aro = po; ard = fixDir(Ls); ac = thr * f * SUN_E / 0.5;
      }
    }
    WHEN(pick >= 0.5 && pick < 0.8 && p.z < 6.99 && ps < 1.0) { // sky through the window, diffuse lobe
      {
        vec3 q = vec3(mix(WIN.x, WIN.y, rnd()), mix(WIN.z, WIN.w, rnd()), 7.0);
        vec3 dv = q - po; float d2 = dot(dv, dv); vec3 Lw = dv * inversesqrt(d2);
        vec3 f = evalDiffuse(m, V, Lw);
        if (Lw.z > 0.0 && dot(Lw, ng) > 0.0 && max(f.r, max(f.g, f.b)) > 0.0) {
          float area = (WIN.y - WIN.x) * (WIN.w - WIN.z);
          pA = true; ak = 2; aro = po; ard = fixDir(Lw); ac = thr * f * sky(po, Lw) * area * Lw.z / d2 / 0.3;
        }
      }
    }
    WHEN(pick >= 0.8 && ps < 1.0) { // lamp bulb, diffuse lobe
      vec3 dv = BULB_P - po; float d2 = dot(dv, dv);
      float cmax = sqrt(max(0.0, 1.0 - BULB_R * BULB_R / d2));
      vec3 Lb = sampleCone(dv * inversesqrt(d2), cmax);
      vec3 f = evalDiffuse(m, V, Lb);
      if (dot(Lb, ng) > 0.0 && max(f.r, max(f.g, f.b)) > 0.0) {
        pA = true; ak = 3; aro = po; ard = fixDir(Lb); ac = thr * f * BULB_L * (2.0 * PI * (1.0 - cmax)) / 0.2;
      }
    }
    if (pA && depth > 0) ac = min(ac, vec3(12.0));

    // --- continue the path: pick a lobe
    vec3 Lnext = m.n; vec3 w = vec3(0);
    bool specLobe = rnd() < ps;
    WHEN(specLobe) {
      float a = max(m.rough * m.rough, 0.0025);
      float u = rnd(), ph = 2.0 * PI * rnd();
      float ct = sqrt((1.0 - u) / (1.0 + (a * a - 1.0) * u)), st = sqrt(1.0 - ct * ct);
      vec3 t, b; onb(m.n, t, b);
      vec3 H = normalize(t * cos(ph) * st + b * sin(ph) * st + m.n * ct);
      Lnext = reflect(-V, H);
      float NoL = dot(m.n, Lnext), VoH = max(dot(V, H), 1e-4), NoH = max(dot(m.n, H), 1e-4);
      vec3 F = fres(specF0(m), VoH) * (m.metal > 0.5 ? 1.0 : m.specW);
      w = (NoL <= 0.0) ? vec3(0) : F * G1(NoL, a) * G1(NoV, a) * VoH / (NoV * NoH) / ps;
      lastSpec = m.rough < 0.4;
    }
    WHEN(!specLobe) {
      float u = rnd(), ph = 2.0 * PI * rnd();
      vec3 t, b; onb(m.n, t, b);
      float sr = sqrt(u);
      Lnext = normalize(t * cos(ph) * sr + b * sin(ph) * sr + m.n * sqrt(1.0 - u));
      float Fv = m.specW > 0.0 ? m.f0 + (1.0 - m.f0) * pow(1.0 - NoV, 5.0) : 0.0;
      w = m.alb * (1.0 - Fv * m.specW) / (1.0 - ps);
      lastSpec = false;
    }
    if (dot(Lnext, ng) <= 0.0 || max(w.r, max(w.g, w.b)) <= 0.0) { alive = false; continue; }
    thr *= w;
    if (depth >= 2) {
      float q = clamp(max(thr.r, max(thr.g, thr.b)), 0.05, 0.95);
      if (rnd() > q) { alive = false; continue; }
      thr /= q;
    }
    pro = po; prd = fixDir(Lnext);
    depth++;
    if (depth >= uMaxDepth) alive = false;
  }

  if (any(isnan(L)) || any(isinf(L))) L = vec3(0);
  oCol = vec4(L, 1.0);
  oAlb = vec4(aov_alb, 1.0);
  oNrm = vec4(aov_n, aov_d);
}
