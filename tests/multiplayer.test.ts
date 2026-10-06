import { beforeAll, describe, expect, it } from "vitest";
import { PERSONAS } from "@/lib/bots/personas";
import { applyCustom, initial, type State } from "@/lib/client/roomState";
import { electHost } from "@/lib/game/host";
import { transition } from "@/lib/game/machine";
import { roundMemory } from "@/lib/game/memory";
import { seededRandom } from "@/lib/game/rng";
import { seal } from "@/lib/game/sealed";
import { ALIAS_POOL, assignAliases, composeTable } from "@/lib/game/seating";
import { socialSignals, type Line } from "@/lib/game/signals";
import { botTrustPick } from "@/lib/game/trust";
import { CUSTOM_TYPES, type GameState, GameStateSchema, initialGameState, MAX_PLAYERS } from "@/lib/game/types";

const L = "abcdefghjkmnpq";
/** Valid player uids (the uid alphabet has no 0/o/1/l/i). */
const uid = (prefix: string, i: number) => `p-${prefix}${L[i]}`.padEnd(14, "a");
const pool = PERSONAS.map((p, i) => ({ uid: uid("bt", i), name: p.name }));
const humansN = (n: number) => Array.from({ length: n }, (_, i) => ({ uid: uid("fr", i), name: `Friend${i}` }));

beforeAll(() => {
  process.env.NEXT_PUBLIC_COMETCHAT_APP_ID = "test";
  process.env.NEXT_PUBLIC_COMETCHAT_REGION = "us";
  process.env.COMETCHAT_REST_API_KEY = "k";
  process.env.SESSION_SECRET = "s".repeat(48);
});

/* ------------------------------------------------------------------ seat filling */

describe("seat filling and composition", () => {
  for (let n = 1; n <= MAX_PLAYERS - 1; n++) {
    it(`${n} human${n > 1 ? "s" : ""} + ${MAX_PLAYERS - n} bots → a full, shuffled table`, () => {
      const t = composeTable(humansN(n), pool, seededRandom(`table${n}`));
      expect(t.roster).toHaveLength(MAX_PLAYERS);
      expect(new Set(t.roster).size).toBe(MAX_PLAYERS);
      expect(t.newBots).toHaveLength(MAX_PLAYERS - n);
      expect(t.solo).toBe(n === 1);
      for (const h of humansN(n)) expect(t.roster).toContain(h.uid);
    });
  }

  it("seat order carries no information: humans are not simply seated first", () => {
    let humansFirst = 0;
    for (let i = 0; i < 200; i++) {
      const t = composeTable(humansN(3), pool, seededRandom(`order${i}`));
      if (t.roster.slice(0, 3).every((u) => u.startsWith("p-fr"))) humansFirst++;
    }
    // Uniform shuffle: P(first three are the humans) = 1/20 → about 10 of 200.
    expect(humansFirst).toBeLessThan(30);
  });

  it("always keeps at least one AI seat: six (or seven) humans still get one bot", () => {
    for (const n of [6, 7]) {
      const t = composeTable(humansN(n), pool, seededRandom(`x${n}`));
      expect(t.roster).toHaveLength(MAX_PLAYERS);
      expect(t.newBots).toHaveLength(1);
    }
  });
});

/* ------------------------------------------------------------------ hidden identity */

describe("hidden identity", () => {
  const roster = composeTable(humansN(2), pool, seededRandom("id")).roster;
  const aliases = assignAliases(roster, seededRandom("aliases"));

  it("every seat gets a unique alias from the pool, never a persona name", () => {
    const names = Object.values(aliases);
    expect(new Set(names).size).toBe(roster.length);
    const personaNames = new Set(PERSONAS.map((p) => p.name.toLowerCase()));
    for (const n of names) {
      expect(ALIAS_POOL).toContain(n);
      expect(personaNames.has(n.toLowerCase())).toBe(false);
    }
  });

  it("public game state during a round says nothing about who is a bot", () => {
    const res = transition(
      initialGameState(0),
      { type: "start", roundId: "r1", topic: "t", commitment: "c".repeat(64), roster, aliases, chatSeconds: 180 },
      0,
    );
    if (!res.ok) throw new Error();
    const json = JSON.stringify(res.state);
    expect(json).not.toMatch(/isBot|"bot"|human|persona|objective|playerType/i);
    for (const p of PERSONAS) expect(json.toLowerCase()).not.toContain(`"${p.name.toLowerCase()}"`);
    expect(GameStateSchema.safeParse(res.state).success).toBe(true);
  });
});

/* ------------------------------------------------------------------ sealed ballots */

