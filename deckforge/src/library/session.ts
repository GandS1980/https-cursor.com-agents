import type { TrackSummary } from "../engine/analyzer";
import { matchesMeta, matchesText, parseQuery } from "./query";
import {
  MemoryMetadataCache,
  ProviderError,
  type AudioSource,
  type MetadataCache,
  type MusicProvider,
  type TrackMeta,
  type TrackRef,
} from "./types";

export interface Crate {
  id: string;
  name: string;
  /** Set for the automatic crate of a connected service. */
  providerId?: string;
  trackIds: string[];
}

export type SummaryAnalyzer = (track: TrackRef, source: AudioSource) => Promise<TrackSummary>;

export interface ProviderState {
  provider: MusicProvider;
  status: "disconnected" | "connecting" | "connected" | "error";
  error?: string;
}

type Listener = (event: { type: "providers" } | { type: "crates" } | { type: "meta"; trackId: string; meta: TrackMeta }) => void;

/**
 * The library a DJ works from in one session: any number of simultaneously logged-in
 * providers, each surfacing as its own searchable crate, plus user crates — with a
 * background queue that pre-analyses BPM and key so they are visible before loading.
 */
export class LibrarySession {
  private readonly providers = new Map<string, ProviderState>();
  private readonly tracks = new Map<string, TrackRef>();
  private readonly userCrates = new Map<string, Crate>();
  private readonly providerCrates = new Map<string, Crate>();
  private readonly meta = new Map<string, TrackMeta>();
  private readonly queue: TrackRef[] = [];
  private readonly listeners = new Set<Listener>();
  private running = 0;
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly analyze: SummaryAnalyzer,
    private readonly cache: MetadataCache = new MemoryMetadataCache(),
    private readonly concurrency = 1,
  ) {}

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: Parameters<Listener>[0]): void {
    for (const l of this.listeners) l(e);
  }

  register(provider: MusicProvider): void {
    this.providers.set(provider.id, { provider, status: provider.isConnected() ? "connected" : "disconnected" });
    this.emit({ type: "providers" });
  }

  providerStates(): ProviderState[] {
    return [...this.providers.values()];
  }

  /**
   * Log in to one provider. Other providers' sessions are untouched, and a failure here only
   * marks this provider as errored.
   */
  async connect(providerId: string): Promise<void> {
    const state = this.requireProvider(providerId);
    state.status = "connecting";
    state.error = undefined;
    this.emit({ type: "providers" });
    try {
      await state.provider.connect();
      state.status = "connected";
      await this.refresh(providerId);
    } catch (err) {
      state.status = "error";
      state.error = err instanceof Error ? err.message : String(err);
      if (!(err instanceof ProviderError)) throw err;
    } finally {
      this.emit({ type: "providers" });
    }
  }

  /** Re-read a connected provider's catalog (e.g. after local files were added). */
  async refresh(providerId: string): Promise<void> {
    const state = this.requireProvider(providerId);
    const list = await state.provider.listTracks();
    for (const t of list) this.tracks.set(t.id, t);
    this.providerCrates.set(providerId, {
      id: `provider:${providerId}`,
      name: state.provider.name,
      providerId,
      trackIds: list.map((t) => t.id),
    });
    this.emit({ type: "crates" });
    this.preAnalyze(list);
  }

  async disconnect(providerId: string): Promise<void> {
    const state = this.requireProvider(providerId);
    await state.provider.disconnect();
    state.status = "disconnected";
    this.providerCrates.delete(providerId);
    // Drop queued work for this provider; finished summaries stay cached.
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i].providerId === providerId) this.queue.splice(i, 1);
    this.emit({ type: "providers" });
    this.emit({ type: "crates" });
  }

  crates(): Crate[] {
    return [...this.providerCrates.values(), ...this.userCrates.values()];
  }

  createCrate(name: string): Crate {
    const crate: Crate = { id: `crate:${crypto.randomUUID()}`, name, trackIds: [] };
    this.userCrates.set(crate.id, crate);
    this.emit({ type: "crates" });
    return crate;
  }

  addToCrate(crateId: string, trackId: string): void {
    const crate = this.userCrates.get(crateId);
    if (!crate) throw new Error(`Unknown user crate ${crateId}`);
    if (!crate.trackIds.includes(trackId)) crate.trackIds.push(trackId);
    this.emit({ type: "crates" });
  }

  track(id: string): TrackRef | undefined {
    return this.tracks.get(id);
  }

  metaFor(trackId: string): TrackMeta | undefined {
    const m = this.meta.get(trackId);
    if (m) return m;
    const cached = this.cache.get(trackId);
    return cached ? { status: "ready", summary: cached } : undefined;
  }

  /** Search one crate (text, `bpm:`, `key:` filters) entirely locally. */
  searchCrate(crateId: string, q: string): TrackRef[] {
    const crate = this.crates().find((c) => c.id === crateId);
    if (!crate) return [];
    const parsed = parseQuery(q);
    return crate.trackIds
      .map((id) => this.tracks.get(id))
      .filter((t): t is TrackRef => !!t && matchesText(t, parsed.words) && matchesMeta(this.metaFor(t.id)?.summary, parsed));
  }

  /**
   * Search every connected provider at once. Remote catalogs are queried with the free text;
   * tempo/key filters apply to pre-analysed summaries. A failing service is reported, not fatal.
   */
  async searchAll(q: string): Promise<{ results: TrackRef[]; failures: { providerId: string; error: string }[] }> {
    const parsed = parseQuery(q);
    const connected = this.providerStates().filter((s) => s.status === "connected");
    const settled = await Promise.allSettled(connected.map((s) => s.provider.search(parsed.words.join(" "))));
    const results: TrackRef[] = [];
    const failures: { providerId: string; error: string }[] = [];
    settled.forEach((r, i) => {
      if (r.status === "rejected") {
        failures.push({ providerId: connected[i].provider.id, error: String(r.reason?.message ?? r.reason) });
        return;
      }
      for (const t of r.value) {
        this.tracks.set(t.id, t);
        if (matchesText(t, parsed.words) && matchesMeta(this.metaFor(t.id)?.summary, parsed)) results.push(t);
      }
    });
    this.preAnalyze(results);
    return { results, failures };
  }

  async fetchAudio(trackId: string): Promise<AudioSource> {
    const track = this.tracks.get(trackId);
    if (!track) throw new Error(`Unknown track ${trackId}`);
    return this.requireProvider(track.providerId).provider.fetchAudio(track);
  }

  /** Queue tracks for background BPM/key analysis; cached tracks are skipped. */
  preAnalyze(tracks: TrackRef[]): void {
    for (const t of tracks) {
      if (this.cache.get(t.id) || this.meta.has(t.id)) continue;
      this.setMeta(t.id, { status: "queued" });
      this.queue.push(t);
    }
    this.pump();
  }

  /** Resolves once the pre-analysis queue is drained. */
  whenIdle(): Promise<void> {
    if (this.running === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  /** Record a full analysis performed at load time (keeps crates in sync with decks). */
  recordSummary(trackId: string, summary: TrackSummary): void {
    this.cache.set(trackId, summary);
    this.setMeta(trackId, { status: "ready", summary });
  }

  private setMeta(trackId: string, meta: TrackMeta): void {
    this.meta.set(trackId, meta);
    this.emit({ type: "meta", trackId, meta });
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const track = this.queue.shift()!;
      this.running++;
      this.setMeta(track.id, { status: "analyzing" });
      void (async () => {
        try {
          const source = await this.requireProvider(track.providerId).provider.fetchAudio(track);
          const summary = await this.analyze(track, source);
          this.recordSummary(track.id, summary);
        } catch (err) {
          this.setMeta(track.id, { status: "error", error: err instanceof Error ? err.message : String(err) });
        } finally {
          this.running--;
          this.pump();
          if (this.running === 0 && this.queue.length === 0) {
            const waiters = this.idleWaiters.splice(0);
            for (const w of waiters) w();
          }
        }
      })();
    }
  }

  private requireProvider(id: string): ProviderState {
    const s = this.providers.get(id);
    if (!s) throw new Error(`Unknown provider ${id}`);
    return s;
  }
}
