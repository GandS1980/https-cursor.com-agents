import { describe, expect, it } from "vitest";
import { analyzeTrack, summarize } from "../src/engine/analyzer";
import { LibrarySession, type SummaryAnalyzer } from "../src/library/session";
import { DemoStreamingProvider, type DemoTrackSpec } from "../src/library/providers/demo";
import { PARTNER_SERVICES, PartnerStreamingProvider, type StreamingBackend } from "../src/library/providers/partner";
import { LocalFilesProvider, parseFileName } from "../src/library/providers/local";
import { parseQuery } from "../src/library/query";
import type { TrackRef } from "../src/library/types";

const analyzePcm: SummaryAnalyzer = async (_t, source) => {
  if (source.kind !== "pcm") throw new Error("test analyzer handles PCM only");
  return summarize(analyzeTrack(source.audio, { mode: "flexible", waveform: false }));
};

const short = (id: string, title: string, bpm: number, tonic: number, mode: "major" | "minor", genre = "House"): DemoTrackSpec =>
  ({ id, title, artist: "Test Artist", genre, synth: { durationSec: 25, bpmAt: () => bpm, tonic, mode, seed: bpm } });

function makeSession() {
  const session = new LibrarySession(analyzePcm);
  const a = new DemoStreamingProvider("svc-a", "Service A", [short("one", "Night Drive", 124, 9, "minor"), short("two", "Day Off", 100, 0, "major", "Hip Hop")], { sampleRate: 22_050 });
  const b = new DemoStreamingProvider("svc-b", "Service B", [short("three", "Night Shift", 128, 4, "minor", "Techno")], { sampleRate: 22_050, latencyMs: 5 });
  session.register(a);
  session.register(b);
  return { session, a, b };
}

describe("simultaneous logins", () => {
  it("keeps every connected service as its own crate", async () => {
    const { session } = makeSession();
    await Promise.all([session.connect("svc-a"), session.connect("svc-b")]);
    expect(session.crates().map((c) => [c.name, c.trackIds.length])).toEqual([["Service A", 2], ["Service B", 1]]);
    expect(session.providerStates().every((s) => s.status === "connected")).toBe(true);
  });

  it("isolates a failed login from the other services", async () => {
    const session = new LibrarySession(analyzePcm);
    session.register(new DemoStreamingProvider("ok", "OK", [short("x", "X", 120, 0, "major")], { sampleRate: 22_050 }));
    session.register(new DemoStreamingProvider("bad", "Bad", [], { failLogin: true }));
    await session.connect("bad");
    await session.connect("ok");
    const states = Object.fromEntries(session.providerStates().map((s) => [s.provider.id, s.status]));
    expect(states).toEqual({ ok: "connected", bad: "error" });
    expect(session.crates()).toHaveLength(1);
  });

  it("drops a crate on logout without touching the others", async () => {
    const { session } = makeSession();
    await session.connect("svc-a");
    await session.connect("svc-b");
    await session.disconnect("svc-a");
    expect(session.crates().map((c) => c.name)).toEqual(["Service B"]);
  });
});

describe("pre-analysis", () => {
  it("shows BPM and key for every crate track before anything is loaded", async () => {
    const { session } = makeSession();
    const seen: string[] = [];
    session.on((e) => { if (e.type === "meta") seen.push(`${e.trackId}:${e.meta.status}`); });
    await session.connect("svc-a");
    await session.connect("svc-b");
    await session.whenIdle();
    expect(session.metaFor("svc-a:one")?.summary).toMatchObject({ bpm: 124, key: "Am", camelot: "8A" });
    expect(session.metaFor("svc-a:two")?.summary).toMatchObject({ bpm: 100, key: "C", camelot: "8B" });
    expect(session.metaFor("svc-b:three")?.summary).toMatchObject({ bpm: 128, key: "Em", camelot: "9A" });
    expect(seen).toContain("svc-a:one:queued");
    expect(seen).toContain("svc-a:one:analyzing");
    expect(seen).toContain("svc-a:one:ready");
  });

  it("does not re-analyse cached tracks after reconnecting", async () => {
    let calls = 0;
    const session = new LibrarySession(async (t, s) => { calls++; return analyzePcm(t, s); });
    session.register(new DemoStreamingProvider("p", "P", [short("x", "X", 120, 0, "major")], { sampleRate: 22_050 }));
    await session.connect("p");
    await session.whenIdle();
    await session.disconnect("p");
    await session.connect("p");
    await session.whenIdle();
    expect(calls).toBe(1);
  });

  it("records analysis failures per track", async () => {
    const session = new LibrarySession(async () => { throw new Error("decoder exploded"); });
    session.register(new DemoStreamingProvider("p", "P", [short("x", "X", 120, 0, "major")], { sampleRate: 22_050 }));
    await session.connect("p");
    await session.whenIdle();
    expect(session.metaFor("p:x")).toEqual({ status: "error", error: "decoder exploded" });
  });
});

