"use client";

import { useEffect, useRef, useState } from "react";
import { CHAT_DURATIONS, MAX_PLAYERS } from "@/lib/game/types";
import type { RoomApi } from "@/hooks/useRoom";
import { TypingDots } from "./ChatPanel";
import type { Seat } from "./RoomView";
import { ScoringRules } from "./ScoringRules";
import { CopyLinkButton } from "./TopBar";

export function LobbyPanel({ room, roomId, seats }: { room: RoomApi; roomId: string; seats: Seat[] }) {
  const [minutes, setMinutes] = useState<(typeof CHAT_DURATIONS)[number]>(room.game.chatSeconds);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scores = room.game.scores;
  const hasScores = seats.some((s) => scores[s.uid]);

  // "Play solo" lands here with ?solo=1: same room, same engine, it just starts right away.
  const autoStarted = useRef(false);
  const { isHost, actions } = room;
  const firstRound = room.game.round === 0;
  useEffect(() => {
    if (autoStarted.current || !isHost || !firstRound) return;
    if (new URLSearchParams(window.location.search).get("solo") !== "1") return;
    autoStarted.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    void actions.advance({ action: "start", chatSeconds: 180 }).catch(() => {});
  }, [isHost, firstRound, actions]);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      await room.actions.advance({ action: "start", chatSeconds: minutes });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the round");
      setStarting(false);
    }
  }

  return (
    <div className="flex min-h-full items-end p-4 md:p-6">
      <div className="w-full max-w-[400px] border border-line bg-ink/88 p-5 backdrop-blur-[2px]">
        <p className="label text-amber">Case ready</p>
        <h2 className="font-display mt-1 text-[32px] font-bold uppercase leading-none">Invite people you trust.</h2>
        <p className="mt-2 text-[13px] text-paper-dim">
          Identities are sealed when the case begins. Everyone gets a new name, so nobody knows which chair their friend took.
        </p>
        <p className="label mt-3">6 seats · at least one is never human</p>

        <ol className="mt-4 divide-y divide-line border-y border-line">
          {Array.from({ length: MAX_PLAYERS }, (_, i) => {
            const seat = seats[i];
            const isMe = seat?.uid === room.me?.uid;
            return (
              <li key={i} className="flex items-center gap-3 py-2 text-[14px]">
                <span className="w-6 text-paper-faint">0{i + 1}</span>
                {seat ? (
                  <>
                    {/* Anonymous lobby: nobody's real name is shown, not even to friends. */}
                    <span className={isMe ? "text-amber" : "text-paper"}>{isMe ? "You" : "Anonymous player"}</span>
                    {hasScores && <span className="ml-auto tabular-nums text-paper-dim">{scores[seat.uid] ?? 0} pts</span>}
                  </>
                ) : (
                  <span className="text-paper-faint">open seat</span>
                )}
              </li>
            );
          })}
        </ol>

        {/* Never let invitees silently become bots: say exactly what happened. */}
        {room.game.lobbyNotice && (
          <div role="alert" className="mt-4 border border-amber/70 p-3 text-[13px]">
            <p className="label text-amber">Someone couldn&apos;t get in</p>
            <p className="mt-1 text-paper">
              {room.game.lobbyNotice.count === 1 ? "An invited player was" : `${room.game.lobbyNotice.count} join attempts were`} turned
              away: this game has hit its player-account limit (100 on the free CometChat plan).
            </p>
            <p className="mt-1 text-paper-dim">Free up space, then ask them to reload the invite. If you start now, their seats will be filled by AI.</p>
          </div>
        )}

        {room.isHost ? (
          <div className="mt-4">
            <p className="label">Interview length</p>
            <div className="mt-1.5 grid grid-cols-4 border border-line-strong" role="radiogroup" aria-label="Interview length">
              {CHAT_DURATIONS.map((d) => (
                <button
                  key={d}
                  role="radio"
                  aria-checked={minutes === d}
                  onClick={() => setMinutes(d)}
                  className={`cursor-pointer py-2 text-[13px] transition-colors ${minutes === d ? "bg-paper text-ink" : "text-paper-dim hover:text-paper"}`}
                >
                  {d / 60} min
                </button>
              ))}
            </div>
            <button
              onClick={() => void start()}
              disabled={starting}
              className="font-display mt-3 w-full cursor-pointer bg-amber py-3 text-[20px] font-bold uppercase tracking-[0.08em] text-ink active:translate-y-px disabled:cursor-wait disabled:opacity-60"
            >
              {starting ? "Dimming the lights…" : "Lights down. Begin."}
            </button>
            <p className="mt-2 text-[12px] text-paper-faint">
              {seats.length === 1
                ? "Only you are here. Begin now and it's a solo case: every other seat goes to AI."
                : `${seats.length} people seated. Empty chairs won't stay empty.`}
            </p>
            {error && (
              <p role="alert" className="mt-2 text-[13px] text-amber">
                {error}
              </p>
            )}
          </div>
        ) : (
          <p className="mt-4 inline-flex items-center gap-2 text-[13px] text-paper-dim">
            <TypingDots /> Waiting for the host to begin.
          </p>
        )}

        <div className="mt-4 flex items-center justify-between gap-3">
          <ScoringRules />
          <CopyLinkButton roomId={roomId} />
        </div>
      </div>
    </div>
  );
}
