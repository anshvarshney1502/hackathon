import { z } from "zod";
import { DisplayNameSchema, guidForRoom, randomId, RoomIdSchema } from "@/lib/game/ids";
import * as cc from "@/lib/server/cometchat";
import { NEUTRAL_NAME, openName, sealName, signSession, verifySession } from "@/lib/server/crypto";
import { clientIp, handleError, HttpError, json, parseBody, rateLimit } from "@/lib/server/http";
import { isBotUid, parseState, saveIfUnchanged } from "@/lib/server/room";

const BodySchema = z.object({
  name: DisplayNameSchema,
  sessionToken: z.string().max(512).optional(),
  /** The case the player is trying to enter, so a failure can be reported to its host. */
  roomId: RoomIdSchema.optional(),
});

/** Tell the host's lobby that an invitee was turned away, instead of failing silently. */
async function reportJoinFailure(roomId: string): Promise<void> {
  const guid = guidForRoom(roomId);
  const group = await cc.getGroup(guid);
  if (!group) return;
  const state = parseState(group.metadata, Date.now());
  if (state.phase !== "LOBBY") return;
  const prev = state.lobbyNotice;
  const next = { ...state, lobbyNotice: { reason: "player_limit" as const, at: Date.now(), count: (prev?.count ?? 0) + 1 } };
  await saveIfUnchanged(guid, state.seq, next);
}

/**
 * Create-or-reuse a CometChat user and mint a short-lived Auth Token for the SDK.
 * The REST API key never leaves the server. The returned sessionToken proves
 * ownership of the uid on later calls, so nobody can claim another player's uid.
 */
export async function POST(req: Request) {
  let roomId: string | undefined;
  try {
    rateLimit(`session:${clientIp(req)}`, 10, 0.2);
    const body = await parseBody(req, BodySchema);
    const { name, sessionToken } = body;
    roomId = body.roomId;

    let uid = verifySession(sessionToken);
    if (uid && isBotUid(uid)) throw new HttpError(403, "forbidden", "Not allowed");

    // The real name never becomes a CometChat display name: everyone is "Player" on the wire,
    // and the real name is stored sealed in user metadata until the reveal.
    const metadata = { sn: sealName(name) };
    if (uid) {
      const existing = await cc.getUser(uid);
      if (!existing) await cc.createUser(uid, NEUTRAL_NAME, metadata);
      else if (existing.name !== NEUTRAL_NAME || openName(existing.metadata?.sn) !== name) {
        await cc.updateUserName(uid, NEUTRAL_NAME, metadata);
      }
    } else {
      uid = `p-${randomId(12)}`;
      if (isBotUid(uid)) throw new HttpError(500, "uid_collision", "Try again");
      await cc.createUser(uid, NEUTRAL_NAME, metadata);
    }

    const authToken = await cc.createAuthToken(uid);
    return json({ uid, name, authToken, sessionToken: signSession(uid) });
  } catch (e) {
    if (e instanceof cc.CometChatError && e.code === "ERR_PLAN_QUOTA_RESTRICTION") {
      // Surface it twice: to the invitee (via handleError) and to the host's lobby.
      if (roomId) await reportJoinFailure(roomId).catch(() => {});
    }
    return handleError(e);
  }
}
