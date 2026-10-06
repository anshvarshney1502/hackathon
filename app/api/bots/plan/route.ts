import { after } from "next/server";
import { z } from "zod";
import { guidForRoom, RoomIdSchema } from "@/lib/game/ids";
import { runChatTick } from "@/lib/server/bots";
import { handleError, HttpError, json, parseBody, rateLimit, requireUid } from "@/lib/server/http";
import { loadRoom } from "@/lib/server/room";

export const maxDuration = 60;

const BodySchema = z.object({
  roomId: RoomIdSchema,
  mode: z.enum(["reply", "idle"]),
});

/**
 * Ask the server to let the table's strangers react. The host calls this after new
 * messages (debounced) and during silences. The server reads the transcript and the
 * roster from CometChat itself, so a client can't inject a fake transcript or learn
 * who the bots are. The response is identical whatever happens.
 */
export async function POST(req: Request) {
  try {
    const uid = requireUid(req);
    const { roomId, mode } = await parseBody(req, BodySchema);
    rateLimit(`plan:${uid}`, 12, 0.6);
    rateLimit(`plan-room:${roomId}`, 12, 0.6);
    const guid = guidForRoom(roomId);
    const room = await loadRoom(guid);
    if (!room) throw new HttpError(404, "not_found", "Room not found");
    if (!room.members.some((m) => m.uid === uid)) throw new HttpError(403, "not_member", "Not seated here");
    if (room.state.phase === "CHAT") {
      after(async () => {
        const outcome = await runChatTick(guid, mode).catch((e: unknown) => {
          console.warn("[bots] tick error:", e instanceof Error ? e.message : e);
          return "error" as const;
        });
        console.info(`[bots] ${roomId} ${mode} → ${outcome}`);
      });
    }
    return json({ accepted: true });
  } catch (e) {
    return handleError(e);
  }
}
