import type { AnalyzeOptions, PcmAudio, TrackAnalysis } from "./analyzer";
import type { AnalysisRequest, AnalysisResponse } from "./analysis.worker";
import type { AudioSource } from "../library/types";

/** Runs analyses on a pool of workers so the UI and audio thread never stall. */
export class AnalysisClient {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, { resolve: (a: TrackAnalysis) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private turn = 0;

  constructor(size = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1))) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<AnalysisResponse>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.ok) p.resolve(e.data.analysis);
        else p.reject(new Error(e.data.error));
      };
      this.workers.push(w);
    }
  }

  analyze(audio: PcmAudio, options: AnalyzeOptions): Promise<TrackAnalysis> {
    const id = this.nextId++;
    const worker = this.workers[this.turn++ % this.workers.length];
    // Copy channels (the deck keeps playing from the originals), sending shared buffers once.
    const unique = [...new Set(audio.channels)];
    const copy: PcmAudio = { sampleRate: audio.sampleRate, channels: unique.map((c) => c.slice()) };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, audio: copy, options } satisfies AnalysisRequest, copy.channels.map((c) => c.buffer));
    });
  }
}

/** Decode any AudioSource to PCM plus a playable AudioBuffer. */
export async function decodeSource(ctx: BaseAudioContext, source: AudioSource): Promise<{ pcm: PcmAudio; buffer: AudioBuffer }> {
  if (source.kind === "pcm") {
    const { sampleRate, channels } = source.audio;
    const buffer = ctx.createBuffer(channels.length, channels[0].length, sampleRate);
    channels.forEach((c, i) => buffer.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    return { pcm: source.audio, buffer };
  }
  const buffer = await ctx.decodeAudioData(source.bytes.slice(0));
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  return { pcm: { sampleRate: buffer.sampleRate, channels }, buffer };
}
