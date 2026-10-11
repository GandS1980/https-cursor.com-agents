import { describe, expect, it } from "vitest";
import type { BeatGrid } from "../src/engine/beatgrid";
import { DeckModel } from "../src/deck/deckModel";

/** 120 BPM for 16 beats then 150 BPM: lets loops be checked against a non-uniform grid. */
function steppedGrid(): BeatGrid {
  const beats: number[] = [];
  let t = 0.1;
  for (let i = 0; i < 64; i++) { beats.push(t); t += i < 16 ? 0.5 : 0.4; }
  return {
    mode: "flexible", beats, downbeatPhase: 0, downbeatConfidence: 1, bpm: 150,
    segments: [
      { startBeat: 0, endBeat: 16, startTime: 0.1, endTime: beats[16], bpm: 120 },
      { startBeat: 16, endBeat: 63, startTime: beats[16], endTime: 30, bpm: 150 },
    ],
  };
}

describe("loops", () => {
  it("auto-loops N beats from the current beat, quantized", () => {
    const deck = new DeckModel(steppedGrid(), 30);
    deck.position = 1.37; // between beat 2 (1.1) and beat 3 (1.6)
    expect(deck.autoLoop(4)).toEqual({ type: "loop", start: 1.1, end: 3.1, seekTo: 1.37 });
  });

  it("measures loop length in detected beats, so it follows a tempo change", () => {
    const deck = new DeckModel(steppedGrid(), 30);
    deck.position = 7.1; // beat 14, two beats before the tempo change
    deck.autoLoop(4);
    // beats 14→18: two at 0.5 s and two at 0.4 s
    expect(deck.loop!.end - deck.loop!.start).toBeCloseTo(1.8, 9);
  });

  it("wraps the playhead inside an active loop", () => {
    const deck = new DeckModel(steppedGrid(), 30);
    deck.position = 1.1;
    deck.autoLoop(2); // 1.1 → 2.1
    deck.advance(0.7);
    expect(deck.position).toBeCloseTo(1.8, 9);
    deck.advance(0.5);
    expect(deck.position).toBeCloseTo(1.3, 9);
    deck.exitLoop();
    deck.advance(1);
    expect(deck.position).toBeCloseTo(2.3, 9);
  });

  it("halves and doubles in beats", () => {
    const deck = new DeckModel(steppedGrid(), 30);
    deck.position = 1.1;
    deck.autoLoop(4);
    deck.resizeLoop(0.5);
    expect(deck.loop!.end).toBeCloseTo(2.1, 9);
    deck.resizeLoop(2);
    deck.resizeLoop(2);
    expect(deck.loop!.end).toBeCloseTo(5.1, 9);
  });

  it("supports manual loop in/out with quantize", () => {
    const deck = new DeckModel(steppedGrid(), 30);
    deck.position = 2.08; deck.loopIn();
    deck.position = 3.62; const effect = deck.loopOut();
    expect(effect).toMatchObject({ type: "loop", start: 2.1, end: 3.6 });
  });
});

describe("cue loops (save active loop to a hot cue pad)", () => {
  it("saves the active loop and recalls it with one touch from anywhere", () => {
    const deck = new DeckModel(steppedGrid(), 30);
    deck.position = 3.2;
    deck.autoLoop(8);
    const saved = { start: deck.loop!.start, end: deck.loop!.end };
    deck.saveLoopToPad(2);
    expect(deck.pads[2]).toMatchObject({ kind: "loop", ...saved });

    deck.exitLoop();
    deck.position = 20;
    const effect = deck.triggerPad(2);
    expect(effect).toEqual({ type: "loop", start: saved.start, end: saved.end, seekTo: saved.start });
    expect(deck.loop).toEqual({ ...saved, active: true });
    expect(deck.position).toBe(saved.start);
  });

  it("captures a fresh auto-loop when no loop is active, so one press always works", () => {
    const deck = new DeckModel(steppedGrid(), 30);
    deck.position = 0.6;
    deck.saveLoopToPad(0, 2);
    expect(deck.pads[0]).toMatchObject({ kind: "loop", start: 0.6, end: 1.6 });
  });

  it("replaces whatever loop is running when a different cue loop is triggered", () => {
    const deck = new DeckModel(steppedGrid(), 30);
    deck.position = 0.1; deck.autoLoop(1); deck.saveLoopToPad(0);
    deck.position = 10; deck.autoLoop(2); deck.saveLoopToPad(1);
    deck.triggerPad(0);
    expect(deck.loop).toMatchObject({ start: 0.1, end: 0.6, active: true });
    deck.advance(0.75);
    expect(deck.position).toBeCloseTo(0.35, 9);
  });

  it("keeps ordinary hot cues and cue loops side by side", () => {
    const deck = new DeckModel(steppedGrid(), 30);
    deck.position = 4.12; deck.setHotCue(0);
    deck.position = 6; deck.saveLoopToPad(1);
    expect(deck.pads[0]).toMatchObject({ kind: "cue", time: 4.1 });
    expect(deck.triggerPad(0)).toEqual({ type: "seek", time: 4.1 });
    expect(deck.pads[1]?.kind).toBe("loop");
    deck.clearPad(1);
    expect(deck.triggerPad(1)).toEqual({ type: "none" });
  });

  it("survives export/import and a regrid", () => {
    const deck = new DeckModel(steppedGrid(), 30);
    deck.position = 2; deck.saveLoopToPad(5);
    const bank = deck.exportPads();
    const other = new DeckModel(steppedGrid(), 30);
    other.importPads(bank);
    other.regrid({ ...steppedGrid(), mode: "fixed" });
    expect(other.pads[5]).toEqual(deck.pads[5]);
    bank[5] = null;
    expect(other.pads[5]).not.toBeNull(); // deep copy
  });
});
