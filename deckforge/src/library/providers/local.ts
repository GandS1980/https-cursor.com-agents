import type { AudioSource, MusicProvider, ProviderKind, TrackRef } from "../types";

/** Anything with a name and bytes: a browser `File`, or a test double. */
export interface FileLike {
  name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  type?: string;
}

/** "Artist - Title.mp3" → { artist, title }; otherwise the bare file name is the title. */
export function parseFileName(name: string): { artist: string; title: string } {
  const base = name.replace(/\.[^.]+$/, "");
  const m = /^(.+?)\s+[-–]\s+(.+)$/.exec(base);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: "Unknown artist", title: base };
}

/** Audio files the user drops in or picks from disk. Always "logged in". */
export class LocalFilesProvider implements MusicProvider {
  readonly id = "local";
  readonly name = "Local files";
  readonly kind: ProviderKind = "local";
  private readonly files = new Map<string, FileLike>();
  private readonly refs: TrackRef[] = [];
  private counter = 0;

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return true; }

  addFiles(files: Iterable<FileLike>): TrackRef[] {
    const added: TrackRef[] = [];
    for (const f of files) {
      const id = `${this.id}:${++this.counter}-${f.name}`;
      const ref: TrackRef = { id, providerId: this.id, ...parseFileName(f.name) };
      this.files.set(id, f);
      this.refs.push(ref);
      added.push(ref);
    }
    return added;
  }

  async listTracks(): Promise<TrackRef[]> {
    return [...this.refs];
  }

  async search(text: string): Promise<TrackRef[]> {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    return this.refs.filter((r) => words.every((w) => `${r.title} ${r.artist}`.toLowerCase().includes(w)));
  }

  async fetchAudio(track: TrackRef): Promise<AudioSource> {
    const f = this.files.get(track.id);
    if (!f) throw new Error(`File for ${track.id} is no longer available`);
    return { kind: "encoded", bytes: await f.arrayBuffer(), mime: f.type };
  }
}
