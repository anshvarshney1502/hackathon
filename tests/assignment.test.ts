import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { pickBots } from "@/lib/bots/assign";
import { PERSONAS } from "@/lib/bots/personas";
import { commitmentInput, verifyCommitment } from "@/lib/game/commitment";
import { PlayerUidSchema } from "@/lib/game/ids";

function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

const pool = PERSONAS.map((p, i) => ({ uid: `p-pool${String(i).padStart(8, "x")}`, name: p.name }));

describe("bot assignment", () => {
  it("fills exactly the needed seats with distinct, unseated bots", () => {
    const seated = [{ uid: "p-humanhumanhu", name: "Ana" }, { uid: pool[0].uid, name: pool[0].name }];
    const picked = pickBots(pool, seated, 4, seeded(1));
    expect(picked).toHaveLength(4);
    expect(new Set(picked.map((b) => b.uid)).size).toBe(4);
    expect(picked.some((b) => b.uid === pool[0].uid)).toBe(false);
  });

  it("never seats a bot whose first name matches a seated player", () => {
    const seated = [{ uid: "p-humanhumanhu", name: "Riya" }];
    for (let s = 0; s < 20; s++) {
      const picked = pickBots(pool, seated, 11, seeded(s));
      expect(picked.some((b) => b.name.toLowerCase() === "riya")).toBe(false);
    }
  });

  it("returns fewer when the pool runs out and nothing when none are needed", () => {
    expect(pickBots(pool, [], 0)).toEqual([]);
    expect(pickBots(pool.slice(0, 2), [], 5)).toHaveLength(2);
  });

  it("is randomised (different seeds, different tables)", () => {
    const a = pickBots(pool, [], 5, seeded(1)).map((b) => b.uid).join();
    const b = pickBots(pool, [], 5, seeded(99)).map((b) => b.uid).join();
    expect(a).not.toBe(b);
  });
});

describe("bot uid derivation", () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_COMETCHAT_APP_ID = "test";
    process.env.NEXT_PUBLIC_COMETCHAT_REGION = "us";
    process.env.COMETCHAT_REST_API_KEY = "k";
    process.env.SESSION_SECRET = "x".repeat(40);
  });

  it("bot uids are stable and look exactly like human uids", async () => {
    const { botUidForIndex } = await import("@/lib/server/crypto");
    const uids = PERSONAS.map((_, i) => botUidForIndex(i));
    expect(uids.every((u) => PlayerUidSchema.safeParse(u).success)).toBe(true);
    expect(new Set(uids).size).toBe(uids.length);
    expect(botUidForIndex(3)).toBe(botUidForIndex(3));
  });

  it("session tokens round-trip and reject tampering", async () => {
    const { signSession, verifySession } = await import("@/lib/server/crypto");
    const t = signSession("p-aaaaaaaaaaaa");
    expect(verifySession(t)).toBe("p-aaaaaaaaaaaa");
    const [payload, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ uid: "p-bbbbbbbbbbbb", iat: Date.now() })).toString("base64url");
    expect(verifySession(`${forged}.${sig}`)).toBeNull();
    expect(verifySession(`${payload}.AAAA`)).toBeNull();
    expect(verifySession(t, Date.now() + 31 * 24 * 3600 * 1000)).toBeNull();
  });
});

describe("roster commitment", () => {
  const bots = ["p-bbbbbbbbbbbb", "p-aaaaaaaaaaaa"];
  const commit = createHash("sha256").update(commitmentInput("r1", bots, "salt")).digest("hex");

  it("is order independent", () => {
    expect(commitmentInput("r1", bots, "s")).toBe(commitmentInput("r1", [...bots].reverse(), "s"));
  });

  it("verifies the honest reveal (web crypto matches node crypto)", async () => {
    expect(await verifyCommitment(commit, "r1", bots, "salt")).toBe(true);
  });

  it("detects a swapped roster, salt or round", async () => {
    expect(await verifyCommitment(commit, "r1", ["p-aaaaaaaaaaaa"], "salt")).toBe(false);
    expect(await verifyCommitment(commit, "r1", bots, "other")).toBe(false);
    expect(await verifyCommitment(commit, "r2", bots, "salt")).toBe(false);
  });
});
