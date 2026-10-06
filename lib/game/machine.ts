import type { z } from "zod";
import {
  type ActiveEvent,
  type ChatDurationSchema,
  DEFENSE_SECONDS,
  type EventResult,
  type GameState,
  type Phase,
  type Reveal,
  TRUST_SECONDS,
  VOTE_SECONDS,
} from "./types";

export type GameAction =
  | {
      type: "start";
      roundId: string;
      topic: string;
      commitment: string;
      roster: string[];
      aliases: Record<string, string>;
      chatSeconds: z.infer<typeof ChatDurationSchema>;
    }
  | { type: "trust"; force?: boolean }
  | { type: "defense"; allDone?: boolean }
  | { type: "vote"; allDone?: boolean }
  | { type: "reveal"; reveal: Reveal; allVoted?: boolean }
  | { type: "lobby" }
  | { type: "eventStart"; event: ActiveEvent }
  | { type: "eventEnd"; result?: EventResult };

export type TransitionResult =
  | { ok: true; state: GameState }
  | { ok: false; code: "bad_phase" | "too_early" | "bad_roster" | "bad_event"; message: string };

/** Grace windows absorb small clock skew between host and server. */
export const CHAT_END_GRACE_MS = 1500;
export const PHASE_END_GRACE_MS = 1000;
/** Host may end chat early, but not before this much of it has passed. */
export const MIN_CHAT_MS_BEFORE_FORCE = 20_000;
/** An event must finish at least this long before chat ends. */
export const EVENT_TAIL_MS = 5_000;
export const MAX_EVENTS_PER_ROUND = 2;

const ALLOWED_FROM: Record<GameAction["type"], Phase[]> = {
  start: ["LOBBY", "REVEAL"],
  trust: ["CHAT"],
  defense: ["TRUST"],
  vote: ["DEFENSE"],
  reveal: ["VOTE"],
  lobby: ["REVEAL"],
  eventStart: ["CHAT"],
  eventEnd: ["CHAT"],
};

/** The action that ends each timed phase. Clients use this to drive the clock. */
export const NEXT_ACTION: Partial<Record<Phase, "trust" | "defense" | "vote" | "reveal">> = {
  CHAT: "trust",
  TRUST: "defense",
  DEFENSE: "vote",
  VOTE: "reveal",
};

export function canApply(state: GameState, action: GameAction["type"]): boolean {
  return ALLOWED_FROM[action].includes(state.phase);
}

function timeUp(state: GameState, now: number, grace: number): boolean {
  return now >= (state.endsAt ?? now) - grace;
}

/**
 * Pure state machine. All timestamps are absolute (ms since epoch), so clients never drift.
 * Interrogation events live *inside* CHAT: they never change the phase or its deadline.
 */
export function transition(state: GameState, action: GameAction, now: number): TransitionResult {
  if (!canApply(state, action.type)) {
    return { ok: false, code: "bad_phase", message: `Cannot ${action.type} during ${state.phase}` };
  }
  const base = { ...state, seq: state.seq + 1, phaseStartedAt: now };

  switch (action.type) {
    case "start": {
      if (action.roster.length < 2) {
        return { ok: false, code: "bad_roster", message: "Need at least two seats filled" };
      }
      return {
        ok: true,
        state: {
          ...base,
          phase: "CHAT",
          round: state.round + 1,
          roundId: action.roundId,
          topic: action.topic,
          chatSeconds: action.chatSeconds,
          endsAt: now + action.chatSeconds * 1000,
          commitment: action.commitment,
          roster: [...action.roster],
          aliases: { ...action.aliases },
          lobbyNotice: null,
          reveal: null,
          roundStartedAt: now,
          event: null,
          eventsRun: 0,
          eventLog: [],
        },
      };
    }
    case "trust": {
      const forcedOk = action.force === true && now - state.phaseStartedAt >= MIN_CHAT_MS_BEFORE_FORCE;
      if (!timeUp(state, now, CHAT_END_GRACE_MS) && !forcedOk) {
        return { ok: false, code: "too_early", message: "Chat is still running" };
      }
      return { ok: true, state: { ...base, phase: "TRUST", event: null, endsAt: now + TRUST_SECONDS * 1000 } };
    }
    case "defense": {
      if (!timeUp(state, now, PHASE_END_GRACE_MS) && action.allDone !== true) {
        return { ok: false, code: "too_early", message: "Still deciding who to trust" };
      }
      return { ok: true, state: { ...base, phase: "DEFENSE", endsAt: now + DEFENSE_SECONDS * 1000 } };
    }
    case "vote": {
      if (!timeUp(state, now, PHASE_END_GRACE_MS) && action.allDone !== true) {
        return { ok: false, code: "too_early", message: "Defenses are still coming in" };
      }
      return { ok: true, state: { ...base, phase: "VOTE", endsAt: now + VOTE_SECONDS * 1000 } };
    }
    case "reveal": {
      if (!timeUp(state, now, PHASE_END_GRACE_MS) && action.allVoted !== true) {
        return { ok: false, code: "too_early", message: "Votes are still coming in" };
      }
      const scores = { ...state.scores };
      for (const r of action.reveal.results) scores[r.uid] = (scores[r.uid] ?? 0) + r.roundScore;
      return { ok: true, state: { ...base, phase: "REVEAL", endsAt: null, reveal: action.reveal, scores } };
    }
    case "lobby": {
      return {
        ok: true,
        state: {
          ...base,
          phase: "LOBBY",
          endsAt: null,
          roundId: null,
          topic: null,
          commitment: null,
          roster: [],
          aliases: {},
          reveal: null,
          event: null,
          eventsRun: 0,
          eventLog: [],
        },
      };
    }
    case "eventStart": {
      const e = action.event;
      if (state.event) return { ok: false, code: "bad_event", message: "An event is already running" };
      if (state.eventsRun >= MAX_EVENTS_PER_ROUND) return { ok: false, code: "bad_event", message: "No more events this round" };
      if (e.endsAt > (state.endsAt ?? 0) - EVENT_TAIL_MS || e.endsAt <= now) {
        return { ok: false, code: "bad_event", message: "Not enough time left for an event" };
      }
      if (e.targetUid && !state.roster.includes(e.targetUid)) {
        return { ok: false, code: "bad_event", message: "Event target is not seated" };
      }
      // phaseStartedAt deliberately unchanged: the chat clock keeps running.
      return { ok: true, state: { ...state, seq: state.seq + 1, event: e, eventsRun: state.eventsRun + 1 } };
    }
    case "eventEnd": {
      if (!state.event) return { ok: false, code: "bad_event", message: "No event is running" };
      if (now < state.event.endsAt - PHASE_END_GRACE_MS) {
        return { ok: false, code: "too_early", message: "The event is still running" };
      }
      const eventLog = action.result ? [...state.eventLog, action.result].slice(-2) : state.eventLog;
      return { ok: true, state: { ...state, seq: state.seq + 1, event: null, eventLog } };
    }
  }
}

/** Time left in the current phase, clamped at 0. `null` when the phase is untimed. */
export function msRemaining(state: Pick<GameState, "endsAt">, now: number): number | null {
  return state.endsAt == null ? null : Math.max(0, state.endsAt - now);
}
