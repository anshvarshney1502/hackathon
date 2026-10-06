"use client";

import { useEffect, useMemo, useState } from "react";
import { serverNow } from "@/lib/client/api";
import { sceneStore, SEAT_COUNT, type SceneSeat } from "@/lib/client/sceneStore";
import { REVEAL_STEP_MS } from "@/lib/game/types";
import type { RoomApi } from "@/hooks/useRoom";
import { ChatPanel } from "./ChatPanel";
import { AliasIntro } from "./AliasIntro";
import { ConnectionBanner } from "./ConnectionBanner";
import { DefenseOverlay } from "./DefenseOverlay";
import { EventBanner } from "./EventBanner";
import { LobbyPanel } from "./LobbyPanel";
import { RevealOverlay } from "./RevealOverlay";
import { TopBar } from "./TopBar";
import { TrustOverlay } from "./TrustOverlay";
import { VoteOverlay } from "./VoteOverlay";

export interface Seat {
  uid: string;
  name: string;
}

/** Seat order: the round roster while a round runs, otherwise everyone in join order. */
export function useSeats(room: RoomApi): Seat[] {
  const { game, players } = room;
  return useMemo(() => {
    const names = new Map(players.map((p) => [p.uid, p.name]));
    // During a round every seat shows only its alias: friends can't map names to people.
    if (game.phase !== "LOBBY" && game.roster.length > 0) {
      return game.roster.map((uid) => ({ uid, name: game.aliases[uid] ?? names.get(uid) ?? "someone" }));
    }
    return players.slice(0, SEAT_COUNT).map((p) => ({ uid: p.uid, name: p.name }));
  }, [game.phase, game.roster, game.aliases, players]);
}

function useIsDesktop() {
  const [desktop, setDesktop] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return desktop;
}

export function RoomView({ room, roomId }: { room: RoomApi; roomId: string }) {
  const seats = useSeats(room);
  const desktop = useIsDesktop();
  const [sheetOpen, setSheetOpen] = useState(false);

  /* Drive the 3D table from live CometChat state. */
  useEffect(() => {
    const now = Date.now();
    const sceneSeats: (SceneSeat | null)[] = Array.from({ length: SEAT_COUNT }, (_, i) => {
      const s = seats[i];
      if (!s) return null;
      const p = room.players.find((x) => x.uid === s.uid);
      return {
        uid: s.uid,
        name: s.name,
        typing: (room.typing[s.uid] ?? 0) > now,
        signalLost: p?.signalLost ?? false,
        isMe: s.uid === room.me?.uid,
      };
    });
    const reveal = room.game.phase === "REVEAL" ? room.game.reveal : null;
    sceneStore.set({
      mode: "room",
      phase: room.game.phase,
      seats: sceneSeats,
      reveal: reveal
        ? {
            stepMs: REVEAL_STEP_MS,
            startAt: reveal.revealedAt - (serverNow() - Date.now()),
            steps: reveal.results
              .map((r) => ({ seat: seats.findIndex((s) => s.uid === r.uid), isBot: r.isBot }))
              .filter((st) => st.seat !== -1),
          }
        : null,
    });
  }, [seats, room.players, room.typing, room.game.phase, room.game.reveal, room.me?.uid]);

  // Hot seat: the lamp leans toward whoever is being questioned.
  const hotSeatUid =
    room.game.phase === "CHAT" && room.game.event && ["HOT_SEAT", "CROSS_EXAM", "CONTRADICTION"].includes(room.game.event.type)
      ? room.game.event.targetUid
      : null;
  useEffect(() => {
    const seat = hotSeatUid ? seats.findIndex((s) => s.uid === hotSeatUid) : -1;
    sceneStore.set({ focusSeat: seat === -1 ? null : seat });
  }, [hotSeatUid, seats]);

  // Whoever the room last pointed at (a public aggregate) gets a faint ring until the round ends.
  const lastPoint = room.game.eventLog.filter((e) => e.type === "POINT").at(-1);
  const suspectUid = lastPoint ? (Object.entries(lastPoint.counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null) : null;
  useEffect(() => {
    const seat = suspectUid ? seats.findIndex((s) => s.uid === suspectUid) : -1;
    sceneStore.set({ suspectSeat: seat === -1 ? null : seat });
  }, [suspectUid, seats]);

  useEffect(() => {
    if (!room.lastSpeaker) return;
    const seat = seats.findIndex((s) => s.uid === room.lastSpeaker?.uid);
    if (seat !== -1) sceneStore.set({ pulse: { seat, at: Date.now() } });
  }, [room.lastSpeaker, seats]);

  useEffect(() => {
    sceneStore.set({
      insetLeft: 0,
      insetRight: desktop ? 400 : 0,
      insetBottom: desktop ? 0 : Math.round(window.innerHeight * (sheetOpen ? 0.6 : 0.3)),
    });
  }, [desktop, sheetOpen]);

  const phase = room.game.phase;

  return (
    <main className="relative z-10 flex h-dvh flex-col overflow-hidden">
      <TopBar room={room} roomId={roomId} />
      <ConnectionBanner connection={room.connection} />
      <div className="relative flex min-h-0 flex-1">
        <section className="relative min-w-0 flex-1 overflow-y-auto" aria-label="Game">
          {phase === "LOBBY" && <LobbyPanel room={room} roomId={roomId} seats={seats} />}
          {phase === "CHAT" && <EventBanner room={room} seats={seats} />}
          <AliasIntro room={room} />
          {phase === "TRUST" && <TrustOverlay key={room.game.roundId} room={room} seats={seats} />}
          {phase === "DEFENSE" && <DefenseOverlay key={room.game.roundId} room={room} seats={seats} />}
          {phase === "VOTE" && <VoteOverlay room={room} seats={seats} />}
          {phase === "REVEAL" && <RevealOverlay room={room} roomId={roomId} seats={seats} />}
        </section>
        {desktop && (
          <aside className="flex w-[400px] shrink-0 flex-col border-l border-line bg-ink/92">
            <ChatPanel room={room} seats={seats} />
          </aside>
        )}
      </div>
      {!desktop && (
        <div
          className={`relative z-20 flex flex-col border-t border-line bg-ink/95 transition-[height] duration-300 ${
            sheetOpen ? "h-[60dvh]" : "h-[30dvh]"
          }`}
        >
          <button
            onClick={() => setSheetOpen((o) => !o)}
            className="flex w-full cursor-pointer items-center justify-center py-2"
            aria-expanded={sheetOpen}
            aria-label={sheetOpen ? "Collapse chat" : "Expand chat"}
          >
            <span className="h-1 w-10 bg-line-strong" />
          </button>
          <ChatPanel room={room} seats={seats} compact />
        </div>
      )}
    </main>
  );
}
