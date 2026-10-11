/// <reference lib="webworker" />
import { analyzeTrack, type AnalyzeOptions, type PcmAudio, type TrackAnalysis } from "./analyzer";

export interface AnalysisRequest {
  id: number;
  audio: PcmAudio;
  options: AnalyzeOptions;
}

export type AnalysisResponse =
  | { id: number; ok: true; analysis: TrackAnalysis }
  | { id: number; ok: false; error: string };

self.onmessage = (e: MessageEvent<AnalysisRequest>) => {
  const { id, audio, options } = e.data;
  try {
    const analysis = analyzeTrack(audio, options);
    const w = analysis.waveform;
    (self as DedicatedWorkerGlobalScope).postMessage({ id, ok: true, analysis } satisfies AnalysisResponse, [
      w.low.buffer, w.mid.buffer, w.high.buffer,
    ]);
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies AnalysisResponse);
  }
};