describe("sealed ballots", () => {
  it("round-trips a vote sealed in WebCrypto and opened by the server", async () => {
    const { ballotPublicKey, openSealed } = await import("@/lib/server/ballots");
    const payload = { roundId: "r1", ballots: { "p-aaaaaaaaaaaa": "BOT" } };
    const box = await seal(payload, ballotPublicKey());
    expect(JSON.stringify(box)).not.toContain("BOT");
    expect(await openSealed(box)).toEqual(payload);
  });

  it("rejects tampered boxes and boxes sealed to another key", async () => {
    const { ballotPublicKey, openSealed } = await import("@/lib/server/ballots");
    const box = await seal({ roundId: "r1", most: "a" }, ballotPublicKey());
    const flipped = { ...box, ct: box.ct.slice(0, -2) + (box.ct.endsWith("A") ? "BB" : "AA") };
    expect(await openSealed(flipped)).toBeNull();
    const other = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", other.publicKey));
    const otherKey = btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await openSealed(await seal({ roundId: "r1" }, otherKey))).toBeNull();
  });
});

/* ------------------------------------------------------------------ memory, bluffs, adaptation */

describe("bot memory and human bluffs", () => {
  const roster = [
    { uid: "A", name: "kavya" },
    { uid: "B", name: "Mo" },
    { uid: "C", name: "Rhea" },
  ];
  const lines: Line[] = [
    { uid: "A", name: "kavya", text: "i'm from Jaipur btw" },
    { uid: "B", name: "Mo", text: "kavya is 100% a bot" },
    { uid: "C", name: "Rhea", text: "nah kavya is definitely human" },
    { uid: "A", name: "kavya", text: "ok fine i'm literally a bot lol" },
  ];
  const sig = socialSignals(lines, roster);

  it("remembers self-disclosures and who accused or vouched for whom", () => {
    const m = roundMemory("C", lines, sig, new Map(roster.map((p) => [p.uid, p.name])));
    expect(m.facts.join(" ")).toContain("Jaipur");
    expect(m.dynamics.join(" | ")).toContain("Mo called kavya a bot");
    expect(m.dynamics.join(" | ")).toContain("you vouched for kavya");
    expect(m.dynamics.join(" | ")).toContain("kavya claimed to be a bot");
  });

  it("a human bluffing 'I'm literally a bot' is not read as accusing someone else", () => {
    expect(sig.selfClaims.A).toBe(1);
    expect(sig.accusations.A).toBeUndefined();
    expect(sig.vouches.C?.A).toBe(1);
    expect(sig.accusations.C).toBeUndefined();
  });

  it("vouching makes the vouched-for player trust the voucher", () => {
    const pick = botTrustPick("A", ["A", "B", "C"], sig, 0.5, seededRandom("t"));
    expect(pick).toEqual({ most: "C", least: "B" });
  });
});

/* ------------------------------------------------------------------ reconnect restoration */

describe("reconnect: rebuilding round state from history", () => {
  const me = "p-meeeeeeeeeee";
  const game: GameState = { ...initialGameState(0), phase: "VOTE", roundId: "r9", roster: [me, "p-otherotherot"] };
  const base: State = { ...initial, me: { uid: me, name: "Me" }, game };
  const env = { roundId: "r9", sealed: { epk: "x".repeat(87), iv: "abcdefghijklmnop", ct: "ciphertextciphertext" } };

  it("restores who submitted (never what), my locked defense and the reveal detail", () => {
    const s = [
      { type: CUSTOM_TYPES.trust, uid: me, data: env, at: 1 },
      { type: CUSTOM_TYPES.vote, uid: "p-otherotherot", data: env, at: 2 },
      { type: CUSTOM_TYPES.defense, uid: me, data: { roundId: "r9", text: "i'm human, promise" }, at: 3 },
      { type: CUSTOM_TYPES.defense, uid: me, data: { roundId: "r9", text: "second try" }, at: 4 },
      { type: CUSTOM_TYPES.pick, uid: me, data: { ...env, eventId: "e1" }, at: 5 },
      { type: CUSTOM_TYPES.vote, uid: me, data: { ...env, roundId: "old-round" }, at: 6 },
    ].reduce(applyCustom, base);
    expect(s.trusted[me]).toBe(true);
    expect(s.voted["p-otherotherot"]).toBe(true);
    expect(s.voted[me]).toBeUndefined(); // stale round ignored
    expect(s.defenses[me].text).toBe("i'm human, promise"); // first defense wins
    expect(s.defenseStatus).toBe("locked");
    expect(s.picked.e1[me]).toBe(true);
  });

  it("ignores malformed or plaintext ballots", () => {
    const s = applyCustom(base, { type: CUSTOM_TYPES.vote, uid: "p-otherotherot", data: { roundId: "r9", ballots: {} }, at: 1 });
    expect(s.voted["p-otherotherot"]).toBeUndefined();
  });

  it("host handoff skips departed players deterministically", () => {
    expect(electHost([{ uid: "p-a", joinedAt: 1, online: false }, { uid: "p-b", joinedAt: 2, online: true }, { uid: "p-c", joinedAt: 3, online: true }])).toBe("p-b");
  });
});
