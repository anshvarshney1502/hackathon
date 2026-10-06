import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { bytesToId } from "@/lib/game/ids";
import { serverEnv } from "./env";

function hmac(label: string): Buffer {
  return createHmac("sha256", serverEnv().SESSION_SECRET).update(label).digest();
}

/** Deterministic, secret-derived UID for pooled bot #i. Indistinguishable from a random human UID. */
export function botUidForIndex(i: number): string {
  return `p-${bytesToId(hmac(`bot-uid:${i}`), 12)}`;
}

/** Per-round commitment salt. Derived, so nothing has to be stored until reveal. */
export function roundSalt(roundId: string): string {
  return hmac(`round-salt:${roundId}`).toString("hex").slice(0, 32);
}

/** Per-round secret seed for objectives, event schedule and defense tones. Never leaves the server. */
export function roundSeed(roundId: string): string {
  return hmac(`round-seed:${roundId}`).toString("hex");
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Opaque proof that this browser owns `uid`. Prevents claiming another player's UID. */
export function signSession(uid: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ uid, iat: now })).toString("base64url");
  const sig = createHmac("sha256", serverEnv().SESSION_SECRET).update(`session:${payload}`).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySession(token: string | null | undefined, now = Date.now()): string | null {
  if (!token || token.length > 512) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", serverEnv().SESSION_SECRET).update(`session:${payload}`).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as { uid?: unknown; iat?: unknown };
    if (typeof data.uid !== "string" || typeof data.iat !== "number") return null;
    if (now - data.iat > SESSION_TTL_MS) return null;
    return data.uid;
  } catch {
    return null;
  }
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Real names are sealed (AES-256-GCM, key derived from SESSION_SECRET) before they touch
 * CometChat. Every CometChat display name is the neutral "Player"; only the server can
 * open the sealed name, and only does so at REVEAL.
 */
export const NEUTRAL_NAME = "Player";

export function sealName(name: string): string {
  const key = hmac("real-name-key");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(name, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
}

export function openName(sealed: unknown): string | null {
  if (typeof sealed !== "string" || sealed.length > 400) return null;
  try {
    const buf = Buffer.from(sealed, "base64url");
    const d = createDecipheriv("aes-256-gcm", hmac("real-name-key"), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
