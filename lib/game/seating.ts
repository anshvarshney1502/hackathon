import { pickBots, type PoolBot } from "@/lib/bots/assign";
import { MAX_HUMANS, MAX_PLAYERS } from "./types";
import { shuffled } from "./rng";

/**
 * Round aliases. Everybody (human or bot) is a stranger at the table: a fresh handle per round,
 * so friends can't map names to people and bot persona names never show in the UI.
 * Mixed styles on purpose: lowercase handles, first names, initials, the way people name themselves.
 */
export const ALIAS_POOL = [
  "kavya", "Rhea", "aditya_v", "Mo", "Neel", "tara", "Kunal S", "ishita", "Vik", "Ayaan",
  "sana", "Jay", "Mira", "rahul.k", "Anushka", "Omar", "pooja", "Dhruv", "Leah", "Karan",
  "nina", "Arnav", "Sia", "yash", "Tanmay", "zara", "Kabeer", "meher", "Ronit", "Alina",
  "dev.r", "Saanvi", "Imran", "keya", "Parth", "Noor", "aarav", "Esha", "Vivaan", "riddhi",
] as const;

/** One unique alias per seat. */
export function assignAliases(uids: string[], random: () => number): Record<string, string> {
  const names = shuffled(ALIAS_POOL, random);
  return Object.fromEntries(uids.map((uid, i) => [uid, names[i % names.length]]));
}

export interface Composition {
  /** Seat order for the round, shuffled so it carries no information. */
  roster: string[];
  /** Bots that must be added to the CometChat group. */
  newBots: PoolBot[];
  /** True when one human plays with bots (practice). Server-side knowledge only. */
  solo: boolean;
}

/**
 * Fill empty seats with bots when the round starts (never earlier), then shuffle every seat.
 * 2–5 humans → 4–1 bots; 1 human → a solo case with 5 bots. Never zero bots.
 */
export function composeTable(
  humans: { uid: string; name: string }[],
  pool: PoolBot[],
  random: () => number,
): Composition {
  // Never six humans: at least one seat always goes to an AI.
  const seated = humans.slice(0, MAX_HUMANS);
  const newBots = pickBots(pool, seated, MAX_PLAYERS - seated.length, random);
  const roster = shuffled([...seated.map((h) => h.uid), ...newBots.map((b) => b.uid)], random);
  return { roster, newBots, solo: seated.length === 1 };
}

/** Name to show for a seat: its round alias while a round runs, otherwise the account name. */
export function seatName(uid: string, aliases: Record<string, string>, fallback: string): string {
  return aliases[uid] ?? fallback;
}
