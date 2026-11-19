// Runs inside the browser page. Owns the WebGL2 context, compiles the
// path tracer + post chain, and renders one frame per call.
/* eslint-env browser */
(function () {
  'use strict';
  let gl, progs = {}, quad, targets = {}, size = {};

  function compile(type, src, name) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(name + ': ' + gl.getShaderInfoLog(s));
    return s;
  }
  function program(vs, fs, name) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs, name + '.vert'));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs, name));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(name + ' link: ' + gl.getProgramInfoLog(p));
    const uni = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const base = info.name.replace(/\[0\]$/, '');
      uni[base] = { loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size };
    }
    return { p, uni, name };
  }
  function setU(prog, vals) {
    for (const [k, v] of Object.entries(vals)) {
      const u = prog.uni[k];
      if (!u) continue;
      const a = Array.isArray(v) || ArrayBuffer.isView(v) ? v : [v];
      switch (u.type) {
        case gl.FLOAT: gl.uniform1fv(u.loc, a); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, a); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, a); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, a); break;
        case gl.INT: case gl.SAMPLER_2D: gl.uniform1iv(u.loc, a); break;
        case gl.UNSIGNED_INT: gl.uniform1uiv(u.loc, a); break;
        default: throw new Error('uniform type ' + u.type + ' for ' + k);
      }
    }
  }
  function tex(w, h, internal, format, type, linear) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    const f = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function fbo(texs) {
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    texs.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    gl.drawBuffers(texs.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('fbo incomplete ' + st);
    return { f, texs };
  }
  const f32 = (w, h, lin) => tex(w, h, gl.RGBA32F, gl.RGBA, gl.FLOAT, lin);

  function makeTargets(key, W, H) {
    if (targets[key] && targets[key].W === W && targets[key].H === H) return targets[key];
    const T = { W, H };
    T.acc = fbo([f32(W, H), f32(W, H), f32(W, H)]);
    T.res = fbo([f32(W, H), f32(W, H), f32(W, H)]);
    T.hist = [fbo([f32(W, H, true), f32(W, H)]), fbo([f32(W, H, true), f32(W, H)])];
    T.histFrame = -10;
    T.ping = fbo([f32(W, H)]);
    T.pong = fbo([f32(W, H)]);
    const bw = Math.ceil(W / 4), bh = Math.ceil(H / 4);
    T.bw = bw; T.bh = bh;
    T.b0 = fbo([f32(bw, bh, true)]);
    T.b1 = fbo([f32(bw, bh, true)]);
    T.out = fbo([tex(W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE)]);
    targets[key] = T;
    return T;
  }
  function draw(prog, target, W, H, uniforms, texUnits) {
    gl.useProgram(prog.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.f : null);
    gl.viewport(0, 0, W, H);
    let unit = 0;
    for (const [name, t] of Object.entries(texUnits || {})) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      setU(prog, { [name]: unit });
      unit++;
    }
    setU(prog, uniforms);
    gl.bindVertexArray(quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function pathTrace(T, p, spp, hq) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.acc.f);
    gl.viewport(0, 0, T.W, T.H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let s = 0; s < spp; s++) {
      draw(progs.pt, T.acc, T.W, T.H, {
        uRes: [T.W, T.H], uSeed: (p.frame * 1024 + s + (hq ? 0 : 512)) >>> 0,
        uPosK: p.posK, uRotK: p.rotK, uSpan: p.span, uReadout: p.readout, uShutter: p.shutter,
        uTime: p.time, uCrumbs: p.crumbs, uCrumbMin: p.crumbMin, uCrumbMax: p.crumbMax,
        uMaxDepth: hq ? p.maxDepth : 3, uHQ: hq ? 1 : 0, uHalfFov: p.halfFov, uFish: p.fish,
      });
    }
    gl.disable(gl.BLEND);
  }

  window.RV = {
    init(cfg) {
      const c = document.createElement('canvas');
      c.width = 16; c.height = 16;
      gl = c.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
      if (!gl) throw new Error('WebGL2 unavailable');
      if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float unavailable');
      if (!gl.getExtension('EXT_float_blend')) throw new Error('EXT_float_blend unavailable');
      gl.getExtension('OES_texture_float_linear');
      const vs = cfg.post.fullscreen_vert;
      progs.pt = program(vs, cfg.pathtrace, 'pathtrace');
      gl.useProgram(progs.pt.p);
      setU(progs.pt, cfg.sceneUniforms);
      progs.resolve = program(vs, cfg.post.resolve_frag, 'resolve');
      progs.atrous = program(vs, cfg.post.atrous_frag, 'atrous');
      progs.temporal = program(vs, cfg.post.temporal_frag, 'temporal');
      progs.bloom = program(vs, cfg.post.bloom_down_frag, 'bloom');
      progs.blur = program(vs, cfg.post.blur_frag, 'blur');
      progs.camera = program(vs, cfg.post.camera_frag, 'camera');
      quad = gl.createVertexArray();
      gl.bindVertexArray(quad);
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      return gl.getParameter(gl.VERSION) + ' | ' + gl.getParameter(gl.RENDERER);
    },

    // low-res render, returns per-pixel luminance for the auto-exposure loop
    meter(p) {
      const T = makeTargets('meter', p.W, p.H);
      pathTrace(T, p, p.spp, false);
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.acc.f);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      const px = new Float32Array(p.W * p.H * 4);
      gl.readPixels(0, 0, p.W, p.H, gl.RGBA, gl.FLOAT, px);
      const out = new Array(p.W * p.H);
      for (let i = 0; i < p.W * p.H; i++) {
        out[i] = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / p.spp;
      }
      return out;
    },

    frame(p) {
      const T = makeTargets('main', p.W, p.H);
      const t0 = performance.now();
      pathTrace(T, p, p.spp, true);
      // resolve + demodulate
      draw(progs.resolve, T.res, T.W, T.H, { uInvSpp: 1 / p.spp, uRes: [T.W, T.H] },
        { uCol: T.acc.texs[0], uAlb: T.acc.texs[1], uNrm: T.acc.texs[2] });
      // temporal accumulation into the ping-pong history
      const cur = T.hist[p.frame & 1], prev = T.hist[(p.frame & 1) ^ 1];
      draw(progs.temporal, cur, T.W, T.H, {
        uPosK: p.posK, uRotK: p.rotK, uSpan: p.span, uReadout: p.readout, uShutter: p.shutter,
        uHalfFov: p.halfFov, uFish: p.fish, uMaxN: p.maxN, uPrevPos: p.prevPos, uPrevRot: p.prevRot,
        uRes: [T.W, T.H], uValid: (p.temporal && T.histFrame === p.frame - 1) ? 1 : 0,
      }, { uIll: T.res.texs[0], uNrm: T.res.texs[2], uHistIll: prev.texs[0], uHistNrm: prev.texs[1] });
      T.histFrame = p.frame;
      // a-trous iterations
      let src = cur.texs[0];
      const steps = p.denoise;
      for (let i = 0; i < steps; i++) {
        const dst = i % 2 === 0 ? T.ping : T.pong;
        draw(progs.atrous, dst, T.W, T.H, { uStep: 1 << i, uSigL: p.sigL * (i === 0 ? 1 : 1.5), uRes: [T.W, T.H] },
          { uIll: src, uNrm: T.res.texs[2] });
        src = dst.texs[0];
      }
      // bloom
      draw(progs.bloom, T.b0, T.bw, T.bh, { uExposure: p.exposure }, { uIll: src, uAlb: T.res.texs[1] });
      draw(progs.blur, T.b1, T.bw, T.bh, { uDir: [1, 0], uRes: [T.bw, T.bh] }, { uTex: T.b0.texs[0] });
      draw(progs.blur, T.b0, T.bw, T.bh, { uDir: [0, 1], uRes: [T.bw, T.bh] }, { uTex: T.b1.texs[0] });
      // camera
      draw(progs.camera, T.out, T.W, T.H, {
        uRes: [T.W, T.H], uExposure: p.exposure, uGain: p.gain, uSceneMean: p.sceneMean, uSeed: p.frame >>> 0,
      }, { uIll: src, uAlb: T.res.texs[1], uBloom: T.b0.texs[0] });
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.out.f);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      const px = new Uint8Array(T.W * T.H * 4);
      gl.readPixels(0, 0, T.W, T.H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      // flip to top-down RGB, base64 for transport
      const rgb = new Uint8Array(T.W * T.H * 3);
      for (let y = 0; y < T.H; y++) {
        const sr = (T.H - 1 - y) * T.W * 4, dr = y * T.W * 3;
        for (let x = 0; x < T.W; x++) {
          rgb[dr + x * 3] = px[sr + x * 4];
          rgb[dr + x * 3 + 1] = px[sr + x * 4 + 1];
          rgb[dr + x * 3 + 2] = px[sr + x * 4 + 2];
        }
      }
      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < rgb.length; i += CH) bin += String.fromCharCode.apply(null, rgb.subarray(i, i + CH));
      return { b64: btoa(bin), ms: performance.now() - t0 };
    },
  };
})();
