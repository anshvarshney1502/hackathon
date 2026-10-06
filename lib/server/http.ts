import "server-only";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { CometChatError } from "./cometchat";
import { verifySession } from "./crypto";
import { MissingEnvError } from "./env";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function json<T>(body: T, status = 200): NextResponse {
  return NextResponse.json({ ...body, serverNow: Date.now() }, { status, headers: { "cache-control": "no-store" } });
}

/** Map any thrown error to a safe JSON response. Never leaks internals. */
export function handleError(e: unknown): NextResponse {
  if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
  if (e instanceof MissingEnvError) {
    return json({ error: "server_not_configured", message: "The server is missing configuration. See README → Environment." }, 503);
  }
  if (e instanceof CometChatError && e.code === "ERR_PLAN_QUOTA_RESTRICTION") {
    console.error("[cometchat] user quota exhausted");
    return json(
      { error: "player_limit", message: "This game has reached its player limit (100 accounts on the free CometChat plan). Ask the host to free up space." },
      503,
    );
  }
  if (e instanceof CometChatError) {
    console.error("[cometchat]", e.status, e.code);
    return json({ error: "chat_service_error", message: "The chat service had a problem. Try again in a moment." }, 502);
  }
  console.error("[api]", e instanceof Error ? e.message : e);
  return json({ error: "internal", message: "Something went wrong." }, 500);
}

export async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "bad_json", "Request body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "invalid_input", parsed.error.issues[0]?.message ?? "Invalid input");
  return parsed.data;
}

/** The caller's uid, proven by the HMAC session token from /api/session. */
export function requireUid(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  const uid = verifySession(header.startsWith("Bearer ") ? header.slice(7) : null);
  if (!uid) throw new HttpError(401, "unauthorized", "Session expired. Reload the page.");
  return uid;
}

/* ---------- Best-effort in-memory rate limiting (per serverless instance) ---------- */

const buckets = new Map<string, { tokens: number; at: number }>();

export function rateLimit(key: string, capacity: number, refillPerSec: number): void {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: capacity, at: now };
  b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSec);
  b.at = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    throw new HttpError(429, "rate_limited", "Slow down a little.");
  }
  b.tokens -= 1;
  buckets.set(key, b);
  if (buckets.size > 5000) buckets.clear();
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}