describe("searchable crates", () => {
  it("parses text, bpm and key filters", () => {
    expect(parseQuery("night bpm:120-126 key:~8A")).toEqual({
      words: ["night"], bpm: { min: 120, max: 126 }, keys: ["8A", "7A", "9A", "8B"], keyRaw: "8A",
    });
    expect(parseQuery("bpm:128").bpm).toEqual({ min: 127.5, max: 128.5 });
    expect(parseQuery("key:Am").keys).toEqual(["Am"]);
  });

  it("searches inside one crate by text, tempo and key", async () => {
    const { session } = makeSession();
    await session.connect("svc-a");
    await session.whenIdle();
    const titles = (q: string) => session.searchCrate("provider:svc-a", q).map((t) => t.title);
    expect(titles("night")).toEqual(["Night Drive"]);
    expect(titles("bpm:95-105")).toEqual(["Day Off"]);
    expect(titles("key:8A")).toEqual(["Night Drive"]);
    expect(titles("key:~9A")).toEqual(["Night Drive"]); // 8A is compatible with 9A
    expect(titles("hip hop")).toEqual(["Day Off"]);
  });

  it("searches across all connected services at once and tolerates one failing", async () => {
    const { session } = makeSession();
    const flaky: StreamingBackend = {
      authenticate: async () => {},
      catalog: async () => [],
      search: async () => { throw new Error("503 from upstream"); },
      stream: async () => { throw new Error("unused"); },
      signOut: async () => {},
    };
    session.register(new PartnerStreamingProvider({ id: "flaky", name: "Flaky", requirement: "" }, flaky));
    await Promise.all([session.connect("svc-a"), session.connect("svc-b"), session.connect("flaky")]);
    await session.whenIdle();
    const { results, failures } = await session.searchAll("night");
    expect(results.map((r: TrackRef) => r.title).sort()).toEqual(["Night Drive", "Night Shift"]);
    expect(failures).toEqual([{ providerId: "flaky", error: "503 from upstream" }]);
    const fast = await session.searchAll("night bpm:126-130");
    expect(fast.results.map((r) => r.title)).toEqual(["Night Shift"]);
  });

  it("supports user crates mixing tracks from different services", async () => {
    const { session } = makeSession();
    await Promise.all([session.connect("svc-a"), session.connect("svc-b")]);
    const crate = session.createCrate("Peak time");
    session.addToCrate(crate.id, "svc-a:one");
    session.addToCrate(crate.id, "svc-b:three");
    session.addToCrate(crate.id, "svc-b:three");
    expect(session.searchCrate(crate.id, "").map((t) => t.providerId)).toEqual(["svc-a", "svc-b"]);
  });
});

describe("real streaming services", () => {
  it("explain the partner agreement they need instead of pretending to connect", async () => {
    const session = new LibrarySession(analyzePcm);
    for (const info of PARTNER_SERVICES) session.register(new PartnerStreamingProvider(info));
    for (const info of PARTNER_SERVICES) await session.connect(info.id);
    for (const s of session.providerStates()) {
      expect(s.status).toBe("error");
      expect(s.error).toMatch(/partner/i);
    }
    expect(PARTNER_SERVICES.map((s) => s.name)).toEqual(["TIDAL", "Spotify", "SoundCloud Go+", "Beatport Streaming"]);
  });
});

describe("local files", () => {
  it("parses artist and title from file names", () => {
    expect(parseFileName("Daft Punk - Around the World.mp3")).toEqual({ artist: "Daft Punk", title: "Around the World" });
    expect(parseFileName("untitled_mix.wav")).toEqual({ artist: "Unknown artist", title: "untitled_mix" });
  });

  it("adds dropped files to the Local crate on refresh", async () => {
    const local = new LocalFilesProvider();
    const session = new LibrarySession(async () => ({ bpm: 120, key: "C", camelot: "8B", duration: 1, variableTempo: false }));
    session.register(local);
    await session.connect("local");
    local.addFiles([{ name: "A - B.wav", arrayBuffer: async () => new ArrayBuffer(8) }]);
    await session.refresh("local");
    await session.whenIdle();
    const [crate] = session.crates();
    expect(crate.trackIds).toHaveLength(1);
    expect(session.metaFor(crate.trackIds[0])?.summary?.bpm).toBe(120);
  });
});
