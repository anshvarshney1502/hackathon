import { guidForRoom, RoomIdSchema } from "@/lib/game/ids";
import { MAX_PLAYERS } from "@/lib/game/types";
import { clientIp, handleError, HttpError, json, rateLimit } from "@/lib/server/http";
import { loadRoom } from "@/lib/server/room";

/** Public room status for the join screen. Reveals nothing about who is a bot. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    rateLimit(`status:${clientIp(req)}`, 30, 1);
    const parsed = RoomIdSchema.safeParse((await ctx.params).id);
    if (!parsed.success) throw new HttpError(400, "invalid_room", "That room code doesn't look right.");
    const room = await loadRoom(guidForRoom(parsed.data));
    if (!room) throw new HttpError(404, "not_found", "No room with that code.");
    return json({
      phase: room.state.phase,
      seats: room.members.length,
      maxSeats: MAX_PLAYERS,
    });
  } catch (e) {
    return handleError(e);
  }
}
