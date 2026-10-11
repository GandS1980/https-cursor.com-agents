import { bpmLabels, isDownbeat, type BeatGrid, type BpmLabel } from "../engine/beatgrid";
import type { WaveformData } from "../engine/waveform";
import type { LoopState, PadSlot } from "../deck/deckModel";

export interface WaveformFrame {
  waveform: WaveformData;
  grid: BeatGrid;
  duration: number;
  position: number;
  loop: LoopState | null;
  pads: (PadSlot | null)[];
  /** Playback rate: labels show the *effective* BPM a listener hears. */
  rate: number;
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function sizeCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const g = canvas.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

function drawBands(g: CanvasRenderingContext2D, wf: WaveformData, x0: number, width: number, height: number, t0: number, secPerPx: number) {
  const mid = height / 2;
  const bands: [Float32Array, string][] = [[wf.low, css("--wf-low")], [wf.mid, css("--wf-mid")], [wf.high, css("--wf-high")]];
  g.globalCompositeOperation = "lighter";
  for (const [data, color] of bands) {
    g.fillStyle = color;
    g.beginPath();
    for (let px = 0; px < width; px++) {
      const a = Math.floor((t0 + px * secPerPx) * wf.resolution);
      const b = Math.max(a + 1, Math.floor((t0 + (px + 1) * secPerPx) * wf.resolution));
      if (b <= 0 || a >= data.length) continue;
      let peak = 0;
      for (let i = Math.max(0, a); i < Math.min(data.length, b); i++) if (data[i] > peak) peak = data[i];
      const h = peak ** 0.8 * (height / 2 - 2);
      g.rect(x0 + px, mid - h, 1, h * 2);
    }
    g.fill();
  }
  g.globalCompositeOperation = "source-over";
}

/** Zoomed, scrolling view centred on the playhead. */
export function drawScrolling(canvas: HTMLCanvasElement, f: WaveformFrame, windowSec = 8): void {
  const g = sizeCanvas(canvas);
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  g.fillStyle = css("--wf-bg");
  g.fillRect(0, 0, W, H);
  const secPerPx = windowSec / W;
  const t0 = f.position - windowSec / 2;
  const x = (t: number) => (t - t0) / secPerPx;

  if (f.loop) {
    g.fillStyle = f.loop.active ? css("--loop-active") : css("--loop-idle");
    g.fillRect(x(f.loop.start), 0, x(f.loop.end) - x(f.loop.start), H);
  }

  drawBands(g, f.waveform, 0, W, H, t0, secPerPx);

  // Beat grid: every beat thin, downbeats strong with bar numbers.
  g.font = "600 10px ui-monospace, monospace";
  f.grid.beats.forEach((t, i) => {
    if (t < t0 || t > t0 + windowSec) return;
    const down = isDownbeat(f.grid, i);
    g.fillStyle = down ? css("--grid-down") : css("--grid-beat");
    g.fillRect(Math.round(x(t)), 0, down ? 2 : 1, H);
    if (down) {
      const bar = Math.floor((i - f.grid.downbeatPhase) / 4) + 1;
      g.fillStyle = css("--grid-down");
      g.fillText(String(bar), Math.round(x(t)) + 3, H - 4);
    }
  });

  drawCueMarkers(g, f.pads, x, H);
  drawBpmLabels(g, bpmLabels(f.grid, 4), f.rate, x, W);

  g.fillStyle = css("--playhead");
  g.fillRect(Math.round(W / 2) - 1, 0, 2, H);
}

/** Whole-track overview with the visible window and tempo-change markers. */
export function drawOverview(canvas: HTMLCanvasElement, f: WaveformFrame): void {
  const g = sizeCanvas(canvas);
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  g.fillStyle = css("--wf-bg");
  g.fillRect(0, 0, W, H);
  const secPerPx = f.duration / W;
  drawBands(g, f.waveform, 0, W, H, 0, secPerPx);
  const x = (t: number) => t / secPerPx;
  if (f.loop) {
    g.fillStyle = f.loop.active ? css("--loop-active") : css("--loop-idle");
    g.fillRect(x(f.loop.start), 0, Math.max(2, x(f.loop.end) - x(f.loop.start)), H);
  }
  drawCueMarkers(g, f.pads, x, H);
  g.font = "600 9px ui-monospace, monospace";
  for (const seg of f.grid.segments.slice(1)) {
    g.fillStyle = css("--bpm-change");
    g.fillRect(Math.round(x(seg.startTime)), 0, 1, H);
  }
  g.fillStyle = css("--wf-played");
  g.fillRect(0, 0, x(f.position), H);
  g.fillStyle = css("--playhead");
  g.fillRect(Math.round(x(f.position)), 0, 2, H);
}

function drawCueMarkers(g: CanvasRenderingContext2D, pads: (PadSlot | null)[], x: (t: number) => number, H: number) {
  pads.forEach((p, i) => {
    if (!p) return;
    const t = p.kind === "cue" ? p.time : p.start;
    const px = Math.round(x(t));
    g.fillStyle = p.color;
    g.beginPath();
    g.moveTo(px, 0);
    g.lineTo(px + 7, 0);
    g.lineTo(px, 9);
    g.fill();
    g.fillRect(px, 0, 1, H);
    g.font = "700 9px ui-monospace, monospace";
    g.fillText(p.kind === "loop" ? `L${i + 1}` : String(i + 1), px + 2, 18);
  });
}

function drawBpmLabels(g: CanvasRenderingContext2D, labels: BpmLabel[], rate: number, x: (t: number) => number, W: number) {
  g.font = "600 11px ui-monospace, monospace";
  for (const l of labels) {
    const px = x(l.time);
    if (px < -80 || px > W) continue;
    const text = `${(l.bpm * rate).toFixed(1)} BPM${l.isChange ? " ▲" : ""}`;
    const tw = g.measureText(text).width + 8;
    g.fillStyle = l.isChange ? css("--bpm-change") : css("--bpm-label-bg");
    g.fillRect(px + 2, 3, tw, 15);
    g.fillStyle = l.isChange ? css("--bpm-change-fg") : css("--bpm-label-fg");
    g.fillText(text, px + 6, 14);
  }
}
