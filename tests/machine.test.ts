import { describe, expect, it } from "vitest";
import { CHAT_END_GRACE_MS, MIN_CHAT_MS_BEFORE_FORCE, msRemaining, NEXT_ACTION, transition } from "@/lib/game/machine";
import { DEFENSE_SECONDS, type GameState, GameStateSchema, initialGameState, type Reveal, TRUST_SECONDS, VOTE_SECONDS } from "@/lib/game/types";

const T0 = 1_700_000_000_000;
const roster = ["p-aaaaaaaaaaaa", "p-bbbbbbbbbbbb", "p-cccccccccccc"];

function started(now = T0): GameState {
  const res = transition(
    initialGameState(now),
    { type: "start", roundId: "r1", topic: "t", commitment: "c", roster, aliases: {}, chatSeconds: 180 },
    now,
  );
  if (!res.ok) throw new Error(res.message);
  return res.state;
}

/** CHAT → TRUST → DEFENSE → VOTE by timers. Returns the VOTE state (vote starts at T0+215s). */
function toVote(): GameState {
  const t = transition(started(), { type: "trust" }, T0 + 180_000);
  if (!t.ok) throw new Error(t.message);
  const d = transition(t.state, { type: "defense" }, T0 + 200_000);
  if (!d.ok) throw new Error(d.message);
  const v = transition(d.state, { type: "vote" }, T0 + 215_000);
  if (!v.ok) throw new Error(v.message);
  return v.state;
}

const emptyReveal: Reveal = {
  roundId: "r1",
  botUids: [],
  salt: "s",
  revealedAt: T0,
  results: [],
  awards: [],
};

