import type { Award, Ballots, PlayerResult, Verdict } from "./types";

export interface ScoringPlayer {
  uid: string;
  name: string;
  isBot: boolean;
}

/** voterUid → ballots. Only the voter's latest ballot set should be passed in. */
export type BallotBox = Record<string, Ballots>;

/**
 * Drop anything that could corrupt scoring: unknown voters, self-votes,
 * votes on players outside the roster.
 */
export function sanitizeBallots(box: BallotBox, rosterUids: string[]): BallotBox {
  const roster = new Set(rosterUids);
  const clean: BallotBox = {};
  for (const [voter, ballots] of Object.entries(box)) {
    if (!roster.has(voter)) continue;
    const kept: Ballots = {};
    for (const [target, verdict] of Object.entries(ballots)) {
      if (target === voter || !roster.has(target)) continue;
      if (verdict !== "HUMAN" && verdict !== "BOT") continue;
      kept[target] = verdict;
    }
    clean[voter] = kept;
  }
  return clean;
}

function majority(human: number, bot: number): Verdict | null {
  if (human === bot) return null;
  return human > bot ? "HUMAN" : "BOT";
}

/**
 * Rules (shown verbatim in the UI):
 *  - Humans: +1 for every correct guess.
 *  - Humans: +2 if most humans who judged them called them HUMAN.
 *  - Bots win if most humans who judged them called them HUMAN.
 *  - "Majority correct" counts every ballot a player received (bots vote too).
 */
export function scoreRound(players: ScoringPlayer[], rawBox: BallotBox): PlayerResult[] {
  const byUid = new Map(players.map((p) => [p.uid, p]));
  const box = sanitizeBallots(rawBox, players.map((p) => p.uid));

  return players.map((p) => {
    let votesHuman = 0;
    let votesBot = 0;
    let humanVotersHuman = 0;
    let humanVotersBot = 0;

    for (const [voterUid, ballots] of Object.entries(box)) {
      const verdict = ballots[p.uid];
      if (!verdict) continue;
      const voterIsHuman = byUid.get(voterUid)?.isBot === false;
      if (verdict === "HUMAN") {
        votesHuman++;
        if (voterIsHuman) humanVotersHuman++;
      } else {
        votesBot++;
        if (voterIsHuman) humanVotersBot++;
      }
    }

    const truth: Verdict = p.isBot ? "BOT" : "HUMAN";
    const overall = majority(votesHuman, votesBot);
    const majorityCorrect = votesHuman + votesBot === 0 ? null : overall === truth;
    const humansSayHuman = humanVotersHuman > humanVotersBot;

    let correctGuesses = 0;
    if (!p.isBot) {
      for (const [target, verdict] of Object.entries(box[p.uid] ?? {})) {
        const t = byUid.get(target);
        if (t && verdict === (t.isBot ? "BOT" : "HUMAN")) correctGuesses++;
      }
    }

    const humanBonus = !p.isBot && humansSayHuman ? 2 : 0;
    const botWon = p.isBot && humansSayHuman;
    const fooled = p.isBot ? humanVotersHuman : 0;

    return {
      uid: p.uid,
      name: p.name,
      isBot: p.isBot,
      votesHuman,
      votesBot,
      majorityCorrect,
      correctGuesses,
      humanBonus,
      fooled,
      botWon,
      roundScore: p.isBot ? fooled : correctGuesses + humanBonus,
      voted: Object.keys(box[p.uid] ?? {}).length > 0,
      messages: 0,
      trustMost: 0,
      trustLeast: 0,
      pointedAt: 0,
      defendedBy: 0,
      defended: false,
    };
  });
}

function ratio(part: number, total: number): number {
  return total === 0 ? 0 : part / total;
}

/** Extra deterministic counts the reveal shows. */
export interface SocialExtras {
  messages: Record<string, number>;
  trustMost: Record<string, number>;
  trustLeast: Record<string, number>;
  pointedAt: Record<string, number>;
  defendedBy: Record<string, number>;
  /** Players who submitted a final defense. */
  defended: Set<string>;
  /** Accusations + pushbacks made (Chaos Agent). */
  disruptions: Record<string, number>;
}

