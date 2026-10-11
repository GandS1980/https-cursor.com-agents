// Usage: npm run analyze -- [--fixed] [--json] [--export-demo DIR] file.wav [...]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { analyzeTrack, summarize } from "../engine/analyzer";
import { synthesize } from "../engine/synth";
import { DEMO_CATALOGS } from "../library/providers/demo";
import { decodeWav, encodeWav16 } from "./wav";

const args = process.argv.slice(2);
const mode = args.includes("--fixed") ? "fixed" : "flexible";
const asJson = args.includes("--json");
const exportIdx = args.indexOf("--export-demo");
if (exportIdx >= 0) {
  const dir = args[exportIdx + 1] ?? "demo-wavs";
  mkdirSync(dir, { recursive: true });
  for (const t of DEMO_CATALOGS.flatMap((c) => c.tracks)) {
    const { audio } = synthesize({ ...t.synth, sampleRate: 44_100, stereo: true });
    const path = join(dir, `${t.artist} - ${t.title}.wav`);
    writeFileSync(path, encodeWav16(audio));
    console.log(`wrote ${path}`);
  }
  process.exit(0);
}

const files = args.filter((a) => !a.startsWith("--"));
if (!files.length) {
  console.error("usage: npm run analyze -- [--fixed] [--json] file.wav [...]\n       npm run analyze -- --export-demo DIR");
  process.exit(2);
}
let failed = 0;
for (const file of files) {
  try {
    const a = analyzeTrack(decodeWav(readFileSync(file)), { mode, waveform: false });
    const s = summarize(a);
    if (asJson) {
      console.log(JSON.stringify({ file, mode, ...s, downbeatPhase: a.grid.downbeatPhase, segments: a.grid.segments, beats: a.grid.beats.map((b) => +b.toFixed(4)) }));
    } else {
      const segs = a.grid.segments.map((x) => `${x.bpm.toFixed(2)} @ ${x.startTime.toFixed(1)}s`).join("  →  ");
      console.log(`${file}\n  ${s.bpm} BPM (${mode})  ${s.key} / ${s.camelot}  ${a.grid.beats.length} beats  [${Math.round(a.analysisMs)} ms]\n  tempo map: ${segs}`);
    }
  } catch (err) {
    failed++;
    console.error(`${file}: ${err instanceof Error ? err.message : err}`);
  }
}
process.exit(failed ? 1 : 0);