describe("game state machine", () => {
  it("starts in LOBBY with a valid schema", () => {
    const s = initialGameState(T0);
    expect(s.phase).toBe("LOBBY");
    expect(GameStateSchema.safeParse(s).success).toBe(true);
  });

  it("LOBBY → CHAT sets absolute end time, round and roster", () => {
    const s = started();
    expect(s.phase).toBe("CHAT");
    expect(s.endsAt).toBe(T0 + 180_000);
    expect(s.round).toBe(1);
    expect(s.seq).toBe(1);
    expect(s.roster).toEqual(roster);
    expect(GameStateSchema.safeParse(s).success).toBe(true);
  });

  it("refuses to start with fewer than two players", () => {
    const res = transition(
      initialGameState(T0),
      { type: "start", roundId: "r", topic: "t", commitment: "c", roster: [roster[0]], aliases: {}, chatSeconds: 60 },
      T0,
    );
    expect(res.ok).toBe(false);
  });

  it("CHAT → TRUST only when time is up (with grace) or forced late enough", () => {
    const s = started();
    expect(transition(s, { type: "trust" }, T0 + 60_000).ok).toBe(false);
    expect(transition(s, { type: "trust" }, T0 + 180_000 - CHAT_END_GRACE_MS).ok).toBe(true);
    expect(transition(s, { type: "trust", force: true }, T0 + MIN_CHAT_MS_BEFORE_FORCE - 1).ok).toBe(false);
    const forced = transition(s, { type: "trust", force: true }, T0 + MIN_CHAT_MS_BEFORE_FORCE);
    expect(forced.ok && forced.state.endsAt).toBe(T0 + MIN_CHAT_MS_BEFORE_FORCE + TRUST_SECONDS * 1000);
  });

  it("TRUST → DEFENSE → VOTE run on absolute timers, or early when everyone is done", () => {
    const t = transition(started(), { type: "trust" }, T0 + 180_000);
    if (!t.ok) throw new Error();
    expect(transition(t.state, { type: "defense" }, T0 + 185_000).ok).toBe(false);
    expect(transition(t.state, { type: "defense", allDone: true }, T0 + 185_000).ok).toBe(true);
    const d = transition(t.state, { type: "defense" }, T0 + 200_000);
    if (!d.ok) throw new Error();
    expect(d.state.phase).toBe("DEFENSE");
    expect(d.state.endsAt).toBe(T0 + 200_000 + DEFENSE_SECONDS * 1000);
    expect(transition(d.state, { type: "vote" }, T0 + 205_000).ok).toBe(false);
    const v = transition(d.state, { type: "vote" }, T0 + 215_000);
    expect(v.ok && v.state.endsAt).toBe(T0 + 215_000 + VOTE_SECONDS * 1000);
  });

  it("maps every timed phase to the action that ends it", () => {
    expect(NEXT_ACTION).toEqual({ CHAT: "trust", TRUST: "defense", DEFENSE: "vote", VOTE: "reveal" });
  });

  it("VOTE → REVEAL waits for the timer unless everyone voted", () => {
    const vote = toVote();
    const early = T0 + 220_000;
    expect(transition(vote, { type: "reveal", reveal: emptyReveal }, early).ok).toBe(false);
    expect(transition(vote, { type: "reveal", reveal: emptyReveal, allVoted: true }, early).ok).toBe(true);
    expect(transition(vote, { type: "reveal", reveal: emptyReveal }, T0 + 245_000).ok).toBe(true);
  });

  it("REVEAL accumulates scores and REVEAL → LOBBY clears the round", () => {
    const vote = { ok: true as const, state: toVote() };
    const reveal: Reveal = {
      ...emptyReveal,
      results: [
        {
          uid: roster[0], name: "a", isBot: false, votesHuman: 1, votesBot: 0, majorityCorrect: true,
          correctGuesses: 2, humanBonus: 2, fooled: 0, botWon: false, roundScore: 4, voted: true,
          messages: 3, trustMost: 1, trustLeast: 0, pointedAt: 0, defendedBy: 0, defended: true,
        },
      ],
    };
    const r = transition({ ...vote.state, scores: { [roster[0]]: 3 } }, { type: "reveal", reveal }, T0 + 246_000);
    if (!r.ok) throw new Error();
    expect(r.state.scores[roster[0]]).toBe(7);
    const lobby = transition(r.state, { type: "lobby" }, T0 + 230_000);
    expect(lobby.ok && lobby.state.phase).toBe("LOBBY");
    expect(lobby.ok && lobby.state.roster).toEqual([]);
    expect(lobby.ok && lobby.state.scores[roster[0]]).toBe(7);
  });

  it("rejects out-of-order actions", () => {
    const lobby = initialGameState(T0);
    expect(transition(lobby, { type: "vote" }, T0).ok).toBe(false);
    expect(transition(started(), { type: "vote" }, T0 + 999_999).ok).toBe(false);
    expect(transition(started(), { type: "defense" }, T0 + 999_999).ok).toBe(false);
    expect(transition(lobby, { type: "reveal", reveal: emptyReveal }, T0).ok).toBe(false);
    expect(transition(started(), { type: "lobby" }, T0).ok).toBe(false);
  });

  it("seq increases on every transition", () => {
    const s = started();
    const v = transition(s, { type: "trust" }, T0 + 180_000);
    expect(v.ok && v.state.seq).toBe(s.seq + 1);
  });

  it("msRemaining clamps at zero", () => {
    expect(msRemaining({ endsAt: T0 + 500 }, T0)).toBe(500);
    expect(msRemaining({ endsAt: T0 }, T0 + 9_000)).toBe(0);
    expect(msRemaining({ endsAt: null }, T0)).toBeNull();
  });

  it("schema rejects malformed state (e.g. a forged phase)", () => {
    expect(GameStateSchema.safeParse({ ...initialGameState(T0), phase: "WIN" }).success).toBe(false);
    expect(GameStateSchema.safeParse({ ...initialGameState(T0), chatSeconds: 7 }).success).toBe(false);
  });
});

describe("CometChat metadata quirks", () => {
  it("accepts scores stored as [] (CometChat turns {} into [])", () => {
    const stored = JSON.parse(JSON.stringify({ ...initialGameState(T0), scores: [] }));
    const parsed = GameStateSchema.safeParse(stored);
    expect(parsed.success && parsed.data.scores).toEqual({});
  });
});
