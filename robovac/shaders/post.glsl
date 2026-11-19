//// fullscreen.vert
#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }

//// resolve.frag
// Divide accumulated sums by spp, clamp fireflies against the neighbourhood,
// demodulate first-hit albedo so the denoiser only blurs lighting, not texture.
#version 300 es
precision highp float;
uniform sampler2D uCol, uAlb, uNrm;
uniform float uInvSpp;
uniform vec2 uRes;
layout(location = 0) out vec4 oIll;
layout(location = 1) out vec4 oAlb;
layout(location = 2) out vec4 oNrm;
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 c = texelFetch(uCol, p, 0).rgb * uInvSpp;
  float mx = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    if (i == 0 && j == 0) continue;
    ivec2 q = clamp(p + ivec2(i, j), ivec2(0), ivec2(uRes) - 1);
    mx = max(mx, lum(texelFetch(uCol, q, 0).rgb * uInvSpp));
  }
  float l = lum(c), lim = mx * 2.5 + 0.05;
  if (l > lim) c *= lim / l;
  vec3 a = max(texelFetch(uAlb, p, 0).rgb * uInvSpp, vec3(0.02));
  vec4 n = texelFetch(uNrm, p, 0) * uInvSpp;
  oIll = vec4(c / a, 1.0);
  oAlb = vec4(a, 1.0);
  oNrm = vec4(normalize(n.xyz + 1e-6), n.w);
}

//// temporal.frag
// Temporal accumulation: reconstruct each pixel's world position from its
// own rolling-shutter row pose, project it into the previous frame through
// the inverse fisheye model, and blend with that history if depth and
// normal agree. History is clamped to the local neighbourhood to limit
// ghosting from moving leaf shadows and glossy reflections.
#version 300 es
precision highp float;
uniform sampler2D uIll, uNrm, uHistIll, uHistNrm;
uniform vec3 uPosK[6], uRotK[6];
uniform float uSpan, uReadout, uShutter, uHalfFov, uFish, uMaxN;
uniform vec3 uPrevPos, uPrevRot;
uniform vec2 uRes;
uniform int uValid;
layout(location = 0) out vec4 oIll;
layout(location = 1) out vec4 oNrm;
mat3 camBasis(vec3 r) {
  float cy = cos(r.x), sy = sin(r.x), cp = cos(r.y), sp = sin(r.y);
  vec3 fw = vec3(cy * cp, sp, sy * cp);
  vec3 rt = normalize(cross(fw, vec3(0, 1, 0)));
  vec3 up = cross(rt, fw);
  float cr = cos(r.z), sr = sin(r.z);
  return mat3(rt * cr + up * sr, up * cr - rt * sr, fw);
}
float theta(float r) { return mix(atan(r * tan(uHalfFov)), r * uHalfFov, uFish); }
float dtheta(float r) { float t = tan(uHalfFov); return mix(t / (1.0 + r * r * t * t), uHalfFov, uFish); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 cur = texelFetch(uIll, p, 0).rgb;
  vec4 n = texelFetch(uNrm, p, 0);
  oNrm = n;
  oIll = vec4(cur, 1.0);
  if (uValid == 0 || n.w >= 49.0) return;

  vec2 pix = vec2(p) + 0.5;
  vec2 ndc = (pix - uRes * 0.5) / (uRes.x * 0.5);
  float r = length(ndc);
  float th = theta(r);
  vec3 dc = vec3(ndc / max(r, 1e-6) * sin(th), cos(th));
  float row = 1.0 - pix.y / uRes.y;
  float k = clamp((row * uReadout + 0.5 * uShutter) / uSpan, 0.0, 1.0) * 5.0;
  int i0 = min(int(k), 4);
  float fk = k - float(i0);
  vec3 cpos = mix(uPosK[i0], uPosK[i0 + 1], fk);
  mat3 B = camBasis(mix(uRotK[i0], uRotK[i0 + 1], fk));
  vec3 P = cpos + normalize(B * dc) * n.w;

  vec3 q = transpose(camBasis(uPrevRot)) * (P - uPrevPos);
  float d = length(q);
  if (q.z <= 0.0) return;
  float tq = acos(clamp(q.z / d, -1.0, 1.0));
  float rr = tq / uHalfFov;
  for (int i = 0; i < 4; i++) rr -= (theta(rr) - tq) / dtheta(rr);
  vec2 pp = normalize(q.xy + 1e-9) * rr * uRes.x * 0.5 + uRes * 0.5;
  if (pp.x < 0.5 || pp.y < 0.5 || pp.x > uRes.x - 0.5 || pp.y > uRes.y - 0.5) return;

  vec4 hn = texelFetch(uHistNrm, ivec2(pp), 0);
  if (abs(hn.w - d) > 0.04 * d + 0.004 || dot(hn.xyz, n.xyz) < 0.85) return;
  vec4 hist = texture(uHistIll, pp / uRes);

  // neighbourhood clamp (loose: the current frame is only a few samples)
  vec3 m1 = vec3(0), m2 = vec3(0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec3 c = texelFetch(uIll, clamp(p + ivec2(i, j), ivec2(0), ivec2(uRes) - 1), 0).rgb;
    m1 += c; m2 += c * c;
  }
  m1 /= 9.0; vec3 sd = sqrt(max(m2 / 9.0 - m1 * m1, 0.0));
  vec3 h = clamp(hist.rgb, m1 - 2.5 * sd - 0.02, m1 + 2.5 * sd + 0.02);
  float N = min(hist.a + 1.0, uMaxN);
  oIll = vec4(mix(h, cur, 1.0 / N), N);
}

