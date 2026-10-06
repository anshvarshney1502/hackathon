import { z } from "zod";

/** Unambiguous lowercase alphabet (no 0/o, 1/l/i). */
export const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export const ROOM_ID_LENGTH = 6;
export const RoomIdSchema = z
  .string()
  .regex(new RegExp(`^[${ID_ALPHABET}]{${ROOM_ID_LENGTH}}$`), "Invalid room code");

/** Player UIDs look identical for humans and bots: `p-` + 12 alphabet chars. */
export const PlayerUidSchema = z.string().regex(new RegExp(`^p-[${ID_ALPHABET}]{12}$`));

export const DisplayNameSchema = z
  .string()
  .trim()
  .min(2, "Name needs at least 2 characters")
  .max(18, "Keep it under 18 characters")
  .regex(/^[\p{L}\p{N} ._'-]+$/u, "Letters, numbers, spaces and . _ ' - only");

export function guidForRoom(roomId: string): string {
  return `nab-${roomId}`;
}

export function roomIdFromGuid(guid: string): string | null {
  const id = guid.startsWith("nab-") ? guid.slice(4) : "";
  return RoomIdSchema.safeParse(id).success ? id : null;
}

/** Map arbitrary bytes onto the alphabet. Slight modulo bias is irrelevant for IDs. */
export function bytesToId(bytes: Uint8Array, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ID_ALPHABET[bytes[i % bytes.length] % ID_ALPHABET.length];
  return out;
}

export function randomId(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToId(bytes, length);
}

export function normalizeRoomCode(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const fromUrl = trimmed.match(/\/r\/([a-z0-9]+)/);
  return (fromUrl ? fromUrl[1] : trimmed).replace(/[^a-z0-9]/g, "");
}
