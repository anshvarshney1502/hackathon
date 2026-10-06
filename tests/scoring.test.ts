import { describe, expect, it } from "vitest";
import { computeAwards, revealOrder, sanitizeBallots, scoreRound } from "@/lib/game/scoring";
import { VoteEventSchema } from "@/lib/game/types";

const H1 = "p-hhhhhhhhhhh1".replace("1", "a");
const H2 = "p-hhhhhhhhhhhb";
const B1 = "p-bbbbbbbbbbbc";
const B2 = "p-bbbbbbbbbbbd";

const players = [
  { uid: H1, name: "ana", isBot: false },
  { uid: H2, name: "ben", isBot: false },
  { uid: B1, name: "riya", isBot: true },
  { uid: B2, name: "Kabir", isBot: true },
];

describe("vote processing", () => {
  it("drops self-votes, unknown voters and unknown targets", () => {
    const clean = sanitizeBallots(
      {
        [H1]: { [H1]: "HUMAN", [B1]: "BOT", "p-zzzzzzzzzzzz": "BOT" },
        "p-intruderxxxx": { [H1]: "BOT" },
      },
      players.map((p) => p.uid),
    );
    expect(clean).toEqual({ [H1]: { [B1]: "BOT" } });
  });

  it("validates vote events with zod", () => {
    expect(VoteEventSchema.safeParse({ roundId: "r", ballots: { [B1]: "BOT" } }).success).toBe(true);
    expect(VoteEventSchema.safeParse({ roundId: "r", ballots: { [B1]: "MAYBE" } }).success).toBe(false);
    expect(VoteEventSchema.safeParse({ roundId: "r", ballots: { "not-a-uid": "BOT" } }).success).toBe(false);
    expect(VoteEventSchema.safeParse({ ballots: {} }).success).toBe(false);
  });
});

describe("scoring", () => {
  const box = {
    // ana: perfect read
    [H1]: { [H2]: "HUMAN", [B1]: "BOT", [B2]: "BOT" },
    // ben: fooled by riya
    [H2]: { [H1]: "HUMAN", [B1]: "HUMAN", [B2]: "BOT" },
    // bots vote too
    [B1]: { [H1]: "BOT", [H2]: "HUMAN", [B2]: "HUMAN" },
    [B2]: { [H1]: "HUMAN", [H2]: "BOT", [B1]: "HUMAN" },
  } as const;

  const results = scoreRound(players, box);
  const by = Object.fromEntries(results.map((r) => [r.uid, r]));

  it("humans get +1 per correct guess", () => {
    expect(by[H1].correctGuesses).toBe(3);
    expect(by[H2].correctGuesses).toBe(2);
  });

  it("humans get +2 when most humans call them HUMAN", () => {
    expect(by[H1].humanBonus).toBe(2); // ben said HUMAN
    expect(by[H2].humanBonus).toBe(2); // ana said HUMAN
    expect(by[H1].roundScore).toBe(5);
    expect(by[H2].roundScore).toBe(4);
  });

  it("bots win when most humans call them HUMAN (ties are not a win)", () => {
    // riya: ana BOT, ben HUMAN → 1-1 tie among humans → no win
    expect(by[B1].botWon).toBe(false);
    expect(by[B1].fooled).toBe(1);
    // Kabir: both humans said BOT
    expect(by[B2].botWon).toBe(false);
    expect(by[B2].fooled).toBe(0);
  });

  it("counts every ballot received and judges the majority", () => {
    // riya received: ana BOT, ben HUMAN, Kabir HUMAN → majority HUMAN → wrong
    expect(by[B1].votesHuman).toBe(2);
    expect(by[B1].votesBot).toBe(1);
    expect(by[B1].majorityCorrect).toBe(false);
    // ana received: ben HUMAN, riya BOT, Kabir HUMAN → majority HUMAN → correct
    expect(by[H1].majorityCorrect).toBe(true);
  });

  it("a bot fools the humans → bot wins", () => {
    const r = scoreRound(players, { [H1]: { [B1]: "HUMAN" }, [H2]: { [B1]: "HUMAN" } });
    const riya = r.find((x) => x.uid === B1);
    expect(riya?.botWon).toBe(true);
    expect(riya?.roundScore).toBe(2);
  });

  it("nobody voted → majorityCorrect is null, scores are zero", () => {
    const r = scoreRound(players, {});
    expect(r.every((x) => x.majorityCorrect === null && x.roundScore === 0 && !x.voted)).toBe(true);
  });

  it("awards: most convincing bot and most bot-like human", () => {
    const awards = computeAwards(results);
    expect(awards.find((a) => a.kind === "convincing_bot")?.uid).toBe(B1);
    // ana: 1 BOT of 3; ben: 1 BOT of 3 → tie on ratio and count → uid order
    expect([H1, H2]).toContain(awards.find((a) => a.kind === "bot_like_human")?.uid);
  });

  it("no awards when nobody qualifies (never invented from thin air)", () => {
    expect(computeAwards(scoreRound(players, {}))).toEqual([]);
  });

  it("reveal order is deterministic per round", () => {
    const a = revealOrder(results, "round-1").map((r) => r.uid);
    const b = revealOrder([...results].reverse(), "round-1").map((r) => r.uid);
    expect(a).toEqual(b);
  });
});
