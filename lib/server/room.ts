import "server-only";
import { PERSONAS, type Persona } from "@/lib/bots/personas";
import type { Temperament } from "@/lib/bots/temperament";
import { electHost } from "@/lib/game/host";
import { type GameState, GameStateSchema, initialGameState } from "@/lib/game/types";
import { botUidForIndex } from "./crypto";
import * as cc from "./cometchat";

export interface PooledBot {
  uid: string;
  name: string;
  persona: Persona;
  /** This round's rolled behaviour (set by seatedBots). */
  temperament?: Temperament;
}

let poolCache: PooledBot[] | null = null;

/** The fixed, seeded bot pool (see scripts/seed-bots.ts). */
export function botPool(): PooledBot[] {
  if (!poolCache) poolCache = PERSONAS.map((persona, i) => ({ uid: botUidForIndex(i), name: persona.name, persona }));
  return poolCache;
}

export function poolByUid(): Map<string, PooledBot> {
  return new Map(botPool().map((b) => [b.uid, b]));
}

export function isBotUid(uid: string): boolean {
  return poolByUid().has(uid);
}

export interface RoomSnapshot {
  guid: string;
  state: GameState;
  members: cc.CcMember[];
}

export function parseState(metadata: Record<string, unknown> | undefined, now: number): GameState {
  const parsed = GameStateSchema.safeParse(metadata?.nab);
  if (parsed.success) return parsed.data;
  if (metadata?.nab !== undefined) console.error("[room] stored game state failed validation:", parsed.error.issues[0]);
  return initialGameState(now);
}

export async function loadRoom(guid: string): Promise<RoomSnapshot | null> {
  const [group, members] = await Promise.all([cc.getGroup(guid), cc.listMembers(guid).catch(() => null)]);
  if (!group || !members) return null;
  return { guid, state: parseState(group.metadata, Date.now()), members };
}

/** CometChat caps group metadata at 5 KB (MCP: properties-and-constraints). Keep a margin. */
const METADATA_BUDGET = 4_600;

export async function saveState(guid: string, state: GameState): Promise<void> {
  let next = state;
  if (JSON.stringify({ nab: next }).length > METADATA_BUDGET) next = { ...next, eventLog: next.eventLog.slice(-1) };
  if (JSON.stringify({ nab: next }).length > METADATA_BUDGET) next = { ...next, eventLog: [] };
  if (JSON.stringify({ nab: next }).length > METADATA_BUDGET) console.error("[room] game state near the 5 KB metadata cap");
  await cc.updateGroupMetadata(guid, { nab: next });
}

/**
 * Compare-and-set on `seq`: re-read right before writing so a background pulse can never
 * overwrite a phase change that landed in the meantime. Returns false if it lost the race.
 */
export async function saveIfUnchanged(guid: string, expectedSeq: number, next: GameState): Promise<boolean> {
  const group = await cc.getGroup(guid);
  if (parseState(group?.metadata, Date.now()).seq !== expectedSeq) return false;
  await saveState(guid, next);
  return true;
}

export function humanMembers(members: cc.CcMember[]): cc.CcMember[] {
  return members.filter((m) => !isBotUid(m.uid));
}

export function botMembers(members: cc.CcMember[]): PooledBot[] {
  const pool = poolByUid();
  return members.map((m) => pool.get(m.uid)).filter((b): b is PooledBot => Boolean(b));
}

/** REST presence uses "available"/"online" for connected users. */
export function isOnlineStatus(status: string | undefined): boolean {
  return status === "available" || status === "online";
}

/** Same rule as the client (lib/game/host.ts), applied to the REST member list. */
export function serverHost(members: cc.CcMember[]): string | null {
  return electHost(members.map((m) => ({ uid: m.uid, joinedAt: m.joinedAt, online: isOnlineStatus(m.status) })));
}
