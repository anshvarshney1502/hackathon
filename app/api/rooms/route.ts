import { guidForRoom, randomId, ROOM_ID_LENGTH } from "@/lib/game/ids";
import { initialGameState } from "@/lib/game/types";
import * as cc from "@/lib/server/cometchat";
import { clientIp, handleError, json, rateLimit, requireUid } from "@/lib/server/http";

/** Create a room: a private CometChat group with the creator seated. */
export async function POST(req: Request) {
  try {
    const uid = requireUid(req);
    rateLimit(`create:${uid}`, 4, 0.05);
    rateLimit(`create-ip:${clientIp(req)}`, 8, 0.1);

    for (let attempt = 0; attempt < 3; attempt++) {
      const roomId = randomId(ROOM_ID_LENGTH);
      const guid = guidForRoom(roomId);
      if (await cc.getGroup(guid)) continue;
      await cc.createGroup({
        guid,
        name: `Room ${roomId.toUpperCase()}`,
        metadata: { nab: initialGameState(Date.now()) },
        participants: [uid],
      });
      return json({ roomId });
    }
    return json({ error: "busy", message: "Could not allocate a room. Try again." }, 503);
  } catch (e) {
    return handleError(e);
  }
}
