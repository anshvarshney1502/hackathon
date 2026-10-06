import "server-only";
import { after } from "next/server";
import { randomInt } from "node:crypto";
import { commitmentInput } from "@/lib/game/commitment";
import { randomId } from "@/lib/game/ids";
import { transition } from "@/lib/game/machine";
import { assignAliases, composeTable } from "@/lib/game/seating";
import { topicForRound } from "@/lib/game/topics";
import {
  CUSTOM_TYPES,
  DefenseEventSchema,
  type GameState,
  type RevealDetail,
  TrustEventSchema,
  type ChatDurationSchema,
} from "@/lib/game/types";
import type { z } from "zod";
import { castBotDefenses, castBotTrust, castBotVotes, runChatTick } from "./bots";
import * as cc from "./cometchat";
import { roundSalt, sha256Hex } from "./crypto";
import { HttpError } from "./http";
import { buildReveal } from "./reveal";
import { botMembers, botPool, humanMembers, isBotUid, loadRoom, type RoomSnapshot, saveIfUnchanged, serverHost } from "./room";
import { collectRound, collectSealed } from "./round";

export type AdvanceRequest =
  | { action: "start"; expectSeq: number; chatSeconds: z.infer<typeof ChatDurationSchema> }
  | { action: "trust"; expectSeq: number; force?: boolean }
  | { action: "defense"; expectSeq: number }
  | { action: "vote"; expectSeq: number }
  | { action: "reveal"; expectSeq: number }
  | { action: "lobby"; expectSeq: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function publishPhase(guid: string, asUid: string, state: GameState): Promise<void> {
  await cc.sendGroupCustom(guid, asUid, CUSTOM_TYPES.phase, {
    seq: state.seq,
    phase: state.phase,
    roundId: state.roundId,
    endsAt: state.endsAt,
  });
}

async function kickRoundBots(room: RoomSnapshot): Promise<void> {
  for (const bot of botMembers(room.members)) await cc.kickMember(room.guid, bot.uid);
}

export async function advance(guid: string, caller: string, req: AdvanceRequest): Promise<GameState> {
  const room = await loadRoom(guid);
  if (!room) throw new HttpError(404, "not_found", "Room not found");
  const me = room.members.find((m) => m.uid === caller);
  if (!me || isBotUid(caller)) throw new HttpError(403, "not_member", "You are not seated in this room");
  if (room.state.seq !== req.expectSeq) {
    // Somebody else already moved the game on. Idempotent: return the current state.
    return room.state;
  }

  // Structural moves need the host. Time-driven moves can come from any seated human:
  // the server enforces the clock, so a stale host can't stall the game.
  const host = serverHost(room.members);
  const isHost = host === null || host === caller;
  if ((req.action === "start" || req.action === "lobby" || (req.action === "trust" && req.force)) && !isHost) {
    throw new HttpError(403, "not_host", "Only the host can do that");
  }

  const now = Date.now();
  let next: GameState;
  let detail: RevealDetail | null = null;
  // Everyone still seated has submitted → the phase may end early.
  const present = new Set(room.members.map((m) => m.uid));
  const everyone = (done: Record<string, unknown>) =>
    room.state.roster.filter((uid) => present.has(uid)).every((uid) => uid in done);

  switch (req.action) {
    case "start": {
      // Seats fill now, never earlier: humans had the whole lobby to invite friends.
      if (room.state.phase === "REVEAL") await kickRoundBots(room);
      const humans = humanMembers(room.members);
      const random = () => randomInt(0, 2 ** 32) / 2 ** 32;
      const table = composeTable(humans, botPool(), random);
      await cc.addParticipants(guid, table.newBots.map((b) => b.uid));
      const botUids = table.roster.filter(isBotUid);
      const roundId = randomId(10);
      const commitment = sha256Hex(commitmentInput(roundId, botUids, roundSalt(roundId)));
      const res = transition(
        room.state,
        {
          type: "start",
          roundId,
          topic: topicForRound(guid, room.state.round + 1),
          commitment,
          roster: table.roster,
          aliases: assignAliases(table.roster, random),
          chatSeconds: req.chatSeconds,
        },
        now,
      );
      if (!res.ok) throw new HttpError(409, res.code, res.message);
      next = res.state;
      break;
    }
    case "trust": {
      const res = transition(room.state, { type: "trust", force: req.force }, now);
      if (!res.ok) throw new HttpError(409, res.code, res.message);
      next = res.state;
      break;
    }
    case "defense": {
      const trusted = await collectSealed(guid, room.state, CUSTOM_TYPES.trust, TrustEventSchema, { since: room.state.phaseStartedAt });
      const res = transition(room.state, { type: "defense", allDone: everyone(trusted) }, now);
      if (!res.ok) throw new HttpError(409, res.code, res.message);
      next = res.state;
      break;
    }
    case "vote": {
      const defended = await collectRound(guid, room.state, CUSTOM_TYPES.defense, DefenseEventSchema, "first", room.state.phaseStartedAt);
      const res = transition(room.state, { type: "vote", allDone: everyone(defended) }, now);
      if (!res.ok) throw new HttpError(409, res.code, res.message);
      next = res.state;
      break;
    }
    case "reveal": {
      const built = await buildReveal(room, now);
      const res = transition(room.state, { type: "reveal", reveal: built.reveal, allVoted: built.allVoted }, now);
      if (!res.ok) throw new HttpError(409, res.code, res.message);
      next = res.state;
      detail = built.detail;
      break;
    }
    case "lobby": {
      await kickRoundBots(room);
      const res = transition(room.state, { type: "lobby" }, now);
      if (!res.ok) throw new HttpError(409, res.code, res.message);
      next = res.state;
      break;
    }
  }

  if (!(await saveIfUnchanged(guid, room.state.seq, next))) {
    // An event pulse or another caller wrote first. Report the state that won.
    return (await loadRoom(guid))?.state ?? room.state;
  }
  await publishPhase(guid, caller, next);
  if (next.phase === "REVEAL" && next.reveal) {
    // Personas, objectives and defenses ride in the message (metadata is capped at 5 KB).
    await cc.sendGroupCustom(guid, caller, CUSTOM_TYPES.reveal, { seq: next.seq, roundId: next.reveal.roundId, detail });
  }

  // Background work runs after the response, bounded by the route's maxDuration.
  if (next.phase === "CHAT") {
    after(async () => {
      await sleep(4_000 + Math.random() * 4_000);
      const outcome = await runChatTick(guid, "opener").catch(() => "error");
      console.info(`[bots] ${guid} opener → ${outcome}`);
    });
  } else if (next.phase === "TRUST") {
    after(() => castBotTrust(guid, next).catch((e: unknown) => console.warn("[bots] trust failed:", e)));
  } else if (next.phase === "DEFENSE") {
    after(() => castBotDefenses(guid, next).catch((e: unknown) => console.warn("[bots] defenses failed:", e)));
  } else if (next.phase === "VOTE") {
    after(() => castBotVotes(guid, next).catch((e: unknown) => console.warn("[bots] votes failed:", e)));
  }
  return next;
}
