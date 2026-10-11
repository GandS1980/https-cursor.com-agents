import { ProviderError, type AudioSource, type MusicProvider, type ProviderKind, type TrackRef } from "../types";

/**
 * What a real streaming integration needs. DJ-licensed streaming is not available through
 * public consumer APIs: each service grants DJ playback (mixing, tempo change, caching) only
 * under a commercial partner agreement with the DJ-software vendor.
 */
export interface StreamingBackend {
  authenticate(): Promise<void>;
  catalog(): Promise<TrackRef[]>;
  search(text: string): Promise<TrackRef[]>;
  /** Licensed, DJ-permitted audio for one track. */
  stream(track: TrackRef): Promise<AudioSource>;
  signOut(): Promise<void>;
}

export interface PartnerServiceInfo {
  id: string;
  name: string;
  /** What has to be obtained before this adapter can be enabled. */
  requirement: string;
}

export const PARTNER_SERVICES: PartnerServiceInfo[] = [
  { id: "tidal", name: "TIDAL", requirement: "TIDAL DJ partner agreement (DJ Extension streaming rights)" },
  { id: "spotify", name: "Spotify", requirement: "Spotify DJ partner agreement — the public Web API terms prohibit mixing and tempo-changing streams" },
  { id: "soundcloud", name: "SoundCloud Go+", requirement: "SoundCloud DJ partner API access" },
  { id: "beatport", name: "Beatport Streaming", requirement: "Beatport/Beatsource streaming partner API access" },
];

/**
 * Adapter slot for a licensed service. Without a backend it reports exactly what is missing;
 * with one (supplied once a partnership exists) it is a normal provider.
 */
export class PartnerStreamingProvider implements MusicProvider {
  readonly kind: ProviderKind = "streaming";
  readonly id: string;
  readonly name: string;
  private connected = false;

  constructor(private readonly info: PartnerServiceInfo, private readonly backend?: StreamingBackend) {
    this.id = info.id;
    this.name = info.name;
  }

  async connect(): Promise<void> {
    if (!this.backend) {
      throw new ProviderError(this.id, "partner-access-required", `${this.name} needs ${this.info.requirement}.`);
    }
    await this.backend.authenticate();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.backend && this.connected) await this.backend.signOut();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  listTracks(): Promise<TrackRef[]> {
    return this.live().catalog();
  }

  search(text: string): Promise<TrackRef[]> {
    return this.live().search(text);
  }

  fetchAudio(track: TrackRef): Promise<AudioSource> {
    return this.live().stream(track);
  }

  private live(): StreamingBackend {
    if (!this.backend || !this.connected) throw new ProviderError(this.id, "auth-failed", `${this.name}: not logged in`);
    return this.backend;
  }
}
