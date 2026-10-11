import "./styles.css";
import { summarize } from "../engine/analyzer";
import { AnalysisClient, decodeSource } from "../engine/analysisClient";
import { LibrarySession } from "../library/session";
import { DEMO_CATALOGS, DemoStreamingProvider } from "../library/providers/demo";
import { LocalFilesProvider } from "../library/providers/local";
import { PARTNER_SERVICES, PartnerStreamingProvider } from "../library/providers/partner";
import type { MetadataCache } from "../library/types";
import type { TrackSummary } from "../engine/analyzer";
import { DeckController } from "./deckController";
import { h, storage } from "./dom";
import { LibraryView } from "./libraryView";

const SUMMARY_KEY = "deckforge:summaries:v1";

class LocalStorageCache implements MetadataCache {
  private readonly data = storage.get<Record<string, TrackSummary>>(SUMMARY_KEY) ?? {};
  get(id: string) { return this.data[id]; }
  set(id: string, s: TrackSummary) { this.data[id] = s; storage.set(SUMMARY_KEY, this.data); }
}

const ctx = new AudioContext({ latencyHint: "interactive" });
const analysis = new AnalysisClient();

const session = new LibrarySession(
  async (_track, source) => {
    const { pcm } = source.kind === "pcm" ? { pcm: source.audio } : await decodeSource(ctx, source);
    return summarize(await analysis.analyze(pcm, { mode: "flexible", waveform: false }));
  },
  new LocalStorageCache(),
  2,
);

const local = new LocalFilesProvider();
session.register(local);
for (const c of DEMO_CATALOGS) session.register(new DemoStreamingProvider(c.id, c.name, c.tracks, { latencyMs: 150 }));
for (const info of PARTNER_SERVICES) session.register(new PartnerStreamingProvider(info));
void session.connect("local");

// Mixer: deck → channel fader → crossfader → master.
const master = ctx.createGain();
master.connect(ctx.destination);
const deckA = new DeckController("A", ctx, session, analysis);
const deckB = new DeckController("B", ctx, session, analysis);
deckA.partner = deckB;
deckB.partner = deckA;
const xfA = ctx.createGain();
const xfB = ctx.createGain();
deckA.player.output.connect(xfA).connect(master);
deckB.player.output.connect(xfB).connect(master);

const crossfader = h("input.crossfader", { type: "range", min: 0, max: 1, step: 0.001, value: 0.5, "aria-label": "Crossfader" }) as HTMLInputElement;
const applyCrossfader = () => {
  const x = Number(crossfader.value);
  // Equal-power curve: no volume dip in the middle of a blend.
  xfA.gain.value = Math.cos((x * Math.PI) / 2);
  xfB.gain.value = Math.sin((x * Math.PI) / 2);
};
crossfader.oninput = applyCrossfader;
crossfader.ondblclick = () => { crossfader.value = "0.5"; applyCrossfader(); };
applyCrossfader();

const addFiles = async (files: FileList) => {
  local.addFiles(Array.from(files));
  await session.refresh("local");
};

const library = new LibraryView(session, (track, deck) => void (deck === "A" ? deckA : deckB).load(track), (f) => void addFiles(f));

document.getElementById("app")!.replaceChildren(
  h("header.topbar", {},
    h("div.brand", {}, "DeckForge"),
    h("div.mixer", {}, h("span", {}, "A"), crossfader, h("span", {}, "B")),
    h("div.hint", {}, "Space: play A · Shift-click pad: clear"),
  ),
  h("main.decks", {}, deckA.root, deckB.root),
  library.root,
);

window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files.length) void addFiles(e.dataTransfer.files);
});
window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).matches("input, textarea")) return;
  if (e.code === "Space") { e.preventDefault(); deckA.togglePlay(); }
});

const loop = () => {
  deckA.tick();
  deckB.tick();
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);

// Exposed for the end-to-end smoke test.
Object.assign(window, { __deckforge: { session, deckA, deckB, ctx } });
