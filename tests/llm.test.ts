import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanModelText, humanize } from "@/lib/bots/humanize";
import { PERSONAS } from "@/lib/bots/personas";
import { BotPlanSchema, buildPrompt, chooseCandidates } from "@/lib/bots/planner";
import { moderateBotLine } from "@/lib/moderation";

function geminiReply(text: string) {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
}

describe("LLM response validation", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_COMETCHAT_APP_ID = "test";
    process.env.NEXT_PUBLIC_COMETCHAT_REGION = "us";
    process.env.COMETCHAT_REST_API_KEY = "k";
    process.env.SESSION_SECRET = "x".repeat(40);
    process.env.LLM_PROVIDER = "gemini";
    process.env.GEMINI_API_KEY = "test-key";
  });
  afterEach(() => vi.unstubAllGlobals());

  const req = { system: "s", user: "u", temperature: 1, maxOutputTokens: 50 };

  it("accepts valid JSON on the first try", async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiReply('{"replies":[{"bot":"riya","message":"lol same","thinkTimeMs":2000}]}'));
    vi.stubGlobal("fetch", fetchMock);
    const { generateStructured } = await import("@/lib/llm");
    const res = await generateStructured(req, BotPlanSchema);
    expect(res.ok && res.data.replies[0].message).toBe("lol same");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries once after invalid output, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(geminiReply('{"replies":"nope"}'))
      .mockResolvedValueOnce(geminiReply('```json\n{"replies":[]}\n```'));
    vi.stubGlobal("fetch", fetchMock);
    const { generateStructured } = await import("@/lib/llm");
    const res = await generateStructured(req, BotPlanSchema);
    expect(res).toMatchObject({ ok: true, attempts: 2 });
  });

  it("skips safely after two bad responses and never throws", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(geminiReply("not json at all")).mockRejectedValueOnce(new Error("network"));
    vi.stubGlobal("fetch", fetchMock);
    const { generateStructured } = await import("@/lib/llm");
    const res = await generateStructured(req, BotPlanSchema);
    expect(res.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports missing configuration instead of throwing", async () => {
    delete process.env.GEMINI_API_KEY;
    const { generateStructured } = await import("@/lib/llm");
    const res = await generateStructured(req, BotPlanSchema);
    expect(res.ok).toBe(false);
  });

  it("schema rejects overlong or extra replies", () => {
    expect(BotPlanSchema.safeParse({ replies: [{ bot: "x", message: "a".repeat(301) }] }).success).toBe(false);
    expect(BotPlanSchema.safeParse({ replies: Array(5).fill({ bot: "x", message: "hi" }) }).success).toBe(false);
  });
});

describe("bot humanizing + moderation", () => {
  const riya = PERSONAS.find((p) => p.key === "riya")!;
  const rohan = PERSONAS.find((p) => p.key === "rohan")!;

  it("removes em dashes, bullets and speaker prefixes", () => {
    expect(cleanModelText("riya: honestly — the paneer was cold.")).toBe("honestly, the paneer was cold.");
    expect(cleanModelText("- point one\n- point two")).toBe("point one point two");
  });

  it("applies the persona's casing and caps length", () => {
    const out = humanize("THE Paneer Was Cold And Rubbery And Honestly I Still Think About It Every Single Day Of My Life", riya, () => 0.99);
    expect(out?.text).toBe(out?.text.toLowerCase());
    expect(out!.text.split(" ").length).toBeLessThanOrEqual(14);
    expect(humanize("Fair point.", rohan, () => 0.99)?.text).toBe("Fair point.");
  });

  it("injects a typo and optional correction deterministically", () => {
    const out = humanize("that biryani was terrible", riya, () => 0.01);
    expect(out?.text).not.toBe("that biryani was terrible");
    expect(out?.correction).toMatch(/^\*/);
  });

  it("blocks AI self-disclosure, slurs and sexual content; allows normal chat", () => {
    expect(moderateBotLine("as an AI I can't eat").ok).toBe(false);
    expect(moderateBotLine("lol im not a bot, YOU are").ok).toBe(true);
    expect(moderateBotLine("send nudes").ok).toBe(false);
    expect(moderateBotLine("you r3tard").ok).toBe(false);
    expect(moderateBotLine("I live in Essex, the document is fine").ok).toBe(true);
    expect(moderateBotLine("").ok).toBe(false);
  });

  it("chooses addressed bots first and never more than three candidates", () => {
    const bots = PERSONAS.slice(0, 6).map((persona, i) => ({ uid: `p-${i}`, persona }));
    const { candidates } = chooseCandidates(bots, [{ name: "ana", text: "kabir what do you think" }], "reply", () => 0.5);
    expect(candidates[0].persona.key).toBe("kabir");
    expect(candidates.length).toBeLessThanOrEqual(3);
  });

  it("prompt lists only the candidate ids", () => {
    const bots = PERSONAS.slice(0, 2).map((persona, i) => ({ uid: `p-${i}`, persona }));
    const { system } = buildPrompt({ topic: "t", secondsLeft: 60, lines: [], candidates: bots, maxReplies: 1, mode: "opener" });
    expect(system).toContain('id "riya"');
    expect(system).not.toContain('id "meghna"');
  });
});

describe("moderation: game-mechanics tells", () => {
  it("drops lines that leak prompts or secret objectives", () => {
    expect(moderateBotLine("bro answer the prompt rn").ok).toBe(false);
    expect(moderateBotLine("my objective is to make you laugh").ok).toBe(false);
    expect(moderateBotLine("my side goal today is maggi").ok).toBe(false);
    expect(moderateBotLine("prompt delivery matters at weddings").ok).toBe(true);
  });
});
