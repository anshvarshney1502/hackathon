import { guidForRoom, RoomIdSchema } from "@/lib/game/ids";
import { pulse } from "@/lib/server/events";
import { handleError, HttpError, json, rateLimit, requireUid } from "@/lib/server/http";
import { isBotUid } from "@/lib/server/room";

export const maxDuration = 60;

/**
 * Interrogation-event heartbeat, called by the host every few seconds during CHAT.
 * Responds with the public state only when something changed.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const uid = requireUid(req);
    if (isBotUid(uid)) throw new HttpError(403, "forbidden", "Not allowed");
    rateLimit(`pulse:${uid}`, 6, 0.4);
    const parsed = RoomIdSchema.safeParse((await ctx.params).id);
    if (!parsed.success) throw new HttpError(400, "invalid_room", "Invalid room");
    const res = await pulse(guidForRoom(parsed.data), uid);
    return json({ outcome: res.outcome, state: res.state ?? null });
  } catch (e) {
    return handleError(e);
  }
}
