import { z } from "zod";
import { guidForRoom, RoomIdSchema } from "@/lib/game/ids";
import { ChatDurationSchema } from "@/lib/game/types";
import { advance } from "@/lib/server/game";
import { handleError, HttpError, json, parseBody, rateLimit, requireUid } from "@/lib/server/http";

export const maxDuration = 60;

const BodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), expectSeq: z.number().int().min(0), chatSeconds: ChatDurationSchema }),
  z.object({ action: z.literal("trust"), expectSeq: z.number().int().min(0), force: z.boolean().optional() }),
  z.object({ action: z.literal("defense"), expectSeq: z.number().int().min(0) }),
  z.object({ action: z.literal("vote"), expectSeq: z.number().int().min(0) }),
  z.object({ action: z.literal("reveal"), expectSeq: z.number().int().min(0) }),
  z.object({ action: z.literal("lobby"), expectSeq: z.number().int().min(0) }),
]);

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const uid = requireUid(req);
    rateLimit(`advance:${uid}`, 6, 0.5);
    const parsed = RoomIdSchema.safeParse((await ctx.params).id);
    if (!parsed.success) throw new HttpError(400, "invalid_room", "Invalid room");
    const body = await parseBody(req, BodySchema);
    const state = await advance(guidForRoom(parsed.data), uid, body);
    return json({ state });
  } catch (e) {
    return handleError(e);
  }
}
