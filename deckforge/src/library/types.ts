import type { PcmAudio, TrackSummary } from "../engine/analyzer";

export interface TrackRef {
  /** Globally unique: `${providerId}:${providerTrackId}`. */
  id: string;
  providerId: string;
  title: string;
  artist: string;
  durationSec?: number;
  genre?: string;
}

export type AudioSource =
  | { kind: "pcm"; audio: PcmAudio }
  | { kind: "encoded"; bytes: ArrayBuffer; mime?: string };

export type ProviderKind = "local" | "streaming" | "demo";

/**
 * One music source. Each provider holds its own login, so any number can be connected at
 * once and each appears as its own crate.
 */
export interface MusicProvider {
  readonly id: string;
  readonly name: string;
  readonly kind: ProviderKind;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  listTracks(): Promise<TrackRef[]>;
  search(text: string): Promise<TrackRef[]>;
  fetchAudio(track: TrackRef): Promise<AudioSource>;
}

export class ProviderError extends Error {
  constructor(
    readonly providerId: string,
    readonly reason: "partner-access-required" | "auth-failed" | "network" | "not-found",
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type AnalysisStatus = "queued" | "analyzing" | "ready" | "error";

export interface TrackMeta {
  status: AnalysisStatus;
  summary?: TrackSummary;
  error?: string;
}

export interface MetadataCache {
  get(trackId: string): TrackSummary | undefined;
  set(trackId: string, summary: TrackSummary): void;
}

export class MemoryMetadataCache implements MetadataCache {
  private readonly map = new Map<string, TrackSummary>();
  get(id: string) { return this.map.get(id); }
  set(id: string, s: TrackSummary) { this.map.set(id, s); }
}
