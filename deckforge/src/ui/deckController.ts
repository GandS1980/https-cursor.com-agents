import { summarize, type TrackAnalysis } from "../engine/analyzer";
import { AnalysisClient, decodeSource } from "../engine/analysisClient";
import { beatIndexAt, bpmAt, timeOfBeat, type GridMode } from "../engine/beatgrid";
import { DeckModel, PAD_COUNT, type DeckEffect, type PadSlot } from "../deck/deckModel";
import { DeckPlayer } from "../deck/player";
import type { LibrarySession } from "../library/session";
import type { TrackRef } from "../library/types";
import { formatTime, h, storage } from "./dom";
import { drawOverview, drawScrolling } from "./waveformView";

type PadMode = "hotcue" | "cueloop";

export class DeckController {
  readonly model = new DeckModel();
  readonly player: DeckPlayer;
  readonly root: HTMLElement;
  private analyses: Partial<Record<GridMode, TrackAnalysis>> = {};
  private gridMode: GridMode = "flexible";
  private padMode: PadMode = "hotcue";
  private track: TrackRef | null = null;
  private mainCue = 0;
  private loading = false;
  partner: DeckController | null = null;

  private readonly el = {
    title: h("div.deck-title", {}, "No track loaded"),
    artist: h("div.deck-artist", {}, "Load a track from the library"),
    bpm: h("div.readout.bpm", { "data-testid": "bpm" }, "—"),
    key: h("div.readout.key", { "data-testid": "key" }, "—"),
    time: h("div.readout.time", {}, "0:00.0"),
    status: h("div.deck-status", { role: "status" }),
    scrolling: h("canvas.wf-scroll", { "aria-label": "Scrolling waveform" }) as HTMLCanvasElement,
    overview: h("canvas.wf-overview", { "aria-label": "Track overview" }) as HTMLCanvasElement,
    play: h("button.transport.play", { title: "Play / pause" }, "▶"),
    pitchSlider: h("input.pitch", { type: "range", min: -8, max: 8, step: 0.05, value: 0, "aria-label": "Pitch" }) as HTMLInputElement,
    pitchValue: h("span.pitch-value", {}, "0.00%"),
    pads: [] as HTMLButtonElement[],
    modeFlexible: h("button.seg", { "aria-pressed": "true" }, "Flexible"),
    modeFixed: h("button.seg", { "aria-pressed": "false" }, "Fixed"),
    padHot: h("button.seg", { "aria-pressed": "true" }, "Hot Cue"),
    padLoop: h("button.seg", { "aria-pressed": "false", "data-testid": "padmode-cueloop" }, "Cue Loop"),
    loopButtons: [] as HTMLButtonElement[],
    segments: h("div.segments"),
  };

  constructor(
    readonly name: "A" | "B",
    private readonly ctx: AudioContext,
    private readonly session: LibrarySession,
    private readonly analysis: AnalysisClient,
  ) {
    this.player = new DeckPlayer(ctx);
    this.root = this.render();
  }

  private render(): HTMLElement {
    const e = this.el;
    e.play.onclick = () => this.togglePlay();
    e.pitchSlider.oninput = () => this.setPitch(Number(e.pitchSlider.value));
    e.pitchSlider.ondblclick = () => this.setPitch(0);
    e.modeFlexible.onclick = () => void this.setGridMode("flexible");
    e.modeFixed.onclick = () => void this.setGridMode("fixed");
    e.padHot.onclick = () => this.setPadMode("hotcue");
    e.padLoop.onclick = () => this.setPadMode("cueloop");
    e.overview.onclick = (ev) => {
      const r = e.overview.getBoundingClientRect();
      this.seek(((ev.clientX - r.left) / r.width) * this.model.duration);
    };

    for (let i = 0; i < PAD_COUNT; i++) {
      const pad = h("button.pad", { "data-testid": `pad-${this.name}-${i + 1}`, title: "Click: set / trigger · Shift-click or right-click: clear" }, String(i + 1)) as HTMLButtonElement;
      pad.onclick = (ev) => (ev.shiftKey ? this.clearPad(i) : this.pressPad(i));
      pad.oncontextmenu = (ev) => { ev.preventDefault(); this.clearPad(i); };
      e.pads.push(pad);
    }
    const loopBtn = (label: string, fn: () => void, testid?: string) => {
      const b = h("button.loop-btn", { "data-testid": testid }, label) as HTMLButtonElement;
      b.onclick = fn;
      e.loopButtons.push(b);
      return b;
    };

    return h(`section.deck.deck-${this.name.toLowerCase()}`, { "aria-label": `Deck ${this.name}` },
      h("header.deck-head", {},
        h("div.deck-letter", {}, this.name),
        h("div.deck-meta", {}, e.title, e.artist),
        h("div.readouts", {}, e.bpm, e.key, e.time),
      ),
      h("div.waveforms", {}, e.scrolling, e.overview),
      e.segments,
      h("div.controls", {},
        h("div.group", {},
          h("button.transport.cue", { onclick: () => this.cue(), title: "Cue: set when paused, return when playing" }, "CUE"),
          e.play,
          h("button.transport.sync", { onclick: () => this.sync(), title: "Match tempo and beat phase to the other deck" }, "SYNC"),
        ),
        h("div.group.grid-mode", { role: "group", "aria-label": "Beatgrid mode" }, h("span.group-label", {}, "Grid"), e.modeFlexible, e.modeFixed),
        h("label.pitch-wrap", {}, h("span.group-label", {}, "Pitch"), e.pitchSlider, e.pitchValue),
      ),
      h("div.controls", {},
        h("div.group.loops", { role: "group", "aria-label": "Loops" },
          h("span.group-label", {}, "Loop"),
          ...[1, 2, 4, 8, 16].map((n) => loopBtn(String(n), () => this.apply(this.model.autoLoop(n)), `loop-${this.name}-${n}`)),
          loopBtn("½", () => this.apply(this.model.resizeLoop(0.5))),
          loopBtn("×2", () => this.apply(this.model.resizeLoop(2))),
          loopBtn("IN", () => this.model.loopIn()),
          loopBtn("OUT", () => this.apply(this.model.loopOut())),
          loopBtn("RELOOP", () => this.apply(this.model.reloop())),
          loopBtn("EXIT", () => this.exitLoop(), `loopexit-${this.name}`),
        ),
      ),
      h("div.pad-section", {},
        h("div.group", { role: "group", "aria-label": "Pad mode" }, e.padHot, e.padLoop),
        h("div.pads", {}, ...e.pads),
      ),
      e.status,
    );
  }

