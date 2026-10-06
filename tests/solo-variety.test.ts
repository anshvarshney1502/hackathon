import { describe, expect, it } from "vitest";
import { tooSimilar } from "@/lib/bots/humanize";
import { PERSONAS } from "@/lib/bots/personas";
import { applyTemperament, ballotsFromView, rollTemperament, socialView, trustFromView } from "@/lib/bots/temperament";
import { planEvents } from "@/lib/game/events";
import { seededRandom } from "@/lib/game/rng";
import { assignAliases, composeTable } from "@/lib/game/seating";
import { socialSignals } from "@/lib/game/signals";

const bots = ["p-aaaaaaaaaaab", "p-aaaaaaaaaaac", "p-aaaaaaaaaaad", "p-aaaaaaaaaaae", "p-aaaaaaaaaaaf"];
const human = "p-hhhhhhhhhhhh";
const roster = [human, ...bots];

describe("solo case variety", () => {
  it("the five bots in one case get clearly different temperaments", () => {
    const ts = bots.map((u) => rollTemperament("case-1", u));
    const spread = (k: "talk" | "aggression" | "sociability" | "suspicion") =>
      Math.max(...ts.map((t) => t[k])) - Math.min(...ts.map((t) => t[k]));
    for (const k of ["talk", "aggression", "sociability", "suspicion"] as const) expect(spread(k)).toBeGreaterThan(0.25);
    expect(new Set(ts.map((t) => t.label)).size).toBeGreaterThanOrEqual(3);
  });

  it("the same bot behaves differently in a different case", () => {
    const a = rollTemperament("case-1", bots[0]);
    const b = rollTemperament("case-2", bots[0]);
    expect(a).not.toEqual(b);
  });

  it("temperament changes behaviour, not voice", () => {
    const p = PERSONAS[0];
    const t = rollTemperament("case-3", bots[0]);
    const played = applyTemperament(p, t);
    expect(played.typingStyle).toBe(p.typingStyle);
    expect(played.talkativeness).toBe(t.talk);
    expect(played.length).toBe(t.verbosity);
  });

  it("names, seats and composition shuffle between cases", () => {
    const pool = PERSONAS.map((p, i) => ({ uid: `p-pp${"abcdefghjkmn"[i]}`.padEnd(14, "a"), name: p.name }));
    const one = composeTable([{ uid: human, name: "Me" }], pool, seededRandom("c1"));
    const two = composeTable([{ uid: human, name: "Me" }], pool, seededRandom("c2"));
    expect(one.roster).not.toEqual(two.roster);
    const aliasA = assignAliases(roster, seededRandom("c1"))[human];
    const humanNames = new Set(Array.from({ length: 12 }, (_, i) => assignAliases(roster, seededRandom(`n${i}`))[human]));
    expect(humanNames.size).toBeGreaterThan(4);
    expect(typeof aliasA).toBe("string");
  });

  it("events vary between cases", () => {
    const seqs = new Set(Array.from({ length: 20 }, (_, i) => planEvents(`case${i}`, 180, 6).map((e) => e.type).join(",")));
    expect(seqs.size).toBeGreaterThan(8);
  });
});

describe("independent bot judgement", () => {
  const sig = socialSignals([{ uid: human, name: "Nina", text: "hey all" }], roster.map((uid, i) => ({ uid, name: `P${i}` })));

  it("bots don't all suspect the same player", () => {
    const suspects = new Set(bots.map((b) => socialView(b, roster, sig, rollTemperament("case-9", b), "case-9").mostSuspected));
    expect(suspects.size).toBeGreaterThanOrEqual(2);
  });

  it("trust picks are two different people, never yourself", () => {
    for (const b of bots) {
      const t = trustFromView(socialView(b, roster, sig, rollTemperament("case-9", b), "case-9"));
      expect(t && t.most !== t.least && t.most !== b && t.least !== b).toBe(true);
    }
  });

  it("ballots differ across bots and never include the voter", () => {
    const ballots = bots.map((b) => ballotsFromView(socialView(b, roster, sig, rollTemperament("case-9", b), "case-9"), seededRandom(b)));
    expect(new Set(ballots.map((x) => JSON.stringify(x))).size).toBeGreaterThan(1);
    ballots.forEach((x, i) => expect(x[bots[i]]).toBeUndefined());
  });

  it("an accusation raises that bot's suspicion of the accuser more when it's aggressive", () => {
    const s2 = socialSignals(
      [{ uid: human, name: "Nina", text: "P1 is definitely a bot" }],
      roster.map((uid, i) => ({ uid, name: `P${i}` })),
    );
    const calm = { ...rollTemperament("x", bots[0]), aggression: 0 };
    const hot = { ...calm, aggression: 1 };
    expect(socialView(bots[0], roster, s2, hot, "x").suspicion[human]).toBeGreaterThan(socialView(bots[0], roster, s2, calm, "x").suspicion[human]);
  });
});

describe("no repeats", () => {
  it("catches restated opinions but allows new ones", () => {
    expect(tooSimilar("brunch is such a scam honestly", "honestly brunch is a scam")).toBe(true);
    expect(tooSimilar("brunch is such a scam honestly", "wait who here actually likes karaoke")).toBe(false);
  });
});

describe("natural cut-offs", () => {
  it("never leaves a message hanging on a conjunction", async () => {
    const { capWords } = await import("@/lib/bots/humanize");
    const out = capWords("instant coffee is elite and honestly you guys are all just snobs about it when you", 6);
    expect(out).not.toMatch(/\b(and|when|you)$/);
    expect(capWords("short line", 6)).toBe("short line");
  });
});
