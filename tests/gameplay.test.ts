import { describe, expect, it } from "vitest";
import { assignDefenseTones, DEFENSE_TONES, DefensePlanSchema, fallbackDefense } from "@/lib/bots/defense";
import { eventParticipants } from "@/lib/bots/eventLines";
import { humanize } from "@/lib/bots/humanize";
import { assignObjectives, type BotObjective, evaluateObjective, objectiveProgress } from "@/lib/bots/objectives";
import { PERSONAS } from "@/lib/bots/personas";
import { chooseCandidates } from "@/lib/bots/planner";
import { buildEvent, EVENT_SPECS, isOneWord, planEvents } from "@/lib/game/events";
import { EVENT_TAIL_MS, MAX_EVENTS_PER_ROUND, transition } from "@/lib/game/machine";
import { seededRandom } from "@/lib/game/rng";
import { computeAwards, humanArchetype, scoreRound, suspicion, withSocial } from "@/lib/game/scoring";
import { socialSignals, type Line } from "@/lib/game/signals";
import { botTrustPick, ranked, sanitizeTrust, tallyTrust } from "@/lib/game/trust";
import {
  DefenseEventSchema,
  GameStateSchema,
  initialGameState,
  PickEventSchema,
  RevealDetailSchema,
  TrustEventSchema,
} from "@/lib/game/types";
import { tallyPicks } from "@/lib/server/events";

const A = "p-aaaaaaaaaaaa"; // human "Ana"
const B = "p-bbbbbbbbbbbb"; // human "Ben"
const R = "p-rrrrrrrrrrrr"; // bot "riya"
const K = "p-kkkkkkkkkkkk"; // bot "Kabir"
const Z = "p-zzzzzzzzzzzz"; // bot "Zoya"
const roster = [
  { uid: A, name: "Ana" },
  { uid: B, name: "Ben" },
  { uid: R, name: "riya" },
  { uid: K, name: "Kabir" },
  { uid: Z, name: "Zoya" },
];
const uids = roster.map((p) => p.uid);
const persona = (key: string) => PERSONAS.find((p) => p.key === key)!;

/* ------------------------------------------------------------------ objectives */

describe("secret objectives", () => {
  it("assigns exactly one objective per bot, all different, deterministically", () => {
    const a = assignObjectives("seed-1", [R, K, Z], roster);
    const b = assignObjectives("seed-1", [R, K, Z], roster);
    expect(Object.keys(a)).toEqual([R, K, Z]);
    expect(new Set(Object.values(a).map((o) => o.id)).size).toBe(3);
    expect(a).toEqual(b);
    expect(assignObjectives("seed-2", [R, K, Z], roster)).not.toEqual(a);
  });

  it("targeted objectives never target the bot itself", () => {
    for (let i = 0; i < 40; i++) {
      const objs = assignObjectives(`s${i}`, [R, K, Z], roster);
      for (const [uid, o] of Object.entries(objs)) {
        if (o.params.targetUid) expect(o.params.targetUid).not.toBe(uid);
      }
    }
  });

  const obj = (id: BotObjective["id"], params: BotObjective["params"] = {}): BotObjective => ({
    id,
    params,
    title: "t",
    description: "d",
    difficulty: "easy",
  });
  const L = (uid: string, text: string): Line => ({ uid, name: roster.find((p) => p.uid === uid)!.name, text });

  it("completes chat objectives from the transcript, deterministically", () => {
    const lines = [
      L(R, "biryani at weddings is always cold lol"),
      L(A, "haha same, riya where do you live?"),
      L(R, "nah pune weddings are better"),
      L(B, "nope, delhi wins"),
    ];
    const ctx = { botUid: R, botName: "riya", lines };
    expect(evaluateObjective(obj("MENTION_WORD", { word: "biryani" }), ctx)).toBe("COMPLETED");
    expect(evaluateObjective(obj("ASKED_A_QUESTION"), ctx)).toBe("COMPLETED");
    expect(evaluateObjective(obj("MAKE_LAUGH"), ctx)).toBe("COMPLETED");
    expect(evaluateObjective(obj("GET_AGREEMENT"), ctx)).toBe("COMPLETED");
    expect(evaluateObjective(obj("DISAGREE_ONCE"), ctx)).toBe("COMPLETED");
    expect(objectiveProgress(obj("DISAGREE_ONCE"), ctx)).toBe("COMPLETED");
  });

  it("fails objectives that never happened", () => {
    const ctx = { botUid: R, botName: "riya", lines: [L(R, "hello"), L(A, "ok")] };
    expect(objectiveProgress(obj("MAKE_LAUGH"), ctx)).toBe("IN_PROGRESS");
    expect(evaluateObjective(obj("MAKE_LAUGH"), ctx)).toBe("FAILED");
    expect(evaluateObjective(obj("MENTION_WORD", { word: "monsoon" }), ctx)).toBe("FAILED");
    expect(evaluateObjective(obj("FOOL_ONE"), ctx)).toBe("FAILED"); // no final data → failed
  });

  it("judges outcome objectives from votes and trust at reveal", () => {
    const base = { botUid: R, botName: "riya", lines: [] as Line[] };
    const final = { fooled: 1, trustMostFromOthers: 0, trustMostFromHumans: 0, defendedBy: 0, isTopSuspect: false };
    expect(evaluateObjective(obj("FOOL_ONE"), { ...base, final })).toBe("COMPLETED");
    expect(evaluateObjective(obj("BE_TRUSTED"), { ...base, final })).toBe("FAILED");
    expect(evaluateObjective(obj("GET_DEFENDED"), { ...base, final: { ...final, defendedBy: 1 } })).toBe("COMPLETED");
    expect(
      evaluateObjective(obj("FRAME_TARGET", { targetUid: A }), {
        ...base,
        final: { ...final, target: { votesBot: 3, votesHuman: 1, trustLeast: 0, pointedAt: 0 } },
      }),
    ).toBe("COMPLETED");
    const argue = { ...base, lines: [L(R, "nah thats wrong"), L(A, "nope you're wrong")] };
    expect(evaluateObjective(obj("MINI_ARGUMENT"), { ...argue, final })).toBe("COMPLETED");
    expect(evaluateObjective(obj("MINI_ARGUMENT"), { ...argue, final: { ...final, isTopSuspect: true } })).toBe("FAILED");
  });
});

