import type { TrackSummary } from "../engine/analyzer";
import { compatibleCamelot } from "../engine/key";
import type { TrackRef } from "./types";

/**
 * Crate search syntax:
 *   free text            title/artist/genre substring (all words must match)
 *   bpm:120-128          tempo range (inclusive);  bpm:128 → 127.5–128.5
 *   key:8A | key:Am      exact key (Camelot or name)
 *   key:~8A              harmonically compatible (same, ±1, relative major/minor)
 */
export interface ParsedQuery {
  words: string[];
  bpm?: { min: number; max: number };
  keys?: string[];
  keyRaw?: string;
}

export function parseQuery(q: string): ParsedQuery {
  const parsed: ParsedQuery = { words: [] };
  for (const token of q.trim().split(/\s+/).filter(Boolean)) {
    const bpm = /^bpm:(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?$/i.exec(token);
    if (bpm) {
      const a = Number(bpm[1]);
      const b = bpm[2] !== undefined ? Number(bpm[2]) : undefined;
      parsed.bpm = b === undefined ? { min: a - 0.5, max: a + 0.5 } : { min: Math.min(a, b), max: Math.max(a, b) };
      continue;
    }
    const key = /^key:(~?)(.+)$/i.exec(token);
    if (key) {
      const value = key[2];
      parsed.keyRaw = value;
      const isCamelot = /^\d{1,2}[ab]$/i.test(value);
      parsed.keys = key[1] && isCamelot ? compatibleCamelot(value.toUpperCase()) : [isCamelot ? value.toUpperCase() : value];
      continue;
    }
    parsed.words.push(token.toLowerCase());
  }
  return parsed;
}

export function matchesText(track: TrackRef, words: string[]): boolean {
  const hay = `${track.title} ${track.artist} ${track.genre ?? ""}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Tempo/key filters need pre-analysis; tracks without a summary yet do not match them. */
export function matchesMeta(summary: TrackSummary | undefined, q: ParsedQuery): boolean {
  if (!q.bpm && !q.keys) return true;
  if (!summary) return false;
  if (q.bpm && (summary.bpm < q.bpm.min || summary.bpm > q.bpm.max)) return false;
  if (q.keys && !q.keys.some((k) => k === summary.camelot || k.toLowerCase() === summary.key.toLowerCase())) return false;
  return true;
}
