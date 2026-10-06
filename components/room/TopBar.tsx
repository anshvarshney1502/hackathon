"use client";

import { useState } from "react";
import { Wordmark } from "@/components/ui/Wordmark";
import { MIN_CHAT_MS_BEFORE_FORCE } from "@/lib/game/machine";
import type { Phase } from "@/lib/game/types";
import { formatClock, useNow } from "@/hooks/useNow";
import type { RoomApi } from "@/hooks/useRoom";

const PHASE_COPY: Record<Phase, string> = {
  LOBBY: "Lobby",
  CHAT: "Interview",
  TRUST: "Trust",
  DEFENSE: "Final defense",
  VOTE: "Verdicts",
  REVEAL: "Lights up",
};

export function CopyLinkButton({ roomId, className = "" }: { roomId: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        const url = `${window.location.origin}/r/${roomId}`;
        // The invite names the case, never the person sending it.
        const text = "You've been invited to a NOT A BOT case.";
        try {
          if (navigator.share && window.matchMedia("(pointer: coarse)").matches) await navigator.share({ title: "NOT A BOT", text, url });
          else await navigator.clipboard.writeText(`${text} ${url}`);
        } catch {
          window.prompt("Copy this invite", `${text} ${url}`);
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }}
      className={`cursor-pointer border border-line-strong px-3 py-1.5 text-[12px] uppercase tracking-[0.14em] transition-colors hover:border-paper ${className}`}
    >
      {copied ? "Invite copied" : "Copy invite"}
    </button>
  );
}

export function TopBar({ room, roomId }: { room: RoomApi; roomId: string }) {
  const now = useNow(250);
  const { game } = room;
  const left = game.endsAt ? Math.max(0, game.endsAt - now) : null;
  const urgent = left !== null && left < 10_000;
  const canEndEarly = room.isHost && game.phase === "CHAT" && now - game.phaseStartedAt >= MIN_CHAT_MS_BEFORE_FORCE;

  return (
    <header className="relative z-20 border-b border-line bg-ink/90">
      <div className="flex items-center gap-3 px-4 py-2.5 md:px-6">
        <Wordmark small />
        <span className="hidden text-line-strong sm:inline">/</span>
        <span className="label hidden sm:inline">Case {roomId.toUpperCase()}</span>
        <div className="ml-auto flex items-center gap-3">
          {game.phase !== "LOBBY" && room.me && game.aliases[room.me.uid] && (
            <span className="label hidden border border-amber/60 px-2 py-1 text-amber sm:inline" title="Your name at the table this round">
              You · {game.aliases[room.me.uid]}
            </span>
          )}
          <span className="label border border-line px-2 py-1 text-paper" aria-label={`Phase: ${PHASE_COPY[game.phase]}`}>
            {game.round > 0 && <span className="text-paper-faint">R{game.round} · </span>}
            {PHASE_COPY[game.phase]}
          </span>
          {left !== null && (
            <span
              className={`font-display min-w-[64px] text-right text-[28px] font-bold tabular-nums leading-none ${urgent ? "text-amber" : "text-paper"}`}
              role="timer"
              aria-live="off"
            >
              {formatClock(left)}
            </span>
          )}
          {canEndEarly && (
            <button
              onClick={() => void room.actions.advance({ action: "trust", force: true }).catch(() => {})}
              className="hidden cursor-pointer border border-line-strong px-3 py-1.5 text-[12px] uppercase tracking-[0.14em] hover:border-amber hover:text-amber md:block"
            >
              End the interview
            </button>
          )}
          <CopyLinkButton roomId={roomId} className="hidden md:block" />
        </div>
      </div>
      {game.phase !== "LOBBY" && game.phase !== "REVEAL" && game.topic && (
        <div className="flex items-baseline gap-3 border-t border-line px-4 py-2 md:px-6">
          <span className="label shrink-0 text-amber">Topic</span>
          <p className="font-display truncate text-[20px] font-semibold uppercase leading-tight tracking-[0.02em] md:text-[24px]">
            {game.topic}
          </p>
        </div>
      )}
      {game.phase !== "LOBBY" && game.roster.length > 0 && (
        // Players by their case names only. Nothing here says who is human.
        <ul className="flex gap-x-4 gap-y-1 overflow-x-auto border-t border-line px-4 py-1.5 md:px-6" aria-label="Players">
          {game.roster.map((uid) => (
            <li
              key={uid}
              className={`label shrink-0 ${uid === room.me?.uid ? "text-amber" : room.typing[uid] ? "text-paper" : ""}`}
            >
              {game.aliases[uid] ?? "—"}
              {uid === room.me?.uid ? " (you)" : room.typing[uid] ? " …" : ""}
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}