//// atrous.frag
// Edge-avoiding a-trous wavelet filter (Dammertz et al. 2010), guided by
// normal, depth and log-luminance.
#version 300 es
precision highp float;
uniform sampler2D uIll, uNrm;
uniform int uStep;
uniform float uSigL;
uniform vec2 uRes;
out vec4 o;
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 c0 = texelFetch(uIll, p, 0).rgb;
  vec4 n0 = texelFetch(uNrm, p, 0);
  float l0 = log(lum(c0) + 0.01);
  const float K[3] = float[3](0.375, 0.25, 0.0625);
  vec3 sum = vec3(0); float ws = 0.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    ivec2 q = clamp(p + ivec2(i, j) * uStep, ivec2(0), ivec2(uRes) - 1);
    vec3 c = texelFetch(uIll, q, 0).rgb;
    vec4 n = texelFetch(uNrm, q, 0);
    float w = K[abs(i)] * K[abs(j)];
    w *= pow(max(dot(n.xyz, n0.xyz), 0.0), 48.0);
    w *= exp(-abs(n.w - n0.w) / (0.02 * n0.w * float(uStep) + 0.002));
    w *= exp(-abs(log(lum(c) + 0.01) - l0) / uSigL);
    sum += c * w; ws += w;
  }
  o = vec4(sum / max(ws, 1e-6), 1.0);
}

//// bloom_down.frag
// Quarter-res bright pass for lens veiling glare.
#version 300 es
precision highp float;
uniform sampler2D uIll, uAlb;
uniform float uExposure;
out vec4 o;
void main() {
  ivec2 b = ivec2(gl_FragCoord.xy) * 4;
  vec3 s = vec3(0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    ivec2 q = b + ivec2(i, j);
    vec3 c = texelFetch(uIll, q, 0).rgb * texelFetch(uAlb, q, 0).rgb * uExposure;
    s += max(c - 0.85, 0.0);
  }
  o = vec4(s / 16.0, 1.0);
}

//// blur.frag
#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uDir;
uniform vec2 uRes;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  const float W[5] = float[5](0.227, 0.194, 0.121, 0.054, 0.016);
  vec3 s = texture(uTex, uv).rgb * W[0];
  for (int i = 1; i < 5; i++) {
    vec2 d = uDir * float(i) * 2.0 / uRes;
    s += (texture(uTex, uv + d).rgb + texture(uTex, uv - d).rgb) * W[i];
  }
  o = vec4(s, 1.0);
}

//// camera.frag
// The sensor and lens: remodulate, lateral chromatic aberration, veiling
// glare, vignetting, exposure, edge enhancement, photon shot noise + read
// noise scaled by analog gain, row noise, white balance, tone curve, sRGB.
#version 300 es
precision highp float;
uniform sampler2D uIll, uAlb, uBloom;
uniform vec2 uRes;
uniform float uExposure, uGain, uSceneMean;
uniform uint uSeed;
out vec4 o;

uint pcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
uint rs;
float rnd() { rs = pcg(rs); return float(rs) * (1.0 / 4294967296.0); }
float gauss() { return sqrt(-2.0 * log(max(rnd(), 1e-7))) * cos(6.2831853 * rnd()); }

vec3 hdr(vec2 uv) {
  ivec2 q = clamp(ivec2(uv * uRes), ivec2(0), ivec2(uRes) - 1);
  return texelFetch(uIll, q, 0).rgb * texelFetch(uAlb, q, 0).rgb;
}
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 srgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 c = uv - 0.5; c.x *= uRes.x / uRes.y;
  float r2 = dot(c, c);

  // lateral CA: red focuses slightly wider than blue toward the corners
  vec2 d = (uv - 0.5);
  vec3 col;
  col.r = hdr(0.5 + d * (1.0 + 0.0025 * r2 * 4.0)).r;
  col.g = hdr(uv).g;
  col.b = hdr(0.5 + d * (1.0 - 0.0025 * r2 * 4.0)).b;

  // cheap-lens edge enhancement (unsharp mask on the linear image)
  vec2 px = 1.0 / uRes;
  vec3 nb = (hdr(uv + vec2(px.x, 0)) + hdr(uv - vec2(px.x, 0)) + hdr(uv + vec2(0, px.y)) + hdr(uv - vec2(0, px.y))) * 0.25;
  col = max(col + 0.35 * (col - nb), 0.0);

  col *= uExposure;
  col += texture(uBloom, uv).rgb * 0.08 + uSceneMean * uExposure * 0.012 * vec3(1.0, 0.98, 0.95);
  col *= mix(1.0, 0.42, smoothstep(0.0, 1.0, r2 * 1.25)); // vignette (natural + mechanical)

  // sensor: photons -> electrons with Poisson-ish shot noise, plus read noise
  rs = pcg(uint(gl_FragCoord.x) + pcg(uint(gl_FragCoord.y) * 9781u + pcg(uSeed)));
  const float FULL_WELL = 5200.0;
  vec3 e = max(col, 0.0) * FULL_WELL / uGain;
  float read = 3.5;
  float lumaN = gauss();
  vec3 n = vec3(gauss(), gauss(), gauss()) * 0.75 + lumaN * 0.5;
  col = (e + n * sqrt(e + read * read)) * uGain / FULL_WELL;
  // row noise: visible only when the gain is cranked up
  uint rowSeed = pcg(uint(gl_FragCoord.y) + pcg(uSeed + 17u));
  float rowN = (float(rowSeed) / 4294967296.0 - 0.5) * 0.0018 * uGain;
  col += rowN;
  // black level crush + white balance (slightly warm auto-WB)
  col = max(col - 0.002, 0.0) * vec3(1.03, 1.0, 0.95);
  // saturation pulled back a touch, like a small sensor
  float y = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(y), col, 0.9);
  col = srgb(aces(col * 0.9));
  o = vec4(col, 1.0);
}
