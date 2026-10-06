import { type SocialSignals } from "./signals";

export interface TrustPick {
  most: string;
  least: string;
}
/** voterUid → their latest valid pick. */
export type TrustBox = Record<string, TrustPick>;

/** Drop self-picks, unknown players and identical most/least picks. */
export function sanitizeTrust(box: TrustBox, roster: string[]): TrustBox {
  const seated = new Set(roster);
  const out: TrustBox = {};
  for (const [voter, t] of Object.entries(box)) {
    if (!seated.has(voter) || !seated.has(t.most) || !seated.has(t.least)) continue;
    if (t.most === voter || t.least === voter || t.most === t.least) continue;
    out[voter] = t;
  }
  return out;
}

export function tallyTrust(box: TrustBox): { most: Record<string, number>; least: Record<string, number> } {
  const most: Record<string, number> = {};
  const least: Record<string, number> = {};
  for (const t of Object.values(box)) {
    most[t.most] = (most[t.most] ?? 0) + 1;
    least[t.least] = (least[t.least] ?? 0) + 1;
  }
  return { most, least };
}

/** Highest count first; ties break on uid so every client renders the same order. */
export function ranked(counts: Record<string, number>): { uid: string; count: number }[] {
  return Object.entries(counts)
    .filter(([, c]) => c > 0)
    .map(([uid, count]) => ({ uid, count }))
    .sort((a, b) => b.count - a.count || a.uid.localeCompare(b.uid));
}

/**
 * How much `self` likes `other`, from the conversation: people who talked *to* you and
 * engaged warmly score up, people who accused you score down, silent ones are shady.
 */
export function affinity(self: string, other: string, sig: SocialSignals, paranoia: number): number {
  const toMe = sig.mentions[other]?.[self] ?? 0;
  const fromMe = sig.mentions[self]?.[other] ?? 0;
  const accusedMe = sig.accusations[other]?.[self] ?? 0;
  const iAccused = sig.accusations[self]?.[other] ?? 0;
  const vouchedForMe = sig.vouches?.[other]?.[self] ?? 0;
  const msgs = sig.messages[other] ?? 0;
  const len = sig.avgLength[other] ?? 0;
  // An accusation outweighs the mention it came in, and outweighs mere silence.
  let score = toMe * 1.5 + fromMe * 0.8 + vouchedForMe * 3 - accusedMe * 5 - iAccused * 2;
  if (msgs === 0) score -= 2 * paranoia + 1;
  else score += Math.min(msgs, 6) * 0.25;
  if (len > 90) score -= paranoia * 1.5; // essay-length replies feel machine-ish
  return score;
}

/**
 * A bot's trust picks, driven by the conversation and its persona's paranoia.
 * `random` only breaks near-ties, so the choice reads as a judgement, not a dice roll.
 */
export function botTrustPick(
  self: string,
  roster: string[],
  sig: SocialSignals,
  paranoia: number,
  random: () => number,
): TrustPick | null {
  const others = roster.filter((u) => u !== self);
  if (others.length < 2) return null;
  const scored = others
    .map((uid) => ({ uid, s: affinity(self, uid, sig, paranoia) + random() * 0.6 }))
    .sort((a, b) => b.s - a.s);
  return { most: scored[0].uid, least: scored[scored.length - 1].uid };
}
