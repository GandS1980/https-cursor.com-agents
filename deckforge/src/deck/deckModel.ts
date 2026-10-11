import { beatIndexAt, nearestBeatTime, timeOfBeat, type BeatGrid } from "../engine/beatgrid";

export const PAD_COUNT = 8;

export type PadSlot =
  | { kind: "cue"; time: number; color: string }
  | { kind: "loop"; start: number; end: number; color: string };

export interface LoopState {
  start: number;
  end: number;
  active: boolean;
}

/** What a pad press asks the audio engine to do. */
export type DeckEffect =
  | { type: "seek"; time: number }
  | { type: "loop"; start: number; end: number; seekTo: number }
  | { type: "none" };

const CUE_COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#46a758", "#0090ff", "#8e4ec6", "#d6409f", "#12a594"];
const LOOP_COLOR = "#30a46c";

/**
 * Pure deck state: playhead, beat-aware loops and the 8 performance pads.
 *
 * Everything time-related is resolved against the track's BeatGrid, so a 4-beat loop on a
 * flexible grid spans four *detected* beats even where the tempo drifts — the loop stays on
 * the music instead of on a metronome.
 */
export class DeckModel {
  position = 0;
  loop: LoopState | null = null;
  readonly pads: (PadSlot | null)[] = Array.from({ length: PAD_COUNT }, () => null);
  quantize = true;
  private pendingLoopIn: number | null = null;

  constructor(public grid: BeatGrid | null = null, public duration = 0) {}

  load(grid: BeatGrid, duration: number): void {
    this.grid = grid;
    this.duration = duration;
    this.position = 0;
    this.loop = null;
    this.pendingLoopIn = null;
    this.pads.fill(null);
  }

  /** Swap the grid (e.g. Fixed ↔ Flexible) without losing pads, loop or position. */
  regrid(grid: BeatGrid): void {
    this.grid = grid;
  }

  private snap(t: number): number {
    return this.quantize && this.grid ? nearestBeatTime(this.grid, t) : t;
  }

  /** Auto-loop of `beats` beats starting at the current (or previous, when quantized) beat. */
  autoLoop(beats: number): DeckEffect {
    if (!this.grid) return { type: "none" };
    const startIdx = this.quantize ? Math.floor(beatIndexAt(this.grid, this.position) + 1e-6) : beatIndexAt(this.grid, this.position);
    const start = timeOfBeat(this.grid, startIdx);
    const end = Math.min(this.duration, timeOfBeat(this.grid, startIdx + beats));
    this.loop = { start, end, active: true };
    return { type: "loop", start, end, seekTo: this.position };
  }

  loopIn(): void {
    this.pendingLoopIn = this.snap(this.position);
  }

  loopOut(): DeckEffect {
    if (this.pendingLoopIn === null) return { type: "none" };
    const end = this.snap(this.position);
    if (end <= this.pendingLoopIn) return { type: "none" };
    this.loop = { start: this.pendingLoopIn, end, active: true };
    this.pendingLoopIn = null;
    return { type: "loop", start: this.loop.start, end, seekTo: this.position };
  }

  /** Halve/double the active loop length in beats, keeping its start. */
  resizeLoop(factor: 0.5 | 2): DeckEffect {
    if (!this.loop || !this.grid) return { type: "none" };
    const a = beatIndexAt(this.grid, this.loop.start);
    const b = beatIndexAt(this.grid, this.loop.end);
    const len = Math.max(1 / 32, (b - a) * factor);
    this.loop.end = Math.min(this.duration, timeOfBeat(this.grid, a + len));
    const seekTo = this.position >= this.loop.end ? this.loop.start : this.position;
    return { type: "loop", start: this.loop.start, end: this.loop.end, seekTo };
  }

  exitLoop(): void {
    if (this.loop) this.loop.active = false;
  }

  reloop(): DeckEffect {
    if (!this.loop) return { type: "none" };
    this.loop.active = true;
    return { type: "loop", start: this.loop.start, end: this.loop.end, seekTo: this.loop.start };
  }

  setHotCue(pad: number): void {
    this.pads[pad] = { kind: "cue", time: this.snap(this.position), color: CUE_COLORS[pad % CUE_COLORS.length] };
  }

  /**
   * Cue Loop: store the active loop on a pad. With no active loop, captures a new auto-loop of
   * `fallbackBeats` from the playhead first, so one press always yields a recallable loop.
   */
  saveLoopToPad(pad: number, fallbackBeats = 4): DeckEffect {
    let effect: DeckEffect = { type: "none" };
    if (!this.loop?.active) effect = this.autoLoop(fallbackBeats);
    if (!this.loop) return effect;
    this.pads[pad] = { kind: "loop", start: this.loop.start, end: this.loop.end, color: LOOP_COLOR };
    return effect;
  }

  /**
   * One-touch recall. A cue pad jumps to its point; a loop pad jumps to the loop start and
   * engages the stored loop (replacing any active loop).
   */
  triggerPad(pad: number): DeckEffect {
    const slot = this.pads[pad];
    if (!slot) return { type: "none" };
    if (slot.kind === "cue") {
      this.position = slot.time;
      return { type: "seek", time: slot.time };
    }
    this.loop = { start: slot.start, end: slot.end, active: true };
    this.position = slot.start;
    return { type: "loop", start: slot.start, end: slot.end, seekTo: slot.start };
  }

  clearPad(pad: number): void {
    this.pads[pad] = null;
  }

  /**
   * Advance the playhead by `dt` seconds of track time, wrapping inside an active loop.
   * Used by tests and by the UI clock; the audio engine wraps loops natively.
   */
  advance(dt: number): number {
    let p = this.position + dt;
    if (this.loop?.active && this.position < this.loop.end + 1e-9 && p >= this.loop.end) {
      const len = this.loop.end - this.loop.start;
      p = this.loop.start + ((p - this.loop.start) % len);
    }
    this.position = Math.min(p, this.duration);
    return this.position;
  }

  /** Serializable pad bank, so cue points and cue loops survive reloads. */
  exportPads(): (PadSlot | null)[] {
    return this.pads.map((p) => (p ? { ...p } : null));
  }

  importPads(pads: (PadSlot | null)[]): void {
    for (let i = 0; i < PAD_COUNT; i++) this.pads[i] = pads[i] ? { ...pads[i]! } : null;
  }
}
