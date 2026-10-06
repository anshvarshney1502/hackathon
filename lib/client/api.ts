"use client";

import { z } from "zod";

/**
 * The only things kept in the browser: uid, display name and the signed session token.
 * No CometChat keys, no LLM keys, never anything about bots.
 */
const StoredSessionSchema = z.object({
  uid: z.string(),
  name: z.string(),
  sessionToken: z.string(),
});
export type StoredSession = z.infer<typeof StoredSessionSchema>;

const KEY = "nab.session.v1";

export function readSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? StoredSessionSchema.safeParse(JSON.parse(raw)) : null;
    return parsed?.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeSession(s: StoredSession) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode: the session simply won't persist */
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** serverNow - Date.now(), refreshed on every API response so timers match the server clock. */
let clockOffset = 0;
export const serverNow = () => Date.now() + clockOffset;

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const session = readSession();
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: {
        "content-type": "application/json",
        ...(session ? { authorization: `Bearer ${session.sessionToken}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(0, "network", "Can't reach the server. Check your connection.");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string; serverNow?: number };
  if (typeof data.serverNow === "number") clockOffset = data.serverNow - Date.now();
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? "Request failed");
  return data as T;
}

/** Create or refresh the CometChat identity. Reuses the stored uid when we have one. */
export async function ensureSession(name: string, roomId?: string): Promise<StoredSession & { authToken: string }> {
  const existing = readSession();
  const res = await api<{ uid: string; name: string; authToken: string; sessionToken: string }>("/api/session", {
    // roomId lets the server tell that case's host if we can't get in (e.g. the player limit).
    body: { name, sessionToken: existing?.sessionToken, roomId },
  });
  writeSession({ uid: res.uid, name: res.name, sessionToken: res.sessionToken });
  return res;
}

let keyPromise: Promise<string> | null = null;
/** The server's public ballot key (votes, trust and picks are sealed to it before they hit CometChat). */
export function ballotKey(): Promise<string> {
  if (!keyPromise) {
    keyPromise = api<{ key: string }>("/api/key").then((r) => r.key);
    keyPromise.catch(() => {
      keyPromise = null;
    });
  }
  return keyPromise;
}