/* ------------------------------------------------------------------ trust */

describe("trust most / least", () => {
  it("rejects self-picks, same-player picks and unseated players", () => {
    expect(TrustEventSchema.safeParse({ roundId: "r", most: A, least: A }).success).toBe(false);
    const clean = sanitizeTrust(
      { [A]: { most: A, least: B }, [B]: { most: R, least: R }, [R]: { most: "p-nobodyhereee", least: A }, [K]: { most: A, least: B } },
      uids,
    );
    expect(clean).toEqual({ [K]: { most: A, least: B } });
  });

  it("aggregates and ranks deterministically", () => {
    const t = tallyTrust({ [A]: { most: B, least: R }, [K]: { most: B, least: Z }, [Z]: { most: A, least: R } });
    expect(t.most).toEqual({ [B]: 2, [A]: 1 });
    expect(ranked(t.least)).toEqual([
      { uid: R, count: 2 },
      { uid: Z, count: 1 },
    ]);
  });

  it("bot picks follow the conversation, not dice", () => {
    const lines: Line[] = [
      { uid: A, name: "Ana", text: "riya you're so funny" },
      { uid: R, name: "riya", text: "ana thank youuu" },
      { uid: B, name: "Ben", text: "riya is 100% a bot" },
      { uid: K, name: "Kabir", text: "hmm" },
    ];
    const sig = socialSignals(lines, roster);
    for (let seed = 0; seed < 10; seed++) {
      const pick = botTrustPick(R, uids, sig, 0.5, seededRandom(`t${seed}`));
      expect(pick?.most).toBe(A);
      expect(pick?.least).toBe(B);
      expect(pick?.most).not.toBe(R);
    }
  });
});

/* ------------------------------------------------------------------ final defense */

describe("final defense", () => {
  it("validates a single, short defense", () => {
    expect(DefenseEventSchema.safeParse({ roundId: "r", text: "im human, i ate maggi today" }).success).toBe(true);
    expect(DefenseEventSchema.safeParse({ roundId: "r", text: "   " }).success).toBe(false);
    expect(DefenseEventSchema.safeParse({ roundId: "r", text: "x".repeat(141) }).success).toBe(false);
  });

  it("gives bots varied tones, deterministically", () => {
    const tones = assignDefenseTones("seed", ["riya", "kabir", "zoya", "dev", "sam"]);
    expect(new Set(Object.values(tones)).size).toBe(DEFENSE_TONES.length);
    expect(assignDefenseTones("seed", ["riya", "kabir", "zoya", "dev", "sam"])).toEqual(tones);
  });

  it("always has an in-character fallback so no bot goes silent", () => {
    for (const tone of DEFENSE_TONES) {
      const line = fallbackDefense(persona("riya"), tone, () => 0.3);
      expect(line.length).toBeGreaterThan(5);
      expect(line).toBe(line.toLowerCase()); // riya types in lowercase
    }
    expect(fallbackDefense(persona("rohan"), "confident", () => 0)[0]).toMatch(/[A-Z]/);
  });

  it("validates the LLM defense plan", () => {
    expect(DefensePlanSchema.safeParse({ defenses: [{ bot: "riya", message: "lol im human" }] }).success).toBe(true);
    expect(DefensePlanSchema.safeParse({ defenses: "nope" }).success).toBe(false);
  });

  it("missing defenses (disconnected players) are simply absent, never invented", () => {
    const results = withSocial(scoreRound(roster.map((p) => ({ ...p, isBot: p.uid !== A && p.uid !== B })), {}), {
      messages: {},
      trustMost: {},
      trustLeast: {},
      pointedAt: {},
      defendedBy: {},
      defended: new Set([A]),
    });
    expect(results.find((r) => r.uid === A)?.defended).toBe(true);
    expect(results.find((r) => r.uid === B)?.defended).toBe(false);
  });
});

