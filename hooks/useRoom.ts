"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import type { BaseMessage, CustomMessage, GroupMember, TextMessage, TypingIndicator, User } from "@cometchat/chat-sdk-javascript";
import { api, ApiError, ballotKey, ensureSession, serverNow } from "@/lib/client/api";
import { type ChatMsg, type CustomEvt, initial, reducer } from "@/lib/client/roomState";
import { seal } from "@/lib/game/sealed";
import { type CC, loginWithToken } from "@/lib/client/cometchat";
import { verifyCommitment } from "@/lib/game/commitment";
import { electHost } from "@/lib/game/host";
import { guidForRoom } from "@/lib/game/ids";
import { NEXT_ACTION } from "@/lib/game/machine";
import {
  CUSTOM_TYPES,
  EventNudgeSchema,
  type GameState,
  GameStateSchema,
  PhaseEventSchema,
  RevealEventSchema,
  TypingEventSchema,
  type Verdict,
} from "@/lib/game/types";

export type { ChatMsg, Connection, Player, RoomStatus } from "@/lib/client/roomState";

function toChat(m: TextMessage): ChatMsg {
  const sender = m.getSender();
  return {
    key: `id:${m.getId()}`,
    id: m.getId(),
    uid: sender.getUid(),
    name: sender.getName(),
    text: m.getText(),
    at: m.getSentAt() * 1000,
    status: "sent",
  };
}

function parseGroupState(metadata: unknown): GameState | null {
  const parsed = GameStateSchema.safeParse((metadata as { nab?: unknown } | null)?.nab);
  return parsed.success ? parsed.data : null;
}