export function withSocial(results: PlayerResult[], x: Omit<SocialExtras, "disruptions">): PlayerResult[] {
  return results.map((r) => ({
    ...r,
    messages: x.messages[r.uid] ?? 0,
    trustMost: x.trustMost[r.uid] ?? 0,
    trustLeast: x.trustLeast[r.uid] ?? 0,
    pointedAt: x.pointedAt[r.uid] ?? 0,
    defendedBy: x.defendedBy[r.uid] ?? 0,
    defended: x.defended.has(r.uid),
  }));
}

/** Everything that counted as suspicion against a player this round. */
export function suspicion(r: PlayerResult): number {
  return r.votesBot + r.trustLeast + r.pointedAt;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Awards only appear when the data supports them. Ties break on a secondary count, then
 * uid, so every client derives the same winner.
 */
export function computeAwards(results: PlayerResult[], disruptions: Record<string, number> = {}): Award[] {
  const pick = (pool: PlayerResult[], score: (r: PlayerResult) => [number, number], min = 0) =>
    pool
      .map((r) => ({ r, s: score(r) }))
      .filter(({ s }) => s[0] > min)
      .sort((a, b) => b.s[0] - a.s[0] || b.s[1] - a.s[1] || a.r.uid.localeCompare(b.r.uid))[0]?.r;

  const awards: Award[] = [];
  const bot = pick(results.filter((r) => r.isBot), (r) => [ratio(r.votesHuman, r.votesHuman + r.votesBot), r.votesHuman]);
  if (bot) awards.push({ kind: "convincing_bot", uid: bot.uid, detail: `${bot.votesHuman} of ${bot.votesHuman + bot.votesBot} called it human` });

  const human = pick(results.filter((r) => !r.isBot), (r) => [ratio(r.votesBot, r.votesHuman + r.votesBot), r.votesBot]);
  if (human) awards.push({ kind: "bot_like_human", uid: human.uid, detail: `${human.votesBot} of ${human.votesHuman + human.votesBot} called them a bot` });

  const trusted = pick(results, (r) => [r.trustMost, -r.trustLeast]);
  if (trusted) awards.push({ kind: "most_trusted", uid: trusted.uid, detail: `${plural(trusted.trustMost, "player")} trusted them most` });

  const suspect = pick(results, (r) => [suspicion(r), r.votesBot], 1);
  if (suspect) awards.push({ kind: "biggest_suspect", uid: suspect.uid, detail: `Suspected ${plural(suspicion(suspect), "time")}` });

  const chaos = pick(results, (r) => [disruptions[r.uid] ?? 0, r.messages], 1);
  if (chaos) {
    awards.push({ kind: "chaos_agent", uid: chaos.uid, detail: `${plural(disruptions[chaos.uid] ?? 0, "accusation or pushback", "accusations and pushbacks")}` });
  }

  // Best defense: suspected during the round, defended at the end, and the verdicts swung their way.
  const defense = pick(
    results.filter((r) => r.defended && r.trustLeast + r.pointedAt >= 1 && r.votesHuman >= r.votesBot),
    (r) => [r.votesHuman - (r.trustLeast + r.pointedAt), r.votesHuman],
  );
  if (defense) awards.push({ kind: "best_defense", uid: defense.uid, detail: "Under suspicion, then won the room back" });

  return awards;
}

/** A one-line read on a human, from their numbers. Bots use their persona tagline instead. */
export function humanArchetype(r: PlayerResult, results: PlayerResult[], disruptions: Record<string, number>): string {
  const maxBy = (f: (x: PlayerResult) => number) => Math.max(0, ...results.map(f));
  if (r.messages === 0) return "The silent one";
  if ((disruptions[r.uid] ?? 0) >= 2 && (disruptions[r.uid] ?? 0) === maxBy((x) => disruptions[x.uid] ?? 0)) return "The instigator";
  if (r.trustMost >= 1 && r.trustMost === maxBy((x) => x.trustMost)) return "The trusted one";
  if (r.votesBot > r.votesHuman) return "The one who seemed off";
  if (r.messages >= 8 && r.messages === maxBy((x) => x.messages)) return "The talker";
  return "The steady one";
}

/** Deterministic spotlight order for the reveal, seeded by the round id. */
export function revealOrder<T extends { uid: string }>(items: T[], seed: string): T[] {
  const key = (uid: string) => {
    let h = 2166136261;
    for (const ch of seed + uid) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return h >>> 0;
  };
  return [...items].sort((a, b) => key(a.uid) - key(b.uid));
}
