import { guidForRoom, RoomIdSchema } from "@/lib/game/ids";
import { MAX_HUMANS } from "@/lib/game/types";
import * as cc from "@/lib/server/cometchat";
import { handleError, HttpError, json, rateLimit, requireUid } from "@/lib/server/http";
import { humanMembers, loadRoom } from "@/lib/server/room";

/**
 * Seat the caller. The server adds members with the REST API for humans and bots
 * alike, so every seat produces the same "added" event.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const uid = requireUid(req);
    rateLimit(`join:${uid}`, 10, 0.5);
    const parsed = RoomIdSchema.safeParse((await ctx.params).id);
    if (!parsed.success) throw new HttpError(400, "invalid_room", "That room code doesn't look right.");
    const guid = guidForRoom(parsed.data);
    const room = await loadRoom(guid);
    if (!room) throw new HttpError(404, "not_found", "No room with that code.");

    if (room.members.some((m) => m.uid === uid)) return json({ joined: true, rejoined: true });
    if (room.state.phase !== "LOBBY") {
      throw new HttpError(409, "in_progress", "A round is in progress. You can join when it's back in the lobby.");
    }
    // Five humans max: the sixth seat always belongs to an AI.
    if (humanMembers(room.members).length >= MAX_HUMANS) throw new HttpError(409, "full", "This case is full.");
    await cc.addParticipants(guid, [uid]);
    // Concurrent joins can overshoot the cap: re-check, and the latest arrivals step back out.
    const humans = humanMembers(await cc.listMembers(guid)).sort((a, b) => a.joinedAt - b.joinedAt || a.uid.localeCompare(b.uid));
    if (humans.findIndex((m) => m.uid === uid) >= MAX_HUMANS) {
      await cc.kickMember(guid, uid);
      throw new HttpError(409, "full", "This case is full.");
    }
    return json({ joined: true, rejoined: false });
  } catch (e) {
    return handleError(e);
  }
}
