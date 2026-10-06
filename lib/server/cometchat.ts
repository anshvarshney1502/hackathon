import "server-only";
import { z } from "zod";
import { serverEnv } from "./env";

/**
 * Thin CometChat REST v3 client. Endpoints, headers and bodies follow the docs
 * fetched through the CometChat Docs MCP (see docs/MCP_LOG.md):
 *   base   https://{appId}.api-{region}.cometchat.io/v3
 *   auth   `apikey` header (REST API Key, fullAccess, server only)
 *   as-user `onBehalfOf` header
 */
export class CometChatError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CometChatError";
  }
}

function baseUrl(): string {
  const env = serverEnv();
  return `https://${env.NEXT_PUBLIC_COMETCHAT_APP_ID}.api-${env.NEXT_PUBLIC_COMETCHAT_REGION}.cometchat.io/v3`;
}

const ErrorBodySchema = z.object({
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
});

async function cc<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; onBehalfOf?: string } = {},
  attempt = 0,
): Promise<T> {
  const headers: Record<string, string> = {
    apikey: serverEnv().COMETCHAT_REST_API_KEY,
    accept: "application/json",
  };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.onBehalfOf) headers["onBehalfOf"] = init.onBehalfOf;

  const res = await fetch(`${baseUrl()}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 429 && attempt === 0) {
    const retryAfter = Math.min(Number(res.headers.get("retry-after") ?? "1") || 1, 3);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return cc<T>(path, init, 1);
  }

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const parsed = ErrorBodySchema.safeParse(json);
    const err = parsed.success ? parsed.data.error : undefined;
    throw new CometChatError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? `CometChat ${res.status}`);
  }
  return json as T;
}

/* ---------------- Users ---------------- */

const UserSchema = z.object({
  uid: z.string(),
  name: z.string(),
  status: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CcUser = z.infer<typeof UserSchema>;

export async function getUser(uid: string): Promise<CcUser | null> {
  try {
    const res = await cc<{ data: unknown }>(`/users/${encodeURIComponent(uid)}`);
    return UserSchema.parse(res.data);
  } catch (e) {
    if (e instanceof CometChatError && (e.status === 404 || e.code === "ERR_UID_NOT_FOUND")) return null;
    throw e;
  }
}

export async function createUser(uid: string, name: string, metadata?: Record<string, unknown>): Promise<void> {
  await cc("/users", { method: "POST", body: metadata ? { uid, name, metadata } : { uid, name } });
}

export async function updateUserName(uid: string, name: string, metadata?: Record<string, unknown>): Promise<void> {
  await cc(`/users/${encodeURIComponent(uid)}`, { method: "PUT", body: metadata ? { name, metadata } : { name } });
}

export async function listUsers(page: number, perPage = 100): Promise<{ users: CcUser[]; totalPages: number }> {
  const res = await cc<{ data: unknown[]; meta?: { pagination?: { total_pages?: number } } }>(`/users?perPage=${perPage}&page=${page}`);
  return { users: z.array(UserSchema).parse(res.data ?? []), totalPages: res.meta?.pagination?.total_pages ?? 1 };
}

/** Permanently deletes a user (MCP: /rest-api/users/delete, `permanent: true`). Used only by the cleanup script. */
export async function deleteUserPermanently(uid: string): Promise<void> {
  await cc(`/users/${encodeURIComponent(uid)}`, { method: "DELETE", body: { permanent: true } });
}

export async function createAuthToken(uid: string): Promise<string> {
  const res = await cc<{ data: { authToken: string } }>(`/users/${encodeURIComponent(uid)}/auth_tokens`, {
    method: "POST",
    body: {},
  });
  return z.string().min(1).parse(res.data.authToken);
}

/* ---------------- Groups ---------------- */

const GroupSchema = z.object({
  guid: z.string(),
  name: z.string(),
  membersCount: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CcGroup = z.infer<typeof GroupSchema>;

export async function getGroup(guid: string): Promise<CcGroup | null> {
  try {
    const res = await cc<{ data: unknown }>(`/groups/${encodeURIComponent(guid)}`);
    return GroupSchema.parse(res.data);
  } catch (e) {
    if (e instanceof CometChatError && (e.status === 404 || e.code === "ERR_GUID_NOT_FOUND")) return null;
    throw e;
  }
}

export async function createGroup(input: {
  guid: string;
  name: string;
  metadata: Record<string, unknown>;
  participants: string[];
}): Promise<void> {
  await cc("/groups", {
    method: "POST",
    body: {
      guid: input.guid,
      name: input.name,
      type: "private",
      metadata: input.metadata,
      members: { participants: input.participants },
    },
  });
}

export async function updateGroupMetadata(guid: string, metadata: Record<string, unknown>): Promise<void> {
  await cc(`/groups/${encodeURIComponent(guid)}`, { method: "PUT", body: { metadata } });
}

const MemberSchema = z.object({
  uid: z.string(),
  name: z.string(),
  status: z.string().optional(),
  scope: z.string().optional(),
  joinedAt: z.number(),
});
export type CcMember = z.infer<typeof MemberSchema>;

export async function listMembers(guid: string): Promise<CcMember[]> {
  const res = await cc<{ data: unknown[] }>(`/groups/${encodeURIComponent(guid)}/members?perPage=100`);
  return z.array(MemberSchema).parse(res.data);
}

export async function addParticipants(guid: string, uids: string[]): Promise<void> {
  if (uids.length === 0) return;
  await cc(`/groups/${encodeURIComponent(guid)}/members`, { method: "POST", body: { participants: uids } });
}

export async function kickMember(guid: string, uid: string): Promise<void> {
  try {
    await cc(`/groups/${encodeURIComponent(guid)}/members/${encodeURIComponent(uid)}`, { method: "DELETE" });
  } catch (e) {
    if (e instanceof CometChatError && e.code === "ERR_NOT_A_MEMBER") return;
    throw e;
  }
}

/* ---------------- Messages ---------------- */

const MessageSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => Number(v)),
  sender: z.string(),
  category: z.string(),
  type: z.string(),
  sentAt: z.number(),
  data: z
    .object({
      text: z.string().optional(),
      customData: z.unknown().optional(),
      entities: z
        .object({ sender: z.object({ entity: z.object({ name: z.string().optional() }).passthrough() }).optional() })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
  deletedAt: z.number().optional(),
});
export type CcMessage = z.infer<typeof MessageSchema>;

/**
 * Most recent messages of a group (oldest first in the returned array).
 * Uses `affix=prepend` + a very large id so the API pages backwards from "now".
 */
export async function listRecentGroupMessages(
  guid: string,
  opts: { limit: number; category?: "message" | "custom"; type?: string },
): Promise<CcMessage[]> {
  const q = new URLSearchParams({ limit: String(opts.limit), affix: "prepend", id: "999999999999", hideReplies: "true" });
  if (opts.category) q.set("category", opts.category);
  if (opts.type) q.set("type", opts.type);
  const res = await cc<{ data: unknown[] }>(`/groups/${encodeURIComponent(guid)}/messages?${q.toString()}`);
  const parsed: CcMessage[] = [];
  for (const raw of res.data ?? []) {
    const m = MessageSchema.safeParse(raw);
    if (m.success && !m.data.deletedAt) parsed.push(m.data);
  }
  return parsed.sort((a, b) => a.id - b.id);
}

export async function sendGroupText(guid: string, asUid: string, text: string): Promise<void> {
  await cc("/messages", {
    method: "POST",
    onBehalfOf: asUid,
    body: { receiver: guid, receiverType: "group", category: "message", type: "text", data: { text } },
  });
}

export async function sendGroupCustom(
  guid: string,
  asUid: string,
  type: string,
  customData: Record<string, unknown>,
): Promise<void> {
  await cc("/messages", {
    method: "POST",
    onBehalfOf: asUid,
    body: { receiver: guid, receiverType: "group", category: "custom", type, data: { customData } },
  });
}
