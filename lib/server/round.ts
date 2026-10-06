import "server-only";
import type { z } from "zod";
import { applyTemperament, rollTemperament, socialView } from "@/lib/bots/temperament";
import { assignObjectives, type BotObjective, objectiveProgress } from "@/lib/bots/objectives";
import type { BotSituation, TranscriptLine } from "@/lib/bots/planner";
import { roundMemory } from "@/lib/game/memory";
import { accusationsAgainst, type Line, socialSignals, type SocialSignals } from "@/lib/game/signals";
import { affinity } from "@/lib/game/trust";
import { type EventResult, type GameState, SealedEnvelopeSchema } from "@/lib/game/types";
import { openSealed } from "./ballots";
import * as cc from "./cometchat";
import { roundSeed } from "./crypto";
import { botMembers, type PooledBot, poolByUid } from "./room";

export type RoundLine = TranscriptLine & Line & { id: number; sentAt: number };

/** Chat lines of the current round, oldest first, read from CometChat (never from a client). */
export async function roundLines(guid: string, state: GameState, limit = 150): Promise<RoundLine[]> {
  const pool = poolByUid();
  const since = (state.roundStartedAt || state.phaseStartedAt) - 1000;
  const msgs = await cc.listRecentGroupMessages(guid, { limit, category: "message", type: "text" });
  return msgs
    .filter((m) => m.sentAt * 1000 >= since)
    .map((m) => ({
      id: m.id,
      sentAt: m.sentAt,
      uid: m.sender,
      // Everyone, bots included, only ever sees round aliases.
      name: state.aliases[m.sender] ?? m.data?.entities?.sender?.entity.name ?? "someone",
      text: (m.data?.text ?? "").slice(0, 280),
      botKey: pool.get(m.sender)?.persona.key,
    }));
}

/**
 * Valid custom events of one type for this round, one per sender.
 * `keep: "first"` for one-shot submissions (final defense), `"last"` for changeable ones.
 */
export async function collectRound<T extends { roundId: string }>(
  guid: string,
  state: GameState,
  type: string,
  schema: z.ZodType<T>,
  keep: "first" | "last",
  since = state.roundStartedAt || state.phaseStartedAt,
): Promise<Record<string, T>> {
  const msgs = await cc.listRecentGroupMessages(guid, { limit: 200, category: "custom", type });
  const out: Record<string, T> = {};
  const roster = new Set(state.roster);
  for (const m of msgs) {
    if (m.sentAt * 1000 < since - 2000 || !roster.has(m.sender)) continue;
    const parsed = schema.safeParse(m.data?.customData);
    if (!parsed.success || parsed.data.roundId !== state.roundId) continue;
    if (keep === "first" && out[m.sender]) continue;
    out[m.sender] = parsed.data;
  }
  return out;
}

/** Seats with the names the table knows them by (round aliases). */
export function rosterNames(state: GameState, members: { uid: string; name: string }[]): { uid: string; name: string }[] {
  const names = new Map(members.map((m) => [m.uid, m.name]));
  return state.roster.map((uid) => ({ uid, name: state.aliases[uid] ?? names.get(uid) ?? "someone" }));
}

/** Seated bots for this round, each presenting as its round alias. Persona style is unchanged. */
export function seatedBots(state: GameState, members: cc.CcMember[]): PooledBot[] {
  return botMembers(members)
    .filter((b) => state.roster.includes(b.uid))
    .map((b) => {
      const alias = state.aliases[b.uid] ?? b.persona.name;
      // Fresh behaviour every case: same voice, newly rolled temperament.
      const temperament = rollTemperament(roundSeed(state.roundId ?? ""), b.uid);
      return { ...b, name: alias, temperament, persona: { ...applyTemperament(b.persona, temperament), name: alias } };
    });
}

/**
 * Sealed private decisions (votes, trust, picks) for this round: open each envelope, validate the
 * inner payload, keep the latest per sender. Only the server can do this.
 */