  async load(track: TrackRef): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.status(`Loading ${track.title}…`);
    try {
      void this.ctx.resume();
      const source = await this.session.fetchAudio(track.id);
      const { pcm, buffer } = await decodeSource(this.ctx, source);
      this.status(`Analysing (${this.gridMode})…`);
      const analysis = await this.analysis.analyze(pcm, { mode: this.gridMode });
      this.analyses = { [this.gridMode]: analysis };
      this.track = track;
      this.player.load(buffer);
      this.model.load(analysis.grid, analysis.duration);
      const savedPads = storage.get<(PadSlot | null)[]>(`deckforge:pads:${track.id}`);
      if (savedPads) this.model.importPads(savedPads);
      this.mainCue = analysis.grid.beats[0] ?? 0;
      this.player.seek(this.mainCue);
      this.session.recordSummary(track.id, summarize(analysis));
      this.el.title.textContent = track.title;
      this.el.artist.textContent = track.artist;
      this.el.key.textContent = `${analysis.key.name} · ${analysis.key.camelot}`;
      this.renderSegments();
      this.renderPads();
      this.status(`Analysed in ${Math.round(analysis.analysisMs)} ms`);
    } catch (err) {
      this.status(`Could not load: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.loading = false;
    }
  }

  private async setGridMode(mode: GridMode): Promise<void> {
    this.gridMode = mode;
    this.el.modeFlexible.setAttribute("aria-pressed", String(mode === "flexible"));
    this.el.modeFixed.setAttribute("aria-pressed", String(mode === "fixed"));
    if (!this.track) return;
    let a = this.analyses[mode];
    if (!a) {
      this.status(`Re-analysing (${mode})…`);
      const source = await this.session.fetchAudio(this.track.id);
      const { pcm } = await decodeSource(this.ctx, source);
      a = await this.analysis.analyze(pcm, { mode });
      this.analyses[mode] = a;
    }
    this.model.regrid(a.grid);
    this.renderSegments();
    this.status(`${mode === "flexible" ? "Flexible" : "Fixed"} grid: ${a.grid.segments.length} tempo segment${a.grid.segments.length > 1 ? "s" : ""}`);
  }

  private setPadMode(mode: PadMode): void {
    this.padMode = mode;
    this.el.padHot.setAttribute("aria-pressed", String(mode === "hotcue"));
    this.el.padLoop.setAttribute("aria-pressed", String(mode === "cueloop"));
    this.root.classList.toggle("cueloop-mode", mode === "cueloop");
  }

  pressPad(i: number): void {
    if (!this.track) return;
    this.syncPosition();
    if (this.model.pads[i]) {
      this.apply(this.model.triggerPad(i));
    } else if (this.padMode === "cueloop") {
      this.apply(this.model.saveLoopToPad(i, 4));
      this.status(`Loop saved to pad ${i + 1}`);
    } else {
      this.model.setHotCue(i);
    }
    this.persistPads();
    this.renderPads();
  }

  private clearPad(i: number): void {
    this.model.clearPad(i);
    this.persistPads();
    this.renderPads();
  }

  private persistPads(): void {
    if (this.track) storage.set(`deckforge:pads:${this.track.id}`, this.model.exportPads());
  }

  private apply(effect: DeckEffect): void {
    if (effect.type === "seek") {
      const l = this.model.loop;
      if (l?.active && (effect.time < l.start || effect.time >= l.end)) this.exitLoop();
      this.player.seek(effect.time);
    } else if (effect.type === "loop") {
      this.player.setLoop(effect.start, effect.end, effect.seekTo);
    }
  }

  private exitLoop(): void {
    this.model.exitLoop();
    this.player.exitLoop();
  }

  togglePlay(): void {
    if (!this.track) return;
    void this.ctx.resume();
    if (this.player.playing) this.player.pause(); else this.player.play();
  }

  private cue(): void {
    if (!this.track) return;
    if (this.player.playing) {
      this.player.pause();
      this.player.seek(this.mainCue);
    } else {
      this.syncPosition();
      this.mainCue = this.model.quantize && this.model.grid ? timeOfBeat(this.model.grid, Math.round(beatIndexAt(this.model.grid, this.model.position))) : this.model.position;
      this.player.seek(this.mainCue);
    }
  }

  private seek(t: number): void {
    const l = this.model.loop;
    if (l?.active && (t < l.start || t >= l.end)) this.exitLoop();
    this.player.seek(t);
  }

  private setPitch(pct: number): void {
    this.el.pitchSlider.value = String(pct);
    this.el.pitchValue.textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
    this.player.setRate(1 + pct / 100);
  }

  /** Tempo-match to the other deck, then nudge this deck onto its beat phase. */
  sync(): void {
    const other = this.partner;
    if (!this.track || !other?.model.grid || !this.model.grid) return;
    this.syncPosition();
    other.syncPosition();
    const target = bpmAt(other.model.grid, other.model.position) * other.player.getRate();
    const mine = bpmAt(this.model.grid, this.model.position);
    const pct = Math.max(-50, Math.min(100, (target / mine - 1) * 100));
    this.setPitch(pct);
    if (this.player.playing && other.player.playing) {
      const frac = (x: number) => x - Math.floor(x);
      let delta = frac(beatIndexAt(other.model.grid, other.model.position)) - frac(beatIndexAt(this.model.grid, this.model.position));
      if (delta > 0.5) delta -= 1;
      if (delta < -0.5) delta += 1;
      const idx = beatIndexAt(this.model.grid, this.model.position);
      this.player.seek(timeOfBeat(this.model.grid, idx + delta));
    }
  }

  private syncPosition(): void {
    this.model.position = this.player.position();
  }

  /** Called every animation frame. */
  tick(): void {
    this.el.play.textContent = this.player.playing ? "❚❚" : "▶";
    this.el.play.classList.toggle("on", this.player.playing);
    const analysis = this.analyses[this.gridMode] ?? Object.values(this.analyses)[0];
    if (!analysis || !this.model.grid) return;
    this.syncPosition();
    const bpm = bpmAt(this.model.grid, this.model.position) * this.player.getRate();
    this.el.bpm.textContent = bpm.toFixed(2);
    this.el.time.textContent = `${formatTime(this.model.position)} / ${formatTime(this.model.duration)}`;
    const frame = {
      waveform: analysis.waveform,
      grid: this.model.grid,
      duration: this.model.duration,
      position: this.model.position,
      loop: this.model.loop,
      pads: this.model.pads,
      rate: this.player.getRate(),
    };
    drawScrolling(this.el.scrolling, frame);
    drawOverview(this.el.overview, frame);
    this.root.classList.toggle("looping", !!this.model.loop?.active);
  }

  private renderPads(): void {
    this.model.pads.forEach((p, i) => {
      const pad = this.el.pads[i];
      pad.classList.toggle("filled", !!p);
      pad.classList.toggle("loop", p?.kind === "loop");
      pad.style.setProperty("--pad-color", p?.color ?? "transparent");
      pad.textContent = p?.kind === "loop" && this.model.grid
        ? `${i + 1} · ${Math.round(beatIndexAt(this.model.grid, p.end) - beatIndexAt(this.model.grid, p.start))}♩`
        : String(i + 1);
      pad.setAttribute("aria-label", p ? `Pad ${i + 1}: ${p.kind === "loop" ? "cue loop" : "hot cue"}` : `Pad ${i + 1}: empty`);
    });
  }

  private renderSegments(): void {
    const g = this.model.grid;
    this.el.segments.replaceChildren();
    if (!g) return;
    for (const s of g.segments) {
      this.el.segments.append(h("span.segment", { style: `flex:${Math.max(0.02, s.endTime - s.startTime)}` }, `${s.bpm.toFixed(1)}`));
    }
  }

  private status(text: string): void {
    this.el.status.textContent = text;
  }
}
