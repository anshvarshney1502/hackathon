import { type Line, type SocialSignals } from "./signals";
import type { EventResult } from "./types";

/**
 * Round memory for the bots, extracted with plain rules (no LLM): what people said about
 * themselves, who accused or vouched for whom, and what the room's events showed.
 * It keeps bots consistent ("wait you're from Jaipur right?") and reactive to real humans.
 */
const DISCLOSURE =
  /\b(i'?m from|i live in|i grew up in|i moved to|i work (at|as|in|for)|i'?m an? \w+|i study|i studied|my (job|dog|cat|mom|dad|brother|sister|wife|husband|gf|bf|boss|roommate)|i (love|hate|can'?t stand|never|always))\b/i;

export interface RoundMemory {
  /** Other players' self-disclosures, latest first. */
  facts: string[];
  /** This bot's own earlier claims, so it stays consistent. */
  own: string[];
  /** Accusations, vouches and event outcomes, in plain words. */
  dynamics: string[];
}

const clip = (t: string, n = 80) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

export function roundMemory(
  selfUid: string,
  lines: Line[],
  sig: SocialSignals,
  names: Map<string, string>,
  events: EventResult[] = [],
  limit = 8,
): RoundMemory {
  const facts: string[] = [];
  const own: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!DISCLOSURE.test(l.text)) continue;
    if (l.uid === selfUid) {
      if (own.length < 3) own.push(clip(l.text));
    } else if (facts.length < limit) {
      facts.push(`${l.name}: "${clip(l.text)}"`);
    }
  }
  const dynamics: string[] = [];
  const name = (uid: string) => names.get(uid) ?? "someone";
  for (const [from, row] of Object.entries(sig.accusations)) {
    for (const [to, n] of Object.entries(row)) {
      dynamics.push(`${from === selfUid ? "you" : name(from)} called ${to === selfUid ? "you" : name(to)} a bot${n > 1 ? ` (${n}×)` : ""}`);
    }
  }
  for (const [from, row] of Object.entries(sig.vouches)) {
    for (const to of Object.keys(row)) {
      dynamics.push(`${from === selfUid ? "you" : name(from)} vouched for ${to === selfUid ? "you" : name(to)}`);
    }
  }
  for (const [uid, n] of Object.entries(sig.selfClaims)) {
    dynamics.push(`${uid === selfUid ? "you" : name(uid)} claimed to be a bot${n > 1 ? ` (${n}×)` : ""}, joke or bluff?`);
  }
  for (const e of events) {
    const top = Object.entries(e.counts).sort((a, b) => b[1] - a[1])[0];
    if (top) dynamics.push(`the room ${e.type === "POINT" ? "pointed at" : "vouched for"} ${top[0] === selfUid ? "you" : name(top[0])} (${top[1]} picks)`);
  }
  return { facts: facts.reverse(), own: own.reverse(), dynamics: dynamics.slice(-limit) };
}
