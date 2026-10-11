/**
 * Web Audio playback for one deck. AudioBufferSourceNodes are one-shot, so seeks restart a
 * fresh source; loops use the source's native sample-accurate looping.
 */
export class DeckPlayer {
  readonly output: GainNode;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private anchorCtxTime = 0;
  private anchorOffset = 0;
  private rate = 1;
  private loop: { start: number; end: number; active: boolean } | null = null;
  playing = false;

  constructor(private readonly ctx: AudioContext) {
    this.output = ctx.createGain();
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  load(buffer: AudioBuffer): void {
    this.stopSource();
    this.buffer = buffer;
    this.playing = false;
    this.anchorOffset = 0;
    this.loop = null;
  }

  position(): number {
    if (!this.playing) return this.anchorOffset;
    let p = this.anchorOffset + (this.ctx.currentTime - this.anchorCtxTime) * this.rate;
    const l = this.loop;
    if (l?.active && this.anchorOffset < l.end && p >= l.end) {
      p = l.start + ((p - l.start) % (l.end - l.start));
    }
    return Math.min(p, this.duration);
  }

  play(): void {
    if (!this.buffer || this.playing) return;
    if (this.anchorOffset >= this.duration) this.anchorOffset = 0;
    this.startSource(this.anchorOffset);
    this.playing = true;
  }

  pause(): void {
    if (!this.playing) return;
    this.anchorOffset = this.position();
    this.stopSource();
    this.playing = false;
  }

  seek(t: number): void {
    const target = Math.max(0, Math.min(t, this.duration));
    if (this.playing) {
      this.stopSource();
      this.startSource(target);
    } else {
      this.anchorOffset = target;
    }
  }

  setRate(rate: number): void {
    this.reanchor();
    this.rate = rate;
    if (this.source) this.source.playbackRate.setValueAtTime(rate, this.ctx.currentTime);
  }

  getRate(): number {
    return this.rate;
  }

  /** Engage a loop and jump to `seekTo` (sample-accurate wrap from then on). */
  setLoop(start: number, end: number, seekTo: number): void {
    this.loop = { start, end, active: true };
    this.seek(seekTo);
  }

  exitLoop(): void {
    if (!this.loop) return;
    this.reanchor();
    this.loop.active = false;
    if (this.source) this.source.loop = false;
  }

  private reanchor(): void {
    this.anchorOffset = this.position();
    this.anchorCtxTime = this.ctx.currentTime;
  }

  private startSource(offset: number): void {
    if (!this.buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.rate;
    if (this.loop?.active) {
      src.loop = true;
      src.loopStart = this.loop.start;
      src.loopEnd = this.loop.end;
    }
    src.connect(this.output);
    src.onended = () => {
      if (this.source === src) {
        this.anchorOffset = this.duration;
        this.playing = false;
        this.source = null;
      }
    };
    src.start(0, offset);
    this.source = src;
    this.anchorCtxTime = this.ctx.currentTime;
    this.anchorOffset = offset;
  }

  private stopSource(): void {
    if (!this.source) return;
    const s = this.source;
    this.source = null;
    s.onended = null;
    try { s.stop(); } catch { /* already stopped */ }
    s.disconnect();
  }
}
