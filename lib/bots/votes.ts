import type { Ballots } from "@/lib/game/types";
import type { Persona } from "./personas";

export interface SpeakerStats {
  messages: number;
  avgLength: number;
}

/**
 * Bots judge everyone the way a distracted human would: from surface signals
 * (silence, essay-length messages, hyperactivity) plus their own paranoia and noise.
 * They are never told who is really a bot, so they make believable mistakes.
 */
export function botBallots(
  voter: { uid: string; persona: Persona },
  roster: string[],
  stats: Record<string, SpeakerStats>,
  random: () => number = Math.random,
  /** Room-wide suspicion per player (trust-least + "point at" picks − trust-most), seen by everyone. */
  heat: Record<string, number> = {},
): Ballots {
  const ballots: Ballots = {};
  for (const target of roster) {
    if (target === voter.uid) continue;
    const s = stats[target] ?? { messages: 0, avgLength: 0 };
    let pBot = 0.22 + voter.persona.paranoia * 0.3;
    if (s.messages === 0) pBot += 0.3;
    else if (s.messages <= 1) pBot += 0.1;
    if (s.avgLength > 80) pBot += 0.15;
    if (s.messages > 10) pBot += 0.1;
    // Bots go along with the room's mood a little, like people do.
    pBot += Math.max(-0.2, Math.min(0.25, (heat[target] ?? 0) * 0.08));
    pBot += (random() - 0.5) * 0.3;
    ballots[target] = random() < Math.min(0.9, Math.max(0.08, pBot)) ? "BOT" : "HUMAN";
  }
  return ballots;
}
