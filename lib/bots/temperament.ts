import { seededRandom } from "@/lib/game/rng";
import { type SocialSignals } from "@/lib/game/signals";
import { affinity } from "@/lib/game/trust";
import type { Persona } from "./personas";

/**
 * Per-case behaviour, rolled fresh for every bot in every round. A persona supplies the *voice*
 * (vocabulary, typing style, Hinglish, opinions); the temperament supplies *behaviour* (how much they
 * talk, how fast, how combative, how trusting). The same voice behaves differently from case to case,
 * and no alias is ever tied to a personality. Server-side only.
 */
export interface Temperament {
  /** How much they talk (0..1). */
  talk: number;
  /** Starts conversations / questions people unprompted. */
  initiative: number;
  /** Accuses and pushes back. */
  aggression: number;
  /** Engages with *other players* (incl. bots) rather than just the topic. */
  sociability: number;
  /** Holds opinions under pressure vs folds. */
  confidence: number;
  /** Baseline suspicion of everyone. */
  suspicion: number;
  /** Disagrees for its own sake. */
  contrarian: number;
  /** Defends people they like. */
  loyalty: number;
  /** Typing / reply speed multiplier (higher = faster). */
  speed: number;
  /** Message length tendency. */
  verbosity: "terse" | "short" | "medium";
  /** One-line description for the prompt. */
  label: string;
}

type Dial = "aggression" | "sociability" | "confidence" | "contrarian" | "initiative" | "loyalty";
const LABELS: [Dial, string, string][] = [
  ["aggression", "picks fights, calls people out", "avoids conflict"],
  ["sociability", "talks to people directly, by name", "mostly reacts to the topic"],
  ["confidence", "sticks to their guns", "easily swayed, changes their mind"],
  ["contrarian", "disagrees just to stir things", "goes along with the room"],
  ["initiative", "starts new threads, asks questions", "waits to be spoken to"],
  ["loyalty", "defends people they like", "doesn't take sides"],
];

export function rollTemperament(seed: string, uid: string): Temperament {
  const r = seededRandom(`temper:${seed}:${uid}`);
  // Skewed draws so the five bots spread out instead of all landing near 0.5.
  const draw = () => {
    const x = r();
    return x < 0.5 ? x * x * 2 : 1 - (1 - x) * (1 - x) * 2;
  };
  const t = {
    talk: 0.25 + draw() * 0.75,
    initiative: draw(),
    aggression: draw(),
    sociability: draw(),
    confidence: draw(),
    suspicion: 0.15 + draw() * 0.8,
    contrarian: draw(),
    loyalty: draw(),
    speed: 0.7 + r() * 0.9,
    verbosity: (["terse", "short", "short", "medium"] as const)[Math.floor(r() * 4)],
  };
  const traits = LABELS.map(([k, hi, lo]) => (t[k] > 0.66 ? hi : t[k] < 0.33 ? lo : null)).filter(Boolean);
  return { ...t, label: traits.slice(0, 3).join("; ") || "even-keeled" };
}

/** The persona as it plays *this* case: same voice, this round's behaviour. */
export function applyTemperament(p: Persona, t: Temperament): Persona {
  return {
    ...p,
    talkativeness: t.talk,
    paranoia: t.suspicion,
    length: t.verbosity,
    typingCps: p.typingCps * t.speed,
    personality: `${p.personality}; this time: ${t.label}`,
  };
}

/**
 * A bot's private read on every other player. Independent per bot: the same chat yields different
 * conclusions because each bot weighs it through its own temperament plus a private hunch.
 */
export interface SocialView {
  trust: Record<string, number>;
  suspicion: Record<string, number>;
  mostTrusted: string | null;
  mostSuspected: string | null;
}

export function socialView(
  self: string,
  roster: string[],
  sig: SocialSignals,
  t: Temperament,
  seed: string,
): SocialView {
  const trust: Record<string, number> = {};
  const suspicion: Record<string, number> = {};
  for (const other of roster) {
    if (other === self) continue;
    // A stable private hunch per (bot, target): different bots suspect different people.
    const hunch = seededRandom(`hunch:${seed}:${self}:${other}`)() - 0.5;
    const a = affinity(self, other, sig, t.suspicion);
    const accusedMe = sig.accusations[other]?.[self] ?? 0;
    trust[other] = a * (0.6 + t.loyalty * 0.6) + hunch * 1.5;
    suspicion[other] =
      t.suspicion * 2 - a * 0.5 + hunch * (1 + t.contrarian * 1.5) + accusedMe * t.aggression * 2 + (sig.selfClaims[other] ?? 0) * 0.5;
  }
  const top = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { trust, suspicion, mostTrusted: top(trust), mostSuspected: top(suspicion) };
}

/** Most-trusted and least-trusted from this bot's own view (always two different people). */
export function trustFromView(v: SocialView): { most: string; least: string } | null {
  const trustRank = Object.entries(v.trust).sort((a, b) => b[1] - a[1]).map(([u]) => u);
  const suspRank = Object.entries(v.suspicion).sort((a, b) => b[1] - a[1]).map(([u]) => u);
  const most = trustRank[0];
  const least = suspRank.find((u) => u !== most);
  return most && least ? { most, least } : null;
}

/**
 * Verdicts from this bot's private suspicion, relative to its own average, so even a paranoid bot
 * calls some players human. Each bot judges alone: no shared consensus.
 */
export function ballotsFromView(v: SocialView, random: () => number): Record<string, "HUMAN" | "BOT"> {
  const vals = Object.values(v.suspicion);
  const mean = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
  const out: Record<string, "HUMAN" | "BOT"> = {};
  for (const [uid, s] of Object.entries(v.suspicion)) {
    const p = 1 / (1 + Math.exp(-(s - mean) * 1.6));
    out[uid] = random() < Math.min(0.9, Math.max(0.1, p)) ? "BOT" : "HUMAN";
  }
  return out;
}
