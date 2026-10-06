import {
  type Ballots,
  CUSTOM_TYPES,
  DefenseEventSchema,
  type GameState,
  initialGameState,
  RevealEventSchema,
  type RevealDetail,
  SealedEnvelopeSchema,
  type Verdict,
} from "@/lib/game/types";

/**
 * Pure room state + reducer (no React, no SDK), so reconnect / history restoration is unit-tested.
 * Holds only what a player may know: *who* submitted votes, trust and picks (their contents are
 * sealed to the server), public defenses, and the reveal detail once REVEAL has happened.
 */
export interface Player {
  uid: string;
  name: string;
  joinedAt: number;
  online: boolean;
  /** Seen going offline during this session. */
  signalLost: boolean;
}

export interface ChatMsg {
  key: string;
  id: number | null;
  uid: string;
  name: string;
  text: string;
  at: number;
  status: "sent" | "pending" | "failed";
}

export type RoomStatus = "starting" | "joining" | "waiting" | "ready" | "error";
export type Connection = "connected" | "connecting" | "disconnected";

export interface State {
  status: RoomStatus;
  error: { code: string; message: string } | null;
  me: { uid: string; name: string } | null;
  game: GameState;
  players: Record<string, Player>;
  messages: ChatMsg[];
  typing: Record<string, number>;
  lastSpeaker: { uid: string; at: number } | null;
  voted: Record<string, true>;
  myBallots: Ballots;
  voteStatus: "idle" | "sending" | "sent" | "failed";
  connection: Connection;
  revealVerified: boolean | null;
  /** Who has locked in their trust picks this round (not *what* they picked). */
  trusted: Record<string, true>;
  myTrust: { most: string | null; least: string | null };
  trustStatus: "idle" | "sending" | "sent" | "failed";
  /** Final defenses this round: first one per player wins, exactly like the server. */
  defenses: Record<string, { text: string; at: number }>;
  defenseStatus: "idle" | "sending" | "locked" | "failed";
  /** eventId → who has picked (for the "x/6 picked" read-out). */
  picked: Record<string, Record<string, true>>;
  myPicks: Record<string, string>;
  /** Personas, objectives, archetypes: arrives with the game.reveal message, never earlier. */
  revealDetail: { roundId: string; detail: RevealDetail } | null;
}

/** A parsed game.* custom message, live or from history. */
export interface CustomEvt {
  type: string;
  uid: string;
  data: unknown;
  at: number;
}

export type Action =
  | { t: "status"; status: RoomStatus; error?: State["error"] }
  | { t: "me"; me: State["me"] }
  | { t: "game"; game: GameState }
  | { t: "players"; players: Player[] }
  | { t: "presence"; uid: string; online: boolean }
  | { t: "history"; messages: ChatMsg[]; voted: string[] }
  | { t: "message"; msg: ChatMsg }
  | { t: "messageStatus"; key: string; status: ChatMsg["status"]; id?: number }
  | { t: "typing"; uid: string; until: number | null }
  | { t: "voted"; uid: string; roundId: string }
  | { t: "ballot"; target: string; verdict: Verdict }
  | { t: "voteStatus"; status: State["voteStatus"] }
  | { t: "connection"; connection: Connection }
  | { t: "revealVerified"; ok: boolean }
  | { t: "custom"; evts: CustomEvt[] }
  | { t: "myTrust"; most?: string | null; least?: string | null; status?: State["trustStatus"] }
  | { t: "defenseStatus"; status: State["defenseStatus"] }
  | { t: "myPick"; eventId: string; pick: string };

export const initial: State = {
  status: "starting",
  error: null,
  me: null,
  game: initialGameState(0),
  players: {},
  messages: [],
  typing: {},
  lastSpeaker: null,
  voted: {},
  myBallots: {},
  voteStatus: "idle",
  connection: "connecting",
  revealVerified: null,
  trusted: {},
  myTrust: { most: null, least: null },
  trustStatus: "idle",
  defenses: {},
  defenseStatus: "idle",
  picked: {},
  myPicks: {},
  revealDetail: null,
};

