import type { Award, PlayerResult, RevealDetail } from "./types";

export const AWARD_TITLES: Record<Award["kind"], string> = {
  convincing_bot: "Most convincing bot",
  bot_like_human: "Most bot-like human",
  most_trusted: "Most trusted",
  biggest_suspect: "Biggest suspect",
  chaos_agent: "Chaos agent",
  best_defense: "Best defense",
};

export interface Recap {
  kind: "SOLO" | "SOCIAL";
  /** Heading above the numbers. */
  title: string;
  /** One honest sentence about what this round was. */
  intro: string[];
  rows: [label: string, value: string][];
}

/**
 * The round recap, aware of the real composition. Only statistics that mean something for that
 * composition are included: a Solo Case never shows human-vs-human lines such as "Most bot-like human".
 */
export function buildRecap(input: {
  results: PlayerResult[];
  awards: Award[];
  detail: RevealDetail | null;
}): Recap {
  const { results, awards, detail } = input;
  const humans = results.filter((r) => !r.isBot);
  const bots = results.filter((r) => r.isBot);
  const nameOf = (uid: string) => results.find((r) => r.uid === uid)?.name ?? "someone";
  const award = (kind: Award["kind"]): [string, string][] => {
    const a = awards.find((x) => x.kind === kind);
    return a ? [[AWARD_TITLES[kind], nameOf(a.uid)]] : [];
  };
  const objectives = detail?.players.filter((p) => p.objective) ?? [];
  const objectiveRow: [string, string][] = objectives.length
    ? [["Secret objectives", `${objectives.filter((p) => p.objective?.status === "COMPLETED").length} / ${objectives.length}`]]
    : [];

  // One human is a Solo Case no matter how the room was opened.
  if (humans.length === 1) {
    const me = humans[0];
    const seenThrough = me?.voted ? me.correctGuesses : null;
    return {
      kind: "SOLO",
      title: "Solo case",
      intro: ["You were the only human.", `${bots.length} AI players entered the room.`],
      rows: [
        ...(seenThrough !== null ? ([["Bots correctly identified", `${seenThrough} / ${bots.length}`]] as [string, string][]) : []),
        ...award("convincing_bot"),
        ...award("most_trusted"),
        ...award("biggest_suspect"),
        ...award("best_defense"),
        ...award("chaos_agent"),
        ...objectiveRow,
      ],
    };
  }
  return {
    kind: "SOCIAL",
    title: "Round recap",
    intro: [],
    rows: [
      ["Humans", String(humans.length)],
      ["Bots", String(bots.length)],
      ...award("convincing_bot"),
      ...award("bot_like_human"),
      ...award("most_trusted"),
      ...award("biggest_suspect"),
      ...award("best_defense"),
      ...award("chaos_agent"),
      ...objectiveRow,
    ],
  };
}
