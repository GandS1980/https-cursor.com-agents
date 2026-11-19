# robovac — a 53-second film from a robot vacuum's point of view, made only with code

No assets, no models, no textures, no samples, no fonts. Every pixel is path-traced
by a custom GPU shader, every surface is procedural, the camera is simulated down
to its rolling shutter, and every sound is synthesized from the same physics
simulation that moves the camera.

```
./make.sh          # renders on SwiftShader (CPU) — slow, works anywhere Chromium runs
GPU=1 ./make.sh    # same shader on your real GPU via ANGLE — minutes instead of hours
```
Output: `out/robovac.mp4` (1280×720, 30 fps, AAC). Frames are written as they finish,
so an interrupted render resumes where it stopped.

## The run
| time | what happens |
|---|---|
| 0–0.6 s | camera stream not up yet (black), then wakes overexposed while AE settles; boot chime |
| 1.7 s | suction fan spins up |
| 3 s | rolls off the dock across oiled oak planks, through the dappled sun from the window |
| 10 s | climbs the wool rug edge, eats a scatter of cereal crumbs |
| 13.4 s | bumps a coffee-table leg, backs off, re-plans |
| 15–26 s | across the sunlit rug, sun shafts in the haze, toward the sofa |
| 26–34 s | under the sofa: auto-exposure maxes out, sensor gain and noise climb; dust bunnies, a coin, a LEGO brick, a pen; hits the wall, turns in the dark |
| 39 s | over the aluminium threshold onto glazed kitchen tile (grout clicks per wheel) |
| 43.5 s | vision spots a sock, stops short, double beep |
| 45.5 s | "returning" chime, swings round and heads back into the sunlit room |

## How it works
**`src/scene.js`** — the apartment as ~150 primitives (plus 24 dynamic crumbs) (boxes, oriented boxes, capped
cylinders, open tubes, ellipsoids). The same description drives the shader, the
robot's 2D bumper-collision map and the floor micro-height under each wheel.

**`shaders/pathtrace.frag`** — a unidirectional path tracer in GLSL ES 3.0:
* GGX microfacet specular + Lambert diffuse, one-sample lobe selection, Fresnel-weighted
  (at 8 cm above the floor the oak and tile are near-grazing mirrors — that is the look).
* Next-event estimation per vertex against one of: the sun (soft 1.15° cone, both lobes),
  the window opening as an area light of sky radiance, or the lamp bulb.
* A tree canopy two metres outside the window, swaying in a procedural wind: it both shows
  in the window and dapples the sun patches on the floor.
* Single-scatter dust haze, so sunbeams are visible from floor level.
* Procedural materials: staggered oak planks with grain, per-plank tilt and grit; glazed
  tile with grout; a Beni Ourain–style wool rug; knit sock; brushed steel; books; etc.
* The camera: fisheye lens model (blend of rectilinear and equidistant, ~117° HFOV),
  **rolling shutter** (each row exposes later, along the interpolated pose track) and
  **motion blur** within the exposure time the AE chose.

  *Engineering note:* SIMD back-ends (SwiftShader, and GPU warps) execute both sides of a
  divergent `if` but must leave a loop once no lane needs it. The tracer therefore has
  exactly one `trace()` call site (path and shadow rays are queued through one loop),
  stores the scene in uniform arrays traversed by per-group AABB + short per-type loops
  that track only `(t, kind, index)`, and gates material branches with a `WHEN()` macro
  that is a 0-or-1-trip loop. Bounce rays skip "detail" groups. ~3× faster here (28k → ~80k samples/s).

**`shaders/post.glsl`** — resolve with firefly clamp and albedo demodulation; **temporal
reprojection** (each pixel un-projected with its own rolling-shutter row pose, re-projected
into the previous frame through a Newton-inverted fisheye, depth/normal-validated,
neighbourhood-clamped); edge-avoiding à-trous wavelet denoiser; then the **sensor**: lateral
chromatic aberration, edge enhancement, veiling glare, vignetting, photon shot noise and
read noise scaled by analog gain, row noise, warm auto-white-balance, ACES-style curve, sRGB.

**`src/timeline.js`** — a 1 kHz differential-drive simulation running the cleaning script
with acceleration limits, bumper contacts against the collision map, and a spring-damper
chassis driven by the real floor height under the caster and both wheels (rug pile,
12 mm rug edge, 5 mm threshold, 0.9 mm grout joints, plank seams), plus fan vibration.
It logs every event: bumps, surface changes, each grout crossing per wheel, each crumb.

**`src/render.js` + `src/gpu.js`** — drive WebGL2 in headless Chromium. A low-res metering
pass feeds a lagging auto-exposure loop that picks shutter time (1/4000–1/30 s) then
gain (up to 14×) — which is why it gets grainy and blurry under the sofa.

**`src/audio.js`** — 48 kHz synthesis from the simulation: brushless suction fan (shaft
harmonics + 7-blade pass + band-passed airflow, pitch drops under rug load), brush roll
that thrashes on the rug, side-brush ticks on hard floors, gear whine tracking each
wheel's speed, rolling noise, grout clicks, rug-edge and threshold thuds, bumper thud +
micro-switch press/release, wood knock vs wall thud, crumb crackle and bin rattle, chimes
through a tiny band-limited speaker, enclosure EQ under the sofa, a Schroeder room reverb,
room tone and FM birds through the window.

**`src/osd.js`** — burned-in timestamp from a hand-defined 5×7 bitmap font.

`tools/plan.js` draws a top-down debug map of the room, collision map, sun patch and route.