export function useRoom(roomId: string, displayName: string | null) {
  const [s, dispatch] = useReducer(reducer, initial);
  const guid = guidForRoom(roomId);
  const sdk = useRef<CC | null>(null);
  const isHostRef = useRef(false);
  const stateRef = useRef(s);
  // Callbacks read the latest state through this ref; sync it before effects run.
  useLayoutEffect(() => {
    stateRef.current = s;
  });

  /* ---------- sync from CometChat (group metadata, members, history) ---------- */

  const loadMembers = useCallback(async () => {
    const CometChat = sdk.current;
    if (!CometChat) return;
    const list = (await new CometChat.GroupMembersRequestBuilder(guid).setLimit(20).build().fetchNext()) as GroupMember[];
    dispatch({
      t: "players",
      players: list.map((m) => ({
        uid: m.getUid(),
        name: m.getName(),
        joinedAt: m.getJoinedAt(),
        online: m.getStatus() === "online",
        signalLost: false,
      })),
    });
  }, [guid]);

  const syncState = useCallback(async () => {
    const CometChat = sdk.current;
    if (!CometChat) return;
    const group = await CometChat.getGroup(guid);
    const game = parseGroupState(group.getMetadata());
    if (game) dispatch({ t: "game", game });
  }, [guid]);

  const loadHistory = useCallback(async () => {
    const CometChat = sdk.current;
    if (!CometChat) return;
    const msgs = (await new CometChat.MessagesRequestBuilder()
      .setGUID(guid)
      .setLimit(100)
      .setCategories(["message", "custom"])
      // Skip game.typing noise so the window reaches back over the whole round.
      .setTypes(["text", CUSTOM_TYPES.vote, CUSTOM_TYPES.trust, CUSTOM_TYPES.defense, CUSTOM_TYPES.pick, CUSTOM_TYPES.reveal])
      .hideReplies(true)
      .build()
      .fetchPrevious()) as BaseMessage[];
    const chat: ChatMsg[] = [];
    const customs: CustomEvt[] = [];
    for (const m of msgs) {
      if (m.getCategory() === "message" && m.getType() === "text") {
        chat.push(toChat(m as TextMessage));
      } else if (m.getCategory() === "custom") {
        customs.push({ type: m.getType(), uid: m.getSender().getUid(), data: (m as CustomMessage).getCustomData(), at: m.getSentAt() * 1000 });
      }
    }
    dispatch({ t: "history", messages: chat, voted: [] });
    dispatch({ t: "custom", evts: customs });
  }, [guid]);

  // Fallback for the realtime socket: pick up recent chat lines it may have missed.
  // The reducer drops duplicates by message id, so this is safe to call often.
  const pollChat = useCallback(async () => {
    const CometChat = sdk.current;
    if (!CometChat) return;
    const msgs = (await new CometChat.MessagesRequestBuilder()
      .setGUID(guid)
      .setLimit(30)
      .setCategories(["message"])
      .setTypes(["text"])
      .hideReplies(true)
      .build()
      .fetchPrevious()) as BaseMessage[];
    const chat = msgs.filter((m) => m.getCategory() === "message" && m.getType() === "text").map((m) => toChat(m as TextMessage));
    if (chat.length) dispatch({ t: "history", messages: chat, voted: [] });
  }, [guid]);

  const fullSync = useCallback(async () => {
    await syncState();
    await Promise.all([loadMembers(), loadHistory()]);
  }, [syncState, loadMembers, loadHistory]);

  /* ---------- boot: session → login → join → sync → listeners ---------- */

  useEffect(() => {
    if (!displayName) return;
    let cancelled = false;
    const listenerId = `nab-${roomId}-${Math.random().toString(36).slice(2)}`;
    let waitTimer: ReturnType<typeof setTimeout> | null = null;

    async function join(): Promise<boolean> {
      try {
        await api(`/api/rooms/${roomId}/join`, { body: {} });
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.code === "in_progress") {
          dispatch({ t: "status", status: "waiting", error: { code: e.code, message: e.message } });
          waitTimer = setTimeout(async () => {
            if (!cancelled && (await join())) await afterJoin();
          }, 5000);
          return false;
        }
        throw e;
      }
    }

    async function afterJoin() {
      await fullSync();
      if (!cancelled) dispatch({ t: "status", status: "ready" });
    }

    function attach(CometChat: CC) {
      CometChat.addMessageListener(
        listenerId,
        new CometChat.MessageListener({
          onTextMessageReceived: (m: TextMessage) => {
            if (m.getReceiverId() !== guid) return;
            dispatch({ t: "message", msg: toChat(m) });
          },
          onCustomMessageReceived: (m: CustomMessage) => {
            if (m.getReceiverId() !== guid) return;
            const uid = m.getSender().getUid();
            const data = m.getCustomData();
            switch (m.getType()) {
              case CUSTOM_TYPES.typing: {
                const t = TypingEventSchema.safeParse(data);
                if (t.success) dispatch({ t: "typing", uid, until: Date.now() + t.data.ms });
                break;
              }
              case CUSTOM_TYPES.phase:
              case CUSTOM_TYPES.event:
              case CUSTOM_TYPES.reveal: {
                // Events are only a nudge: the authoritative state is the group metadata,
                // which only the server can write. Forged events can't change the game.
                if (m.getType() === CUSTOM_TYPES.reveal) {
                  dispatch({ t: "custom", evts: [{ type: m.getType(), uid, data, at: m.getSentAt() * 1000 }] });
                }
                const ok =
                  PhaseEventSchema.safeParse(data).success ||
                  RevealEventSchema.safeParse(data).success ||
                  EventNudgeSchema.safeParse(data).success;
                if (ok) void syncState().then(loadMembers);
                break;
              }
              default:
                dispatch({ t: "custom", evts: [{ type: m.getType(), uid, data, at: m.getSentAt() * 1000 }] });
            }
          },
          onTypingStarted: (i: TypingIndicator) => {
            if (i.getReceiverId() === guid) dispatch({ t: "typing", uid: i.getSender().getUid(), until: Date.now() + 6000 });
          },
          onTypingEnded: (i: TypingIndicator) => {
            if (i.getReceiverId() === guid) dispatch({ t: "typing", uid: i.getSender().getUid(), until: null });
          },
        }),
      );
      CometChat.addUserListener(
        listenerId,
        new CometChat.UserListener({
          onUserOnline: (u: User) => dispatch({ t: "presence", uid: u.getUid(), online: true }),
          onUserOffline: (u: User) => dispatch({ t: "presence", uid: u.getUid(), online: false }),
        }),
      );
      const refreshMembers = () => void loadMembers();
      CometChat.addGroupListener(
        listenerId,
        new CometChat.GroupListener({
          onGroupMemberJoined: refreshMembers,
          onGroupMemberLeft: refreshMembers,
          onGroupMemberKicked: refreshMembers,
          onGroupMemberBanned: refreshMembers,
          onMemberAddedToGroup: refreshMembers,
        }),
      );
      let wasDisconnected = false;
      CometChat.addConnectionListener(
        listenerId,
        new CometChat.ConnectionListener({
          onConnected: () => {
            dispatch({ t: "connection", connection: "connected" });
            if (wasDisconnected) void fullSync();
            wasDisconnected = false;
          },
          inConnecting: () => dispatch({ t: "connection", connection: "connecting" }),
          onDisconnected: () => {
            wasDisconnected = true;
            dispatch({ t: "connection", connection: "disconnected" });
          },
        }),
      );
    }

    (async () => {
      try {
        dispatch({ t: "status", status: "joining" });
        const session = await ensureSession(displayName, roomId);
        if (cancelled) return;
        dispatch({ t: "me", me: { uid: session.uid, name: session.name } });
        const CometChat = await loginWithToken(session.uid, session.authToken);
        if (cancelled) return;
        sdk.current = CometChat;
        dispatch({ t: "connection", connection: CometChat.getConnectionStatus() === "connected" ? "connected" : "connecting" });
        attach(CometChat);
        if (await join()) await afterJoin();
      } catch (e) {
        if (cancelled) return;
        const err =
          e instanceof ApiError
            ? { code: e.code, message: e.message }
            : { code: "connect_failed", message: e instanceof Error ? e.message : "Could not connect" };
        dispatch({ t: "status", status: "error", error: err });
      }
    })();

    return () => {
      cancelled = true;
      if (waitTimer) clearTimeout(waitTimer);
      const CometChat = sdk.current;
      if (CometChat) {
        CometChat.removeMessageListener(listenerId);
        CometChat.removeUserListener(listenerId);
        CometChat.removeGroupListener(listenerId);
        CometChat.removeConnectionListener(listenerId);
      }
    };
  }, [roomId, guid, displayName, fullSync, loadMembers, syncState]);

  /* ---------- expire stale typing flags ---------- */
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      for (const [uid, until] of Object.entries(stateRef.current.typing)) {
        if (until < now) dispatch({ t: "typing", uid, until: null });
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  /* ---------- verify the roster commitment at reveal ---------- */
  useEffect(() => {
    const { game } = s;
    if (game.phase !== "REVEAL" || !game.reveal || !game.commitment) return;
    void verifyCommitment(game.commitment, game.reveal.roundId, game.reveal.botUids, game.reveal.salt).then((ok) =>
      dispatch({ t: "revealVerified", ok }),
    );
  }, [s.game]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- actions ---------- */

  const typingState = useRef<{ active: boolean; stopTimer: ReturnType<typeof setTimeout> | null; lastStart: number }>({
    active: false,
    stopTimer: null,
    lastStart: 0,
  });

  const stopTyping = useCallback(() => {
    const CometChat = sdk.current;
    const t = typingState.current;
    if (t.stopTimer) clearTimeout(t.stopTimer);
    t.stopTimer = null;
    if (CometChat && t.active) CometChat.endTyping(new CometChat.TypingIndicator(guid, CometChat.RECEIVER_TYPE.GROUP));
    t.active = false;
  }, [guid]);

  const notifyTyping = useCallback(() => {
    const CometChat = sdk.current;
    if (!CometChat) return;
    const t = typingState.current;
    const now = Date.now();
    // Debounced per the presence-and-typing bundle: not every keystroke.
    if (!t.active || now - t.lastStart > 3000) {
      CometChat.startTyping(new CometChat.TypingIndicator(guid, CometChat.RECEIVER_TYPE.GROUP));
      t.active = true;
      t.lastStart = now;
    }
    if (t.stopTimer) clearTimeout(t.stopTimer);
    t.stopTimer = setTimeout(stopTyping, 2000);
  }, [guid, stopTyping]);

  const pendingPlan = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestBotPlan = useCallback(
    (mode: "reply" | "idle") => {
      if (pendingPlan.current) clearTimeout(pendingPlan.current);
      pendingPlan.current = setTimeout(
        () => void api("/api/bots/plan", { body: { roomId, mode } }).catch(() => {}),
        mode === "reply" ? 900 : 0,
      );
    },
    [roomId],
  );

  const sendText = useCallback(
    async (raw: string, retryKey?: string) => {
      const CometChat = sdk.current;
      const me = stateRef.current.me;
      const text = raw.trim().slice(0, 280);
      if (!CometChat || !me || !text) return;
      stopTyping();
      const key = retryKey ?? `local:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      if (retryKey) dispatch({ t: "messageStatus", key, status: "pending" });
      else dispatch({ t: "message", msg: { key, id: null, uid: me.uid, name: me.name, text, at: serverNow(), status: "pending" } });
      try {
        const sent = (await CometChat.sendMessage(new CometChat.TextMessage(guid, text, CometChat.RECEIVER_TYPE.GROUP))) as TextMessage;
        dispatch({ t: "messageStatus", key, status: "sent", id: sent.getId() });
        if (isHostRef.current) requestBotPlan("reply");
      } catch {
        dispatch({ t: "messageStatus", key, status: "failed" });
      }
    },
    [guid, stopTyping, requestBotPlan],
  );

  const voteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushVote = useCallback(async () => {
    const CometChat = sdk.current;
    const { game, myBallots } = stateRef.current;
    if (!CometChat || !game.roundId || game.phase !== "VOTE") return;
    dispatch({ t: "voteStatus", status: "sending" });
    try {
      // Sealed: other players (and their devtools) see that you voted, never how.
      const sealed = await seal({ roundId: game.roundId, ballots: myBallots }, await ballotKey());
      const msg = new CometChat.CustomMessage(guid, CometChat.RECEIVER_TYPE.GROUP, CUSTOM_TYPES.vote, {
        roundId: game.roundId,
        sealed,
      });
      msg.shouldUpdateConversation(false);
      await CometChat.sendCustomMessage(msg);
      dispatch({ t: "voteStatus", status: "sent" });
      const me = stateRef.current.me;
      if (me) dispatch({ t: "voted", uid: me.uid, roundId: game.roundId });
    } catch {
      dispatch({ t: "voteStatus", status: "failed" });
    }
  }, [guid]);

  const castVote = useCallback(
    (target: string, verdict: Verdict) => {
      dispatch({ t: "ballot", target, verdict });
      if (voteTimer.current) clearTimeout(voteTimer.current);
      voteTimer.current = setTimeout(() => void flushVote(), 450);
    },
    [flushVote],
  );

  /** Send a game.* custom message as myself, kept out of conversation previews. */
  const sendCustom = useCallback(
    async (type: string, data: Record<string, unknown>) => {
      const CometChat = sdk.current;
      if (!CometChat) throw new Error("offline");
      const msg = new CometChat.CustomMessage(guid, CometChat.RECEIVER_TYPE.GROUP, type, data);
      msg.shouldUpdateConversation(false);
      await CometChat.sendCustomMessage(msg);
    },
    [guid],
  );

  const submitTrust = useCallback(
    async (most: string, least: string) => {
      const { game, me } = stateRef.current;
      if (!game.roundId || game.phase !== "TRUST" || !me) return;
      dispatch({ t: "myTrust", most, least, status: "sending" });
      try {
        const data = { roundId: game.roundId, sealed: await seal({ roundId: game.roundId, most, least }, await ballotKey()) };
        await sendCustom(CUSTOM_TYPES.trust, data);
        dispatch({ t: "myTrust", status: "sent" });
        dispatch({ t: "custom", evts: [{ type: CUSTOM_TYPES.trust, uid: me.uid, data, at: Date.now() }] });
      } catch {
        dispatch({ t: "myTrust", status: "failed" });
      }
    },
    [sendCustom],
  );

  /** Exactly one final defense: the button locks before the send, and the server keeps the first. */
  const submitDefense = useCallback(
    async (raw: string) => {
      const { game, me, defenses, defenseStatus } = stateRef.current;
      const text = raw.trim().slice(0, 140);
      if (!game.roundId || game.phase !== "DEFENSE" || !me || !text) return;
      if (defenses[me.uid] || defenseStatus === "sending" || defenseStatus === "locked") return;
      stopTyping();
      dispatch({ t: "defenseStatus", status: "sending" });
      try {
        await sendCustom(CUSTOM_TYPES.defense, { roundId: game.roundId, text });
        dispatch({ t: "custom", evts: [{ type: CUSTOM_TYPES.defense, uid: me.uid, data: { roundId: game.roundId, text }, at: Date.now() }] });
      } catch {
        dispatch({ t: "defenseStatus", status: "failed" });
      }
    },
    [sendCustom, stopTyping],
  );

  const pickInEvent = useCallback(
    async (pick: string) => {
      const { game, me } = stateRef.current;
      const event = game.event;
      if (!event || !game.roundId || !me || pick === me.uid) return;
      dispatch({ t: "myPick", eventId: event.id, pick });
      try {
        const data = {
          roundId: game.roundId,
          eventId: event.id,
          sealed: await seal({ roundId: game.roundId, eventId: event.id, pick }, await ballotKey()),
        };
        await sendCustom(CUSTOM_TYPES.pick, data);
        dispatch({ t: "custom", evts: [{ type: CUSTOM_TYPES.pick, uid: me.uid, data, at: Date.now() }] });
      } catch {
        /* the picker stays open; the player can tap again */
      }
    },
    [sendCustom],
  );

  const advanceBusy = useRef(false);
  const advance = useCallback(
    async (
      body:
        | { action: "start"; chatSeconds: 60 | 120 | 180 | 300 }
        | { action: "trust"; force?: boolean }
        | { action: "defense" }
        | { action: "vote" }
        | { action: "reveal" }
        | { action: "lobby" },
    ) => {
      if (advanceBusy.current) return;
      advanceBusy.current = true;
      try {
        const res = await api<{ state: unknown }>(`/api/rooms/${roomId}/advance`, {
          body: { ...body, expectSeq: stateRef.current.game.seq },
        });
        const game = GameStateSchema.safeParse(res.state);
        if (game.success) dispatch({ t: "game", game: game.data });
        await loadMembers();
      } finally {
        advanceBusy.current = false;
      }
    },
    [roomId, loadMembers],
  );

  const report = useCallback(
    async (messageId: number, reason: "harassment" | "hate" | "sexual" | "spam" | "other") => {
      const CometChat = sdk.current;
      try {
        if (!CometChat) throw new Error("offline");
        await CometChat.flagMessage(String(messageId), { reasonId: reason === "other" ? "spam" : reason, remark: "Reported in NOT A BOT" });
      } catch {
        // Moderation may be disabled on the CometChat app: fall back to our own log.
        await api("/api/report", { body: { roomId, messageId, reason } }).catch(() => {});
      }
    },
    [roomId],
  );

  /* ---------- derived ---------- */

  const players = useMemo(
    () => Object.values(s.players).sort((a, b) => a.joinedAt - b.joinedAt || a.uid.localeCompare(b.uid)),
    [s.players],
  );
  // CometChat never sends presence events about yourself (MCP: user-presence docs),
  // so your own seat counts as online whenever your socket is connected.
  const hostUid = useMemo(
    () => electHost(players.map((p) => (p.uid === s.me?.uid ? { ...p, online: s.connection === "connected" } : p))),
    [players, s.me?.uid, s.connection],
  );
  const isHost = !!s.me && hostUid === s.me.uid;
  useLayoutEffect(() => {
    isHostRef.current = isHost;
  }, [isHost]);

  /* ---------- host duties (any client takes over if the host stalls) ---------- */

  const lastMsgCount = useRef(0);
  const idleNudgedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!isHost || s.game.phase !== "CHAT") return;
    const incoming = s.messages.length > lastMsgCount.current;
    lastMsgCount.current = s.messages.length;
    const last = s.messages.at(-1);
    if (incoming && last && last.uid !== s.me?.uid && last.status === "sent") requestBotPlan("reply");
  }, [s.messages, isHost, s.game.phase, s.me?.uid, requestBotPlan]);

  const lastPulse = useRef(0);
  const lastLobbySync = useRef(0);
  const lastChatPoll = useRef(0);
  useEffect(() => {
    if (s.status !== "ready") return;
    const id = setInterval(() => {
      const { game, messages, voted, trusted, defenses, players: seated } = stateRef.current;
      const now = serverNow();
      const host = isHostRef.current;
      const overdue = game.endsAt !== null && now >= game.endsAt;
      const stalled = game.endsAt !== null && now >= game.endsAt + 6000;

      // Timed phases: the host moves on when the clock runs out, or early once every seated
      // player is done. Anyone takes over if the host has stalled; the server enforces the clock.
      const next = NEXT_ACTION[game.phase];
      if (next) {
        const present = game.roster.filter((uid) => seated[uid]);
        const done = game.phase === "TRUST" ? trusted : game.phase === "DEFENSE" ? defenses : game.phase === "VOTE" ? voted : null;
        const everyone = !!done && present.length > 0 && present.every((uid) => uid in done);
        if ((overdue || everyone) && (host || stalled)) void advance({ action: next }).catch(() => {});
      }
      // Lobby: re-read the case every ~5 s so a host sees join problems (e.g. the player limit).
      if (game.phase === "LOBBY" && now - lastLobbySync.current > 5000) {
        lastLobbySync.current = now;
        void syncState().catch(() => {});
      }
      if (game.phase !== "LOBBY" && now - lastChatPoll.current > 3000) {
        lastChatPoll.current = now;
        void pollChat().catch(() => {});
      }
      if (!host) return;
      if (game.phase === "CHAT") {
        // Interrogation-event heartbeat: promptly when an event is due to end, else every ~5 s.
        const eventDue = game.event !== null && now >= game.event.endsAt;
        if (eventDue || now - lastPulse.current >= 5000) {
          lastPulse.current = now;
          void api<{ state: unknown }>(`/api/rooms/${roomId}/pulse`, { body: {} })
            .then((res) => {
              const parsed = GameStateSchema.safeParse(res.state);
              if (parsed.success) dispatch({ t: "game", game: parsed.data });
            })
            .catch(() => {});
        }
      }
      if (game.phase === "CHAT" && !game.event && game.endsAt && game.endsAt - now > 8000) {
        const lastAt = messages.at(-1)?.at ?? game.phaseStartedAt;
        if (now - lastAt > 6_000 && now - game.phaseStartedAt > 8_000 && idleNudgedFor.current !== lastAt) {
          idleNudgedFor.current = lastAt;
          requestBotPlan("idle");
        }
      }
    }, 2500);
    return () => clearInterval(id);
  }, [s.status, roomId, advance, loadMembers, requestBotPlan, syncState, pollChat]);

  return {
    ...s,
    players,
    isHost,
    actions: {
      sendText,
      notifyTyping,
      castVote,
      retryVote: flushVote,
      submitTrust,
      submitDefense,
      pickInEvent,
      advance,
      report,
      resync: fullSync,
    },
  };
}

export type RoomApi = ReturnType<typeof useRoom>;
