import { synthesize, type SynthSpec } from "../../engine/synth";
import { ProviderError, type AudioSource, type MusicProvider, type ProviderKind, type TrackRef } from "../types";

export interface DemoTrackSpec {
  id: string;
  title: string;
  artist: string;
  genre: string;
  synth: Omit<SynthSpec, "sampleRate" | "stereo">;
}

/**
 * A simulated streaming service backed by procedurally generated tracks. It behaves like a
 * real catalog (separate login, remote search latency) so multi-service crates, search and
 * pre-analysis can be exercised end-to-end without licensed music.
 */
export class DemoStreamingProvider implements MusicProvider {
  readonly kind: ProviderKind = "demo";
  private connected = false;
  private readonly rendered = new Map<string, AudioSource>();

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly catalog: DemoTrackSpec[],
    private readonly options: { latencyMs?: number; sampleRate?: number; failLogin?: boolean } = {},
  ) {}

  private delay(): Promise<void> {
    return new Promise((r) => setTimeout(r, this.options.latencyMs ?? 0));
  }

  async connect(): Promise<void> {
    await this.delay();
    if (this.options.failLogin) {
      throw new ProviderError(this.id, "auth-failed", `${this.name}: login rejected`);
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private ref(t: DemoTrackSpec): TrackRef {
    return {
      id: `${this.id}:${t.id}`,
      providerId: this.id,
      title: t.title,
      artist: t.artist,
      genre: t.genre,
      durationSec: t.synth.durationSec,
    };
  }

  async listTracks(): Promise<TrackRef[]> {
    this.requireLogin();
    return this.catalog.map((t) => this.ref(t));
  }

  async search(text: string): Promise<TrackRef[]> {
    this.requireLogin();
    await this.delay();
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    return this.catalog
      .filter((t) => words.every((w) => `${t.title} ${t.artist} ${t.genre}`.toLowerCase().includes(w)))
      .map((t) => this.ref(t));
  }

  async fetchAudio(track: TrackRef): Promise<AudioSource> {
    this.requireLogin();
    const cached = this.rendered.get(track.id);
    if (cached) return cached;
    const spec = this.catalog.find((t) => `${this.id}:${t.id}` === track.id);
    if (!spec) throw new Error(`Track ${track.id} not in ${this.name}`);
    const { audio } = synthesize({ ...spec.synth, sampleRate: this.options.sampleRate ?? 44_100, stereo: true });
    const source: AudioSource = { kind: "pcm", audio };
    this.rendered.set(track.id, source);
    // Keep only the most recent renders: a 150 s stereo track is ~26 MB of float PCM.
    while (this.rendered.size > 3) this.rendered.delete(this.rendered.keys().next().value!);
    return source;
  }

  private requireLogin(): void {
    if (!this.connected) throw new Error(`${this.name}: not logged in`);
  }
}

const A = 9, C = 0, D = 2, E = 4, F = 5, G = 7;

/** Two simulated services with tracks that exercise both grid modes. */
export const DEMO_CATALOGS: { id: string; name: string; tracks: DemoTrackSpec[] }[] = [
  {
    id: "demo-electronic",
    name: "Demo Stream · Electronic",
    tracks: [
      { id: "warehouse", title: "Warehouse Pressure", artist: "Gridlock", genre: "Techno",
        synth: { durationSec: 150, bpmAt: () => 128, tonic: A, mode: "minor", seed: 11 } },
      { id: "sunrise", title: "Sunrise Protocol", artist: "Low Orbit", genre: "House",
        synth: { durationSec: 140, bpmAt: () => 124, tonic: F, mode: "major", seed: 12 } },
      { id: "amen", title: "Amen Theory", artist: "Breakline", genre: "Drum & Bass",
        synth: { durationSec: 120, bpmAt: () => 174, tonic: D, mode: "minor", seed: 13 } },
      { id: "steps", title: "Tempo Steps (edit)", artist: "Gridlock", genre: "Techno",
        synth: { durationSec: 150, bpmAt: (t) => (t < 75 ? 126 : 130), tonic: G, mode: "minor", seed: 14 } },
    ],
  },
  {
    id: "demo-groove",
    name: "Demo Stream · Funk & Disco",
    tracks: [
      { id: "drift", title: "Live Room Drift", artist: "The Session Players", genre: "Funk",
        synth: { durationSec: 150, bpmAt: (t) => 104 + 8 * (t / 150), tonic: E, mode: "minor", humanizeMs: 9, groove: "backbeat", seed: 21 } },
      { id: "mirrorball", title: "Mirrorball Breathing", artist: "Studio 77", genre: "Disco",
        synth: { durationSec: 150, bpmAt: (t) => 118 + 2.5 * Math.sin((2 * Math.PI * t) / 75), tonic: C, mode: "major", humanizeMs: 6, groove: "backbeat", seed: 22 } },
      { id: "pocket", title: "In The Pocket", artist: "Northside Rhythm", genre: "Funk",
        synth: { durationSec: 120, bpmAt: () => 98, tonic: A, mode: "minor", humanizeMs: 4, groove: "backbeat", seed: 23 } },
    ],
  },
];