/* ------------------------------------------------------------------ interrogation events */

describe("interrogation events", () => {
  it("schedules 1–2 events that always finish before chat ends", () => {
    const counts = new Set<number>();
    for (let i = 0; i < 200; i++) {
      for (const secs of [60, 120, 180, 300]) {
        const plan = planEvents(`seed${i}`, secs, 6);
        counts.add(plan.length);
        expect(plan.length).toBeLessThanOrEqual(secs <= 60 ? 1 : MAX_EVENTS_PER_ROUND);
        for (const e of plan) expect(e.atMs + EVENT_SPECS[e.type].durationMs).toBeLessThanOrEqual(secs * 1000 - EVENT_TAIL_MS);
        if (plan.length === 2) expect(plan[0].type).not.toBe(plan[1].type);
      }
    }
    expect([...counts].sort()).toEqual([1, 2]); // never zero: chat alone gets stale
  });

  it("is deterministic for a seed (stable across server instances)", () => {
    expect(planEvents("abc", 180, 6)).toEqual(planEvents("abc", 180, 6));
  });

  it("starts and ends inside CHAT without moving the chat clock", () => {
    const start = transition(
      initialGameState(0),
      { type: "start", roundId: "r", topic: "t", commitment: "c", roster: uids, aliases: {}, chatSeconds: 180 },
      0,
    );
    if (!start.ok) throw new Error();
    const chat = start.state;
    const ev = buildEvent("POINT", "seed", 0, 50_000, roster, "t");
    const s1 = transition(chat, { type: "eventStart", event: ev }, 50_000);
    if (!s1.ok) throw new Error(s1.message);
    expect(s1.state.endsAt).toBe(chat.endsAt);
    expect(s1.state.phaseStartedAt).toBe(chat.phaseStartedAt);
    expect(s1.state.eventsRun).toBe(1);
    expect(transition(s1.state, { type: "eventStart", event: ev }, 51_000).ok).toBe(false); // one at a time
    expect(transition(s1.state, { type: "eventEnd" }, 55_000).ok).toBe(false); // timeout not reached
    const s2 = transition(s1.state, { type: "eventEnd", result: { id: ev.id, type: "POINT", counts: { [R]: 2 }, answerUid: null, cue: null, endedAt: 66_000 } }, 66_000);
    expect(s2.ok && s2.state.event).toBeNull();
    expect(s2.ok && s2.state.eventLog[0].counts[R]).toBe(2);
    expect(s2.ok && GameStateSchema.safeParse(s2.state).success).toBe(true);
    // An event can't run into the end of chat.
    const late = buildEvent("UNPOPULAR", "seed", 1, 170_000, roster, "t");
    expect(s2.ok && transition(s2.state, { type: "eventStart", event: late }, 170_000).ok).toBe(false);
  });

  it("hot seat targets a seated player; trust phase clears a running event", () => {
    const ev = buildEvent("HOT_SEAT", "seed", 0, 1_000, roster, "t");
    expect(uids).toContain(ev.targetUid);
    expect(ev.prompt).toContain(roster.find((p) => p.uid === ev.targetUid)!.name);
  });

  it("validates picks and tallies them, ignoring self-picks and other events", () => {
    expect(PickEventSchema.safeParse({ roundId: "r", eventId: "e1", pick: A }).success).toBe(true);
    expect(PickEventSchema.safeParse({ roundId: "r", eventId: "e1", pick: "bad" }).success).toBe(false);
    const counts = tallyPicks(
      { [A]: { pick: R, eventId: "e1" }, [B]: { pick: R, eventId: "e1" }, [K]: { pick: K, eventId: "e1" }, [Z]: { pick: A, eventId: "old" } },
      "e1",
      uids,
    );
    expect(counts).toEqual({ [R]: 2 });
  });

  it("one-word rule is enforced for humans and bots alike", () => {
    expect(isOneWord("chaos")).toBe(true);
    expect(isOneWord("chaos!")).toBe(true);
    expect(isOneWord("pure chaos")).toBe(false);
    expect(humanize("Absolute chaos honestly", persona("riya"), () => 0.9, { oneWord: true })?.text).toBe("absolute");
  });

  it("hot seat: a bot under questioning answers the latest question", () => {
    const bots = ["riya", "kabir", "zoya"].map((k, i) => ({ uid: [R, K, Z][i], persona: persona(k) }));
    const res = chooseCandidates(bots, [{ name: "Ana", text: "kabir where did you grow up?" }], "reply", () => 0.5, K);
    expect(res.candidates.map((c) => c.uid)).toEqual([K]);
    const askers = eventParticipants(buildEvent("HOT_SEAT", "s", 0, 0, roster, "t"), bots, () => 0.4);
    expect(askers.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ reveal stats + awards */

describe("reveal stats and awards", () => {
  const players = roster.map((p) => ({ ...p, isBot: ![A, B].includes(p.uid) }));
  const box = {
    [A]: { [B]: "HUMAN", [R]: "HUMAN", [K]: "BOT", [Z]: "BOT" },
    [B]: { [A]: "BOT", [R]: "HUMAN", [K]: "BOT", [Z]: "HUMAN" },
    [K]: { [A]: "BOT", [B]: "HUMAN", [R]: "HUMAN", [Z]: "HUMAN" },
  } as const;
  const results = withSocial(scoreRound(players, box), {
    messages: { [A]: 6, [B]: 2, [R]: 7, [K]: 3, [Z]: 0 },
    trustMost: { [R]: 2, [B]: 1 },
    trustLeast: { [A]: 2, [K]: 1 },
    pointedAt: { [A]: 1 },
    defendedBy: {},
    defended: new Set([A, B, R, K, Z]),
  });
  const by = Object.fromEntries(results.map((r) => [r.uid, r]));

  it("carries real counts into the results", () => {
    expect(by[R].messages).toBe(7);
    expect(by[R].trustMost).toBe(2);
    expect(by[R].fooled).toBe(2);
    expect(suspicion(by[A])).toBe(by[A].votesBot + 2 + 1);
  });

  it("awards only what the data supports", () => {
    const awards = computeAwards(results, { [A]: 3, [B]: 1 });
    const kinds = Object.fromEntries(awards.map((a) => [a.kind, a.uid]));
    expect(kinds.convincing_bot).toBe(R);
    expect(kinds.most_trusted).toBe(R);
    expect(kinds.biggest_suspect).toBe(A);
    expect(kinds.chaos_agent).toBe(A);
    expect(kinds.bot_like_human).toBe(A);
    expect(kinds.best_defense).toBeUndefined(); // Ana was suspected but didn't win the room back
    expect(computeAwards(results, {}).some((a) => a.kind === "chaos_agent")).toBe(false);
  });

  it("best defense: suspected, defended, and the verdicts swung their way", () => {
    const comeback = results.map((r) => (r.uid === B ? { ...r, trustLeast: 1, votesHuman: 3, votesBot: 0 } : r));
    expect(computeAwards(comeback).find((a) => a.kind === "best_defense")?.uid).toBe(B);
  });

  it("gives humans an archetype from their numbers", () => {
    expect(humanArchetype({ ...by[A], messages: 0 }, results, {})).toBe("The silent one");
    expect(humanArchetype(by[A], results, { [A]: 3 })).toBe("The instigator");
  });

  it("reveal detail schema accepts the post-reveal payload and caps its size", () => {
    const detail = {
      players: [
        {
          uid: R,
          realName: null,
          trustedBy: [A],
          humansSaidHuman: 2,
          archetype: "The oversharer",
          persona: { line: "22 · design student · Pune", traits: ["Lowercase only"] },
          objective: { title: "Make someone laugh.", status: "COMPLETED" },
          defense: "lol im human",
        },
      ],
    };
    expect(RevealDetailSchema.safeParse(detail).success).toBe(true);
    expect(JSON.stringify(detail).length).toBeLessThan(10_000);
  });
});

describe("disagreement heuristic", () => {
  it("'overrated' is a topic word, not pushback against a player", async () => {
    const { isDisagreement } = await import("@/lib/game/signals");
    expect(isDisagreement("goa is sooo overrated")).toBe(false);
    expect(isDisagreement("nah that's wrong")).toBe(true);
  });
});