/** Fold one custom game event into state. Shared by live listeners and history replay. */
export function applyCustom(s: State, e: CustomEvt): State {
  const roundId = s.game.roundId;
  switch (e.type) {
    case CUSTOM_TYPES.vote: {
      const v = SealedEnvelopeSchema.safeParse(e.data);
      return v.success && v.data.roundId === roundId ? { ...s, voted: { ...s.voted, [e.uid]: true } } : s;
    }
    case CUSTOM_TYPES.trust: {
      const t = SealedEnvelopeSchema.safeParse(e.data);
      return t.success && t.data.roundId === roundId ? { ...s, trusted: { ...s.trusted, [e.uid]: true } } : s;
    }
    case CUSTOM_TYPES.defense: {
      const d = DefenseEventSchema.safeParse(e.data);
      if (!d.success || d.data.roundId !== roundId || s.defenses[e.uid]) return s;
      return {
        ...s,
        defenses: { ...s.defenses, [e.uid]: { text: d.data.text, at: e.at } },
        defenseStatus: e.uid === s.me?.uid ? "locked" : s.defenseStatus,
        lastSpeaker: { uid: e.uid, at: Date.now() },
      };
    }
    case CUSTOM_TYPES.pick: {
      const p = SealedEnvelopeSchema.safeParse(e.data);
      if (!p.success || p.data.roundId !== roundId || !p.data.eventId) return s;
      const eventId = p.data.eventId;
      return { ...s, picked: { ...s.picked, [eventId]: { ...s.picked[eventId], [e.uid]: true } } };
    }
    case CUSTOM_TYPES.reveal: {
      const r = RevealEventSchema.safeParse(e.data);
      return r.success && r.data.detail ? { ...s, revealDetail: { roundId: r.data.roundId, detail: r.data.detail } } : s;
    }
    default:
      return s;
  }
}

const MAX_MESSAGES = 200;

export function reducer(s: State, a: Action): State {
  switch (a.t) {
    case "status":
      return { ...s, status: a.status, error: a.error ?? null };
    case "me":
      return { ...s, me: a.me };
    case "game": {
      if (a.game.seq < s.game.seq && s.game.seq !== 0) return s;
      const newRound = a.game.roundId !== s.game.roundId;
      return {
        ...s,
        game: a.game,
        voted: newRound ? {} : s.voted,
        myBallots: newRound ? {} : s.myBallots,
        voteStatus: newRound ? "idle" : s.voteStatus,
        revealVerified: a.game.phase === "REVEAL" ? s.revealVerified : null,
        ...(newRound
          ? {
              trusted: {},
              myTrust: { most: null, least: null },
              trustStatus: "idle" as const,
              defenses: {},
              defenseStatus: "idle" as const,
              picked: {},
              myPicks: {},
            }
          : {}),
      };
    }
    case "players": {
      const players: Record<string, Player> = {};
      for (const p of a.players) players[p.uid] = { ...p, signalLost: s.players[p.uid]?.signalLost ?? false };
      return { ...s, players };
    }
    case "presence": {
      const p = s.players[a.uid];
      if (!p) return s;
      return { ...s, players: { ...s.players, [a.uid]: { ...p, online: a.online, signalLost: !a.online } } };
    }
    case "history": {
      const known = new Set(s.messages.map((m) => m.key));
      const knownIds = new Set(s.messages.map((m) => m.id).filter((id) => id !== null));
      const fresh = a.messages.filter((m) => !known.has(m.key) && !(m.id !== null && knownIds.has(m.id)));
      if (fresh.length === 0 && a.voted.length === 0) return s;
      const merged = [...fresh, ...s.messages].sort((x, y) => x.at - y.at);
      const voted = { ...s.voted };
      for (const uid of a.voted) voted[uid] = true;
      return { ...s, messages: merged.slice(-MAX_MESSAGES), voted };
    }
    case "message": {
      if (s.messages.some((m) => m.key === a.msg.key || (a.msg.id !== null && m.id === a.msg.id))) return s;
      const typing = { ...s.typing };
      delete typing[a.msg.uid];
      return {
        ...s,
        messages: [...s.messages, a.msg].slice(-MAX_MESSAGES),
        typing,
        lastSpeaker: { uid: a.msg.uid, at: Date.now() },
      };
    }
    case "messageStatus":
      return {
        ...s,
        messages: s.messages.map((m) => (m.key === a.key ? { ...m, status: a.status, id: a.id ?? m.id } : m)),
      };
    case "typing": {
      const typing = { ...s.typing };
      if (a.until === null) delete typing[a.uid];
      else typing[a.uid] = a.until;
      return { ...s, typing };
    }
    case "voted":
      if (a.roundId !== s.game.roundId) return s;
      return { ...s, voted: { ...s.voted, [a.uid]: true } };
    case "ballot":
      return { ...s, myBallots: { ...s.myBallots, [a.target]: a.verdict } };
    case "voteStatus":
      return { ...s, voteStatus: a.status };
    case "connection":
      return { ...s, connection: a.connection };
    case "revealVerified":
      return { ...s, revealVerified: a.ok };
    case "custom":
      return a.evts.reduce(applyCustom, s);
    case "myTrust":
      return {
        ...s,
        myTrust: {
          most: a.most === undefined ? s.myTrust.most : a.most,
          least: a.least === undefined ? s.myTrust.least : a.least,
        },
        trustStatus: a.status ?? s.trustStatus,
      };
    case "defenseStatus":
      return { ...s, defenseStatus: s.defenseStatus === "locked" ? "locked" : a.status };
    case "myPick":
      return { ...s, myPicks: { ...s.myPicks, [a.eventId]: a.pick } };
  }
}

