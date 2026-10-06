import { z } from "zod";
import { RoomIdSchema } from "@/lib/game/ids";
import { handleError, json, parseBody, rateLimit, requireUid } from "@/lib/server/http";

const BodySchema = z.object({
  roomId: RoomIdSchema,
  messageId: z.union([z.string(), z.number()]).transform(String),
  reason: z.enum(["harassment", "hate", "sexual", "spam", "other"]),
});

/**
 * Fallback report sink, used when CometChat flagMessage is unavailable
 * (moderation disabled on the app). Lands in the server logs for review.
 */
export async function POST(req: Request) {
  try {
    const uid = requireUid(req);
    rateLimit(`report:${uid}`, 5, 0.05);
    const body = await parseBody(req, BodySchema);
    console.warn("[report]", JSON.stringify({ by: uid, ...body, at: new Date().toISOString() }));
    return json({ received: true });
  } catch (e) {
    return handleError(e);
  }
}
