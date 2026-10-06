import "server-only";
import { after } from "next/server";
import { findContradiction, findMemoryCue } from "@/lib/game/evidence";
import { buildEvent, EVENT_SPECS, planEvents } from "@/lib/game/events";
import { seededRandom } from "@/lib/game/rng";
import { transition } from "@/lib/game/machine";
import { CUSTOM_TYPES, type EventResult, type GameState, PickEventSchema } from "@/lib/game/types";
import { runEventBots } from "./bots";
import * as cc from "./cometchat";
import { roundSeed } from "./crypto";
import { loadRoom, saveIfUnchanged } from "./room";
import { collectSealed, rosterNames, roundLines } from "./round";

export type PulseOutcome = "idle" | "started" | "ended" | "not_chat" | "lost_race";

/** Tally a finished pick event. Self-picks, wrong-event picks and unseated players are ignored. */
export function tallyPicks(picks: Record<string, { pick: string; eventId: string }>, eventId: string, roster: string[]) {
  const seated = new Set(roster);
  const counts: Record<string, number> = {};
  for (const [voter, p] of Object.entries(picks)) {
    if (p.eventId !== eventId || p.pick === voter || !seated.has(p.pick) || !seated.has(voter)) continue;
    counts[p.pick] = (counts[p.pick] ?? 0) + 1;
  }
  return counts;
}

/**
 * Interrogation-event clock. The host pings this every few seconds during CHAT. The schedule
 * (0–2 events) comes from a server-secret seed, so clients can't see what's coming.
 * Events ride the existing sync path: state in group metadata plus a `game.event` nudge.
 * Events never change the phase or its deadline, so a missed pulse can't break a round.
 */
export async function pulse(guid: string, caller: string): Promise<{ outcome: PulseOutcome; state?: GameState }> {
  const room = await loadRoom(guid);
  if (!room) return { outcome: "not_chat" };
  const { state } = room;
  if (state.phase !== "CHAT" || !state.roundId || !room.members.some((m) => m.uid === caller)) return { outcome: "not_chat" };
  const now = Date.now();
  let next: GameState | null = null;
  let outcome: PulseOutcome = "idle";

  if (state.event) {
    if (now < state.event.endsAt) return { outcome: "idle" };
    let result: EventResult | undefined;
    if (EVENT_SPECS[state.event.type].mode === "pick") {
      const picks = await collectSealed(guid, state, CUSTOM_TYPES.pick, PickEventSchema, { since: state.event.startedAt, eventId: state.event.id });
      result = {
        id: state.event.id,
        type: state.event.type,
        counts: tallyPicks(picks, state.event.id, state.roster),
        answerUid: null,
        cue: null,
        endedAt: now,
      };
      if (state.event.type === "MEMORY") {
        // The answer is public chat history; it's only announced when the event closes.
        const word = state.event.prompt.match(/mentioned (\S+) earlier/i)?.[1]?.toLowerCase() ?? "";
        const lines = await roundLines(guid, state);
        const owner = lines.find((l) => l.sentAt * 1000 < (state.event?.startedAt ?? 0) && l.text.toLowerCase().includes(word));
        result = { ...result, cue: word.slice(0, 40), answerUid: owner?.uid ?? null };
      }
    }
    const res = transition(state, { type: "eventEnd", result }, now);
    if (res.ok) {
      next = res.state;
      outcome = "ended";
    }
  } else {
    const seed = roundSeed(state.roundId);
    const planned = planEvents(seed, state.chatSeconds, state.roster.length)[state.eventsRun];
    if (planned && now >= state.roundStartedAt + planned.atMs) {
      const roster = rosterNames(state, room.members).filter((p) => room.members.some((m) => m.uid === p.uid));
      let type = planned.type;
      let evidence: Parameters<typeof buildEvent>[6] = {};
      if (EVENT_SPECS[type].needsEvidence) {
        // Evidence events only fire on real evidence; otherwise fall back to an open question.
        const lines = await roundLines(guid, state);
        if (type === "CONTRADICTION") evidence = { contradiction: findContradiction(lines) };
        if (type === "MEMORY") evidence = { memory: findMemoryCue(lines, state.topic ?? "", seededRandom(`${seed}:memory`)) };
        if (!evidence.contradiction && !evidence.memory) {
          type = "EVERYONE";
          evidence = {};
        }
      }
      const event = buildEvent(type, seed, state.eventsRun, now, roster, state.topic ?? "the topic", evidence);
      const res = transition(state, { type: "eventStart", event }, now);
      if (res.ok) {
        next = res.state;
        outcome = "started";
      }
    }
  }

  if (!next) return { outcome: "idle" };
  if (!(await saveIfUnchanged(guid, state.seq, next))) return { outcome: "lost_race" };
  await cc.sendGroupCustom(guid, caller, CUSTOM_TYPES.event, { seq: next.seq });
  if (outcome === "started") {
    const started = next;
    after(() => runEventBots(guid, started).catch((e: unknown) => console.warn("[bots] event failed:", e)));
  }
  return { outcome, state: next };
}