export async function collectSealed<T extends { roundId: string }>(
  guid: string,
  state: GameState,
  type: string,
  inner: z.ZodType<T>,
  opts: { since?: number; eventId?: string } = {},
): Promise<Record<string, T>> {
  const since = opts.since ?? (state.roundStartedAt || state.phaseStartedAt);
  const msgs = await cc.listRecentGroupMessages(guid, { limit: 200, category: "custom", type });
  const roster = new Set(state.roster);
  const out: Record<string, T> = {};
  for (const m of msgs) {
    if (m.sentAt * 1000 < since - 2000 || !roster.has(m.sender)) continue;
    const env = SealedEnvelopeSchema.safeParse(m.data?.customData);
    if (!env.success || env.data.roundId !== state.roundId) continue;
    if (opts.eventId !== undefined && env.data.eventId !== opts.eventId) continue;
    // The sealed payload repeats the round id, so an envelope can't be replayed into another round.
    const parsed = inner.safeParse(await openSealed(env.data.sealed));
    if (parsed.success && parsed.data.roundId === state.roundId) out[m.sender] = parsed.data; // last one wins
  }
  return out;
}

export function objectivesFor(state: GameState, bots: PooledBot[], roster: { uid: string; name: string }[]): Record<string, BotObjective> {
  // Sorted, so every caller derives the same assignment regardless of member-list order.
  return assignObjectives(roundSeed(state.roundId ?? ""), bots.map((b) => b.uid).sort(), roster);
}

/** Private context per bot: objective progress, heat on them, who they like or distrust. */
export function botSituations(input: {
  bots: PooledBot[];
  lines: RoundLine[];
  roster: { uid: string; name: string }[];
  objectives: Record<string, BotObjective>;
  hotSeatUid?: string | null;
  signals?: SocialSignals;
  /** Public event results (aggregates every player saw). */
  eventLog?: EventResult[];
  /** Round seed for each bot's private hunches. */
  seed?: string;
}): Record<string, BotSituation> {
  const sig = input.signals ?? socialSignals(input.lines, input.roster);
  const name = new Map(input.roster.map((p) => [p.uid, p.name]));
  const out: Record<string, BotSituation> = {};
  for (const bot of input.bots) {
    const objective = input.objectives[bot.uid];
    const accused = accusationsAgainst(sig, bot.uid);
    const accusers = Object.entries(sig.accusations)
      .filter(([, row]) => (row[bot.uid] ?? 0) > 0)
      .map(([from]) => name.get(from))
      .filter(Boolean);
    const ranked = input.roster
      .filter((p) => p.uid !== bot.uid)
      .map((p) => ({ name: p.name, s: affinity(bot.uid, p.uid, sig, bot.persona.paranoia) }))
      .sort((a, b) => b.s - a.s);
    out[bot.uid] = {
      objective: objective
        ? {
            description: objective.description,
            done: objectiveProgress(objective, { botUid: bot.uid, botName: bot.name, lines: input.lines }) === "COMPLETED",
          }
        : undefined,
      suspicion:
        [
          accused > 0 ? `${accusers.join(" and ")} hinted you might be a bot` : "",
          (input.eventLog ?? [])
            .filter((e) => e.type === "POINT" && (e.counts[bot.uid] ?? 0) > 0)
            .map((e) => `the room pointed at you (${e.counts[bot.uid]} picks)`)
            .join("; "),
        ]
          .filter(Boolean)
          .join("; ") || undefined,
      vouchedBy:
        Object.entries(sig.vouches)
          .filter(([, row]) => (row[bot.uid] ?? 0) > 0)
          .map(([from]) => name.get(from))
          .filter(Boolean)
          .join(" and ") || undefined,
      own: roundMemory(bot.uid, input.lines, sig, name).own,
      ...(() => {
        if (!bot.temperament) return {};
        const v = socialView(bot.uid, input.roster.map((p) => p.uid), sig, bot.temperament, input.seed ?? "");
        return {
          suspects: v.mostSuspected ? name.get(v.mostSuspected) : undefined,
          trusts: v.mostTrusted ? name.get(v.mostTrusted) : undefined,
          stance: bot.temperament.label,
          recent: input.lines.filter((l) => l.uid === bot.uid).slice(-3).map((l) => l.text),
        };
      })(),
      closest: ranked[0] && ranked[0].s > 0.5 ? ranked[0].name : undefined,
      wary: ranked.length > 1 && ranked[ranked.length - 1].s < -0.5 ? ranked[ranked.length - 1].name : undefined,
      hotSeat: input.hotSeatUid === bot.uid,
    };
  }
  return out;
}

/** Table-wide memory for the shared prompt ("you" phrasing omitted). */
export function tableMemory(lines: RoundLine[], roster: { uid: string; name: string }[], eventLog: EventResult[]) {
  const sig = socialSignals(lines, roster);
  const m = roundMemory("", lines, sig, new Map(roster.map((p) => [p.uid, p.name])), eventLog);
  return { facts: m.facts, dynamics: m.dynamics };
}
