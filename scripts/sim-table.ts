/**
 * End-to-end composition test against a running dev server and the real CometChat app.
 *
 *   npm run dev            (in another terminal)
 *   npm run sim -- 4       (4 humans + 2 bots; any of 1..6)
 *
 * Drives N "humans" through the public API exactly like browsers do (sessions, join, start,
 * advance), sends their chat/trust/defense/vote messages to CometChat (on their behalf, as the
 * SDK would), and checks seat filling, secrecy before reveal, and the final reveal.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { seal } from "../lib/game/sealed";
import { CUSTOM_TYPES, MAX_HUMANS, MAX_PLAYERS } from "../lib/game/types";
import * as cc from "../lib/server/cometchat";
import { openName, signSession } from "../lib/server/crypto";
import { isBotUid } from "../lib/server/room";

const BASE = process.env.SIM_BASE ?? "http://localhost:3000";
const N = Number(process.argv[2] ?? 3);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Human = { name: string; uid: string; token: string };

async function call<T>(path: string, token: string | null, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(`${path} → ${res.status} ${json.error}: ${json.message}`);
  return json;
}

function check(ok: boolean, label: string) {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) process.exitCode = 1;
}

type State = { phase: string; seq: number; roster: string[]; aliases: Record<string, string>; roundId: string; endsAt: number | null; reveal: unknown };

async function readState(guid: string): Promise<State> {
  const g = await cc.getGroup(guid);
  return (g?.metadata as { nab: State }).nab;
}

async function advance(guid: string, roomId: string, host: Human, action: string, extra: Record<string, unknown> = {}) {
  const s = await readState(guid);
  return call<{ state: State }>(`/api/rooms/${roomId}/advance`, host.token, { action, expectSeq: s.seq, ...extra });
}

async function waitPhase(guid: string, roomId: string, host: Human, phase: string, next: string) {
  for (let i = 0; i < 90; i++) {
    const s = await readState(guid);
    if (s.phase === phase) return s;
    if (s.endsAt && Date.now() > s.endsAt + 500) await advance(guid, roomId, host, next).catch(() => {});
    await sleep(1500);
  }
  throw new Error(`timed out waiting for ${phase}`);
}

async function main() {
  if (!(N >= 1 && N <= MAX_PLAYERS)) throw new Error("N must be 1..6");
  console.log(`\n=== ${N} human(s) + ${MAX_PLAYERS - N} bot(s) ===`);
  // Reuse sim identities across runs: the free CometChat plan allows only 100 users in total.
  const cacheFile = "scripts/.sim-users.json";
  const cache: Record<string, string> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
  // Adopt existing test accounts (by their sealed name) instead of creating new users.
  if (Object.keys(cache).length < N) {
    for (let page = 1; page <= 3; page++) {
      const { users, totalPages } = await cc.listUsers(page);
      for (const u of users) {
        const real = openName(u.metadata?.sn);
        if (real && /^Sim [A-Z]$/.test(real) && !cache[real] && !isBotUid(u.uid)) cache[real] = signSession(u.uid);
      }
      if (page >= totalPages) break;
    }
  }
  const humans: Human[] = [];
  for (let i = 0; i < N; i++) {
    const name = `Sim ${String.fromCharCode(65 + i)}`;
    const s = await call<{ uid: string; sessionToken: string }>("/api/session", null, { name, sessionToken: cache[name] });
    cache[name] = s.sessionToken;
    humans.push({ name, uid: s.uid, token: s.sessionToken });
  }
  writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  const host = humans[0];
  const { roomId } = await call<{ roomId: string }>("/api/rooms", host.token, {});
  const guid = `nab-${roomId}`;
  // Concurrent joins. A sixth human is refused: one seat always belongs to an AI.
  const joins = await Promise.allSettled(humans.slice(1).map((h) => call(`/api/rooms/${roomId}/join`, h.token, {})));
  const refused = joins.filter((j) => j.status === "rejected").length;
  check(refused === Math.max(0, N - MAX_HUMANS), `${Math.max(0, N - MAX_HUMANS)} join(s) refused (max ${MAX_HUMANS} humans)`);
  // Keep only the humans who actually got a seat (the race decides who was turned away).
  const seatedHumans = [host, ...humans.slice(1).filter((_, i) => joins[i].status === "fulfilled")];
  humans.splice(0, humans.length, ...seatedHumans);
  let members = await cc.listMembers(guid);
  check(members.length === humans.length && members.every((m) => !isBotUid(m.uid)), `lobby holds only the ${humans.length} humans (no early bots)`);
  check(members.every((m) => m.name === "Player"), "no real names on the wire: every CometChat name is 'Player'");

  await advance(guid, roomId, host, "start", { chatSeconds: 60 });
  const s = await readState(guid);
  members = await cc.listMembers(guid);
  const bots = s.roster.filter(isBotUid);
  check(s.roster.length === MAX_PLAYERS && members.length === MAX_PLAYERS, "table filled to 6 at start");
  check(bots.length === MAX_PLAYERS - humans.length && bots.length >= 1, `${MAX_PLAYERS - humans.length} bot(s) filled the empty seats (never zero)`);
  check(new Set(Object.values(s.aliases)).size === MAX_PLAYERS && humans.every((h) => s.aliases[h.uid]), "every seat has a unique alias");
  const json = JSON.stringify(s);
  check(!/isBot|persona|objective|"human"/i.test(json) && s.reveal === null, "public state before reveal has no identity data");
  check(!humans.every((h, i) => s.roster[i] === h.uid) || N === MAX_PLAYERS || N === 1, "humans are not simply seated first");

  // Chat as the humans (what the SDK would send).
  for (const h of humans) await cc.sendGroupText(guid, h.uid, `hi im ${s.aliases[h.uid]}, totally normal person`);
  const { key } = await call<{ key: string }>("/api/key", null);

  // Act as the host's browser: nudge the bot planner after new messages and during silences.
  const chatUntil = Date.now() + Number(process.env.SIM_CHAT_MS ?? 21_000);
  let seen = 0;
  let quietSince = Date.now();
  while (Date.now() < chatUntil) {
    const count = (await cc.listRecentGroupMessages(guid, { limit: 60, category: "message", type: "text" })).length;
    if (count > seen) {
      seen = count;
      quietSince = Date.now();
      await call("/api/bots/plan", host.token, { roomId, mode: "reply" }).catch(() => {});
    } else if (Date.now() - quietSince > 6_000) {
      quietSince = Date.now();
      await call("/api/bots/plan", host.token, { roomId, mode: "idle" }).catch(() => {});
    }
    await sleep(2_500);
  }
  if (process.env.SIM_TRANSCRIPT) {
    const st = await readState(guid);
    const msgs = await cc.listRecentGroupMessages(guid, { limit: 60, category: "message", type: "text" });
    console.log("--- transcript ---");
    for (const m of msgs) {
      if (m.sentAt * 1000 < (st as unknown as { roundStartedAt: number }).roundStartedAt) continue;
      console.log(`${(isBotUid(m.sender) ? "[bot] " : "[human] ") + (st.aliases[m.sender] ?? "?")}: ${m.data?.text}`);
    }
    console.log("---");
  }
  await advance(guid, roomId, host, "trust", { force: true });
  const trust = await waitPhase(guid, roomId, host, "TRUST", "trust");
  for (const h of humans) {
    const others = trust.roster.filter((u) => u !== h.uid);
    const payload = { roundId: trust.roundId, most: others[0], least: others[1] };
    await cc.sendGroupCustom(guid, h.uid, CUSTOM_TYPES.trust, { roundId: trust.roundId, sealed: await seal(payload, key) });
  }
  const def = await waitPhase(guid, roomId, host, "DEFENSE", "defense");
  for (const h of humans) await cc.sendGroupCustom(guid, h.uid, CUSTOM_TYPES.defense, { roundId: def.roundId, text: `${h.name} pleads human` });
  // A second defense must be ignored.
  await cc.sendGroupCustom(guid, host.uid, CUSTOM_TYPES.defense, { roundId: def.roundId, text: "second defense (must be ignored)" });
  const vote = await waitPhase(guid, roomId, host, "VOTE", "vote");
  for (const h of humans) {
    const ballots = Object.fromEntries(vote.roster.filter((u) => u !== h.uid).map((u) => [u, humans.some((x) => x.uid === u) ? "HUMAN" : "BOT"]));
    await cc.sendGroupCustom(guid, h.uid, CUSTOM_TYPES.vote, { roundId: vote.roundId, sealed: await seal({ roundId: vote.roundId, ballots }, key) });
  }
  // Stored ballots must be opaque.
  const stored = await cc.listRecentGroupMessages(guid, { limit: 20, category: "custom", type: CUSTOM_TYPES.vote });
  check(stored.length > 0 && stored.every((m) => !JSON.stringify(m.data?.customData).includes('"BOT"')), "stored ballots are sealed");

  const rev = await waitPhase(guid, roomId, host, "REVEAL", "reveal");
  const reveal = rev.reveal as { results: { uid: string; isBot: boolean; voted: boolean; defended: boolean; correctGuesses: number }[] };
  const res = reveal.results;
  check(res.length === MAX_PLAYERS, "reveal covers all 6 seats");
  check(res.filter((r) => !r.isBot).length === humans.length, `reveal shows ${humans.length} human(s)`);
  check(humans.every((h) => res.find((r) => r.uid === h.uid)?.voted), "every human's sealed vote was counted");
  check(humans.every((h) => res.find((r) => r.uid === h.uid)?.defended), "every human's defense was recorded");
  check(humans.every((h) => res.find((r) => r.uid === h.uid)?.correctGuesses === MAX_PLAYERS - 1), "perfect ballots scored perfectly");
  const detailMsg = (await cc.listRecentGroupMessages(guid, { limit: 3, category: "custom", type: CUSTOM_TYPES.reveal })).at(-1);
  const detail = (detailMsg?.data?.customData as { detail?: { players: { uid: string; realName: string | null; personaName: string | null; defense: string | null; objective: unknown }[] } })?.detail;
  check(!!detail && humans.every((h) => detail.players.find((p) => p.uid === h.uid)?.realName === h.name), "aliases unmask to real names at reveal");
  check(!!detail && detail.players.find((p) => p.uid === host.uid)?.defense === `${host.name} pleads human`, "first defense wins");
  check(!!detail && detail.players.filter((p) => p.objective).length === MAX_PLAYERS - humans.length, "every bot had a secret objective");
  check(!!detail && detail.players.filter((p) => p.personaName).length === MAX_PLAYERS - humans.length, "bots unmask to their AI persona");

  await advance(guid, roomId, host, "lobby");
  members = await cc.listMembers(guid);
  check(members.length === humans.length, "play again: bots leave, humans stay");
}

main().catch((e) => {
  console.error("SIM FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
