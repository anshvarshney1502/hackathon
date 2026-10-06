import { describe, expect, it } from "vitest";
import { findContradiction, findMemoryCue } from "@/lib/game/evidence";
import { buildEvent, EVENT_SPECS, planEvents } from "@/lib/game/events";
import { buildRecap } from "@/lib/game/recap";
import { seededRandom } from "@/lib/game/rng";
import { scoreRound } from "@/lib/game/scoring";
import { ActiveEventSchema } from "@/lib/game/types";

const L = (uid: string, name: string, text: string) => ({ uid, name, text });

describe("contradiction detection (deterministic, never invented)", () => {
  it("finds a real love/hate flip by the same player", () => {
    const c = findContradiction([
      L("a", "Omar", "i hate travelling honestly"),
      L("b", "Nina", "lol same"),
      L("a", "Omar", "i love travelling to new countries tho"),
    ]);
    expect(c).toMatchObject({ uid: "a", name: "Omar" });
    expect(c?.earlier).toContain("hate travelling");
  });

  it("does not claim a contradiction across different players, subjects or mixed lines", () => {
    expect(findContradiction([L("a", "O", "i hate travelling"), L("b", "N", "i love travelling")])).toBeNull();
    expect(findContradiction([L("a", "O", "i hate travelling"), L("a", "O", "i love biryani")])).toBeNull();
    expect(findContradiction([L("a", "O", "i love it but i hate it"), L("a", "O", "i hate it")])).toBeNull();
    expect(findContradiction([L("a", "O", "i love travelling"), L("a", "O", "i love travelling")])).toBeNull();
  });
});

describe("memory check cue", () => {
  it("picks a word only one player said, skipping the topic and filler", () => {
    const cue = findMemoryCue(
      [
        L("a", "Nina", "interstellar made me cry"),
        L("b", "Omar", "honestly weddings are overrated"),
        L("c", "Esha", "really really really"),
        L("a", "Nina", "ok"),
        L("b", "Omar", "ok"),
        L("c", "Esha", "ok"),
      ],
      "worst food at weddings",
      seededRandom("m"),
    );
    expect(cue?.word).toBe("interstellar");
    expect(cue?.uid).toBe("a");
  });

  it("returns null when nothing distinctive was said", () => {
    expect(findMemoryCue([L("a", "N", "ok"), L("b", "O", "lol")], "t", seededRandom("m"))).toBeNull();
  });
});

describe("expanded interrogation events", () => {
  const roster = ["p-aaaaaaaaaaaa", "p-bbbbbbbbbbbb", "p-cccccccccccc"].map((uid, i) => ({ uid, name: ["Nina", "Omar", "Esha"][i] }));

  it("every round gets at least one event; evidence events never take the first slot", () => {
    for (let i = 0; i < 300; i++) {
      const plan = planEvents(`s${i}`, [60, 120, 180, 300][i % 4], 6);
      expect(plan.length).toBeGreaterThanOrEqual(1);
      expect(EVENT_SPECS[plan[0].type].needsEvidence).toBeFalsy();
    }
  });

  it("cross-examination has a distinct examiner and target", () => {
    for (let i = 0; i < 20; i++) {
      const e = buildEvent("CROSS_EXAM", `s${i}`, 0, 0, roster, "t");
      expect(e.examinerUid).not.toBeNull();
      expect(e.examinerUid).not.toBe(e.targetUid);
      expect(ActiveEventSchema.safeParse(e).success).toBe(true);
    }
  });

  it("contradiction events carry the quoted evidence and target the speaker", () => {
    const e = buildEvent("CONTRADICTION", "s", 1, 0, roster, "t", {
      contradiction: { uid: roster[1].uid, name: "Omar", earlier: "i hate travelling", later: "i love travelling" },
    });
    expect(e.targetUid).toBe(roster[1].uid);
    expect(e.evidence).toEqual(['Earlier: "i hate travelling"', 'Later: "i love travelling"']);
  });

  it("hot seat names the target and asks a concrete question", () => {
    const e = buildEvent("HOT_SEAT", "s", 0, 0, roster, "t");
    expect(e.prompt).toMatch(/you're up\./);
  });
});

describe("composition-aware recap", () => {
  const H = "p-hhhhhhhhhhhh";
  const bots = ["p-bbbbbbbbbbbb", "p-cccccccccccc"];
  const players = [{ uid: H, name: "Nina", isBot: false }, ...bots.map((uid, i) => ({ uid, name: `B${i}`, isBot: true }))];

  it("a solo case never shows human-vs-human stats", () => {
    const results = scoreRound(players, { [H]: { [bots[0]]: "BOT", [bots[1]]: "HUMAN" } });
    const r = buildRecap({ results, awards: [{ kind: "bot_like_human", uid: H, detail: "" }], detail: null });
    expect(r.kind).toBe("SOLO");
    expect(r.rows.some(([k]) => k === "Most bot-like human")).toBe(false);
    expect(r.rows).toContainEqual(["Bots correctly identified", "1 / 2"]);
  });

  it("multiplayer shows the full social recap", () => {
    const two = [...players, { uid: "p-gggggggggggg", name: "Omar", isBot: false }];
    const r = buildRecap({ results: scoreRound(two, {}), awards: [], detail: null });
    expect(r.kind).toBe("SOCIAL");
    expect(r.rows[0]).toEqual(["Humans", "2"]);
  });
});
