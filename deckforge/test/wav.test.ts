import { describe, expect, it } from "vitest";
import { analyzeTrack } from "../src/engine/analyzer";
import { synthesize } from "../src/engine/synth";
import { decodeWav, encodeWav16 } from "../src/cli/wav";

describe("WAV I/O", () => {
  it("round-trips 16-bit stereo within quantisation error", () => {
    const left = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10) * 0.8);
    const right = Float32Array.from({ length: 1000 }, (_, i) => Math.cos(i / 7) * 0.5);
    const back = decodeWav(encodeWav16({ sampleRate: 48_000, channels: [left, right] }));
    expect(back.sampleRate).toBe(48_000);
    expect(back.channels).toHaveLength(2);
    for (let i = 0; i < 1000; i += 37) {
      expect(back.channels[0][i]).toBeCloseTo(left[i], 4);
      expect(back.channels[1][i]).toBeCloseTo(right[i], 4);
    }
  });

  it("rejects non-WAV input", () => {
    expect(() => decodeWav(new TextEncoder().encode("ID3 definitely an mp3"))).toThrow(/RIFF/);
  });

  it("analysis survives the 16-bit file path", () => {
    const s = synthesize({ durationSec: 30, sampleRate: 44_100, stereo: true, bpmAt: () => 132, tonic: 11, mode: "minor", seed: 2 });
    const a = analyzeTrack(decodeWav(encodeWav16(s.audio)), { mode: "fixed" });
    expect(a.grid.bpm).toBe(132);
    expect(a.key.name).toBe("Bm");
  });
});
