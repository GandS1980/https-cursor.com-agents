# DeckForge

Two-deck browser DJ software built around three features:

| Feature | What it does | Where |
|---|---|---|
| **Dynamic beatgrids** | Onset detection → tempo estimate → dynamic-programming beat tracking. **Flexible** mode keeps every detected beat and splits the track into tempo segments (live drummers, disco, funk). **Fixed** mode fits one straight grid with integer-BPM snapping (sequenced electronic music). Downbeats come from low-frequency energy. BPM labels are drawn along the scrolling waveform, with a highlighted label wherever the tempo changes. | `src/engine/` |
| **Multi-service crates + pre-analysis** | Any number of services logged in at once; each is its own crate. Search inside one crate or across all of them (`bpm:120-128`, `key:8A`, `key:~8A` for harmonically compatible keys). A background worker pool fills in BPM, key and Camelot code for every crate track before it's loaded. | `src/library/` |
| **Cue loops** | In *Cue Loop* pad mode, pressing an empty pad saves the active loop to it (or captures a 4-beat loop if none is running). Pressing a filled pad jumps to the loop and engages it. Loops are measured in *detected* beats, so they stay on the music across tempo drift. | `src/deck/deckModel.ts` |

Also included: hot cues, auto and manual loops (½/×2, in/out, reloop), pitch fader, tempo+phase sync, an equal-power crossfader, drag-and-drop local files, cue points saved per track, and a CLI analyzer for WAV files.

## Run it

```bash
npm install
npm run dev            # http://localhost:5173
npm test               # 61 unit tests: analysis accuracy vs. synthetic ground truth, deck, library, WAV
npm run build && npm run test:e2e   # 14 checks in headless Chromium against the production build
npm run analyze -- --export-demo ./demo-wavs           # write the demo catalog to WAV
npm run analyze -- [--fixed] [--json] track.wav ...    # tempo map, key, beats
```

For the e2e test, set `CHROMIUM_PATH` if Chromium is not at `/opt/pw-browsers/chromium`.

## Measured accuracy (synthetic tracks with exact ground truth)

| Material | Mode | Result |
|---|---|---|
| Constant 92 / 124 / 128 / 140.5 / 174 BPM | Fixed | Exact BPM, beat error ≤ 1.5 ms, 100% downbeats |
| 120 → 126 BPM step at 45 s | Flexible | Segments `[120, 126]`, change found within ±1.5 s, p95 beat error < 8 ms |
| 110 → 120 BPM ramp, ±8 ms human timing | Flexible | p95 beat error < 25 ms (fixed grid drifts > 40 ms median, as it should) |
| 8 keys, major and minor | — | 8/8 correct |

Analysis takes about 1–1.5 s per 2.5-minute track in a worker. Synthetic audio is cleaner than real recordings, so expect lower numbers on real music; run `npm run analyze` on your own WAVs to check.

## Limits

- **Streaming.** TIDAL, Spotify, SoundCloud Go+ and Beatport adapters exist (`src/library/providers/partner.ts`). Without a partner agreement, each one reports that requirement instead of connecting. DJ streaming rights are only available through those agreements, not public APIs. With access, you implement `StreamingBackend` (auth, catalog, search, stream) and the rest of the app works unchanged. Until then, two simulated services exercise the same code paths.
- **No keylock.** Pitch changes speed and pitch together. Time-stretching needs a phase vocoder or WSOLA in an AudioWorklet.
- **Formats.** In the app, anything the browser can decode. In the CLI, WAV only (PCM and float).
- No MIDI controllers, recording, effects or EQ yet.
