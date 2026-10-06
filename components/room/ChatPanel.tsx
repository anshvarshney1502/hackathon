"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { isOneWord } from "@/lib/game/events";
import type { ChatMsg, RoomApi } from "@/hooks/useRoom";
import type { Seat } from "./RoomView";

export function TypingDots() {
  return (
    <span className="inline-flex items-center gap-[3px]" aria-hidden="true">
      <span className="flicker-dot" />
      <span className="flicker-dot" />
      <span className="flicker-dot" />
    </span>
  );
}

const REASONS = [
  ["harassment", "Harassment"],
  ["hate", "Hate"],
  ["sexual", "Sexual"],
  ["spam", "Spam"],
] as const;

function MessageRow({
  m,
  showName,
  mine,
  onRetry,
  onReport,
}: {
  m: ChatMsg;
  showName: boolean;
  mine: boolean;
  onRetry: () => void;
  onReport: (reason: (typeof REASONS)[number][0]) => Promise<void>;
}) {
  const reduce = useReducedMotion();
  const [menu, setMenu] = useState(false);
  const [reported, setReported] = useState(false);
  return (
    <motion.li
      layout={reduce ? false : "position"}
      initial={reduce ? false : { opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 520, damping: 34, mass: 0.9 }}
      className={`group relative pl-3 ${showName ? "mt-3" : "mt-0.5"} ${mine ? "border-l-2 border-amber/70" : "border-l-2 border-transparent"}`}
    >
      {showName && (
        <p className="font-display text-[14px] font-semibold uppercase tracking-[0.06em] text-paper-dim">{mine ? "You" : m.name}</p>
      )}
      <p className={`break-words text-[14px] leading-snug ${m.status === "pending" ? "text-paper-dim" : "text-paper"}`}>{m.text}</p>
      {m.status === "failed" && (
        <button onClick={onRetry} className="mt-0.5 cursor-pointer text-[12px] text-amber underline underline-offset-2">
          Not sent. Retry
        </button>
      )}
      {!mine && m.id !== null && (
        <div className="absolute right-0 top-0">
          {reported ? (
            <span className="text-[11px] text-paper-faint">Reported</span>
          ) : (
            <button
              onClick={() => setMenu((v) => !v)}
              className="cursor-pointer px-1 text-[11px] uppercase tracking-[0.1em] text-paper-faint opacity-0 transition-opacity hover:text-paper focus:opacity-100 group-hover:opacity-100"
              aria-label={`Report message from ${m.name}`}
            >
              Report
            </button>
          )}
          {menu && (
            <div className="absolute right-0 top-5 z-30 flex flex-col border border-line-strong bg-ink-2 py-1 text-[12px]">
              {REASONS.map(([id, label]) => (
                <button
                  key={id}
                  className="cursor-pointer px-3 py-1.5 text-left hover:bg-ink-3"
                  onClick={async () => {
                    setMenu(false);
                    setReported(true);
                    await onReport(id);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </motion.li>
  );
}

export function ChatPanel({ room, seats, compact = false }: { room: RoomApi; seats: Seat[]; compact?: boolean }) {
  const [draft, setDraft] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const me = room.me?.uid;
  const { phase: roundPhase, roundStartedAt, aliases } = room.game;

  // During a round the chat starts fresh and speaks only in aliases: lobby talk (with real names)
  // would let people map aliases back to friends.
  const visible = useMemo(() => {
    if (roundPhase === "LOBBY" || !roundStartedAt) return room.messages;
    return room.messages
      .filter((m) => m.at >= roundStartedAt - 1500)
      .map((m) => (aliases[m.uid] ? { ...m, name: aliases[m.uid] } : m));
  }, [room.messages, roundPhase, roundStartedAt, aliases]);

  const typingNames = useMemo(() => {
    // Expired entries are pruned by useRoom, so presence in the map means "typing now".
    return Object.keys(room.typing)
      .filter((uid) => uid !== me)
      .map((uid) => seats.find((s) => s.uid === uid)?.name ?? room.players.find((p) => p.uid === uid)?.name)
      .filter((n): n is string => Boolean(n));
  }, [room.typing, me, seats, room.players]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [visible.length, typingNames.length]);

  const phase = room.game.phase;
  const oneWord = phase === "CHAT" && room.game.event?.type === "ONE_WORD";
  // Final defense is one statement each; the open chat stays silent until the verdicts.
  const closed = phase === "DEFENSE";
  const placeholder = closed
    ? "Silence. Final defenses."
    : oneWord
      ? "One word…"
      : phase === "CHAT"
        ? "Say something human…"
        : phase === "VOTE"
          ? "Make your case…"
          : phase === "LOBBY"
            ? "Say hi to the table…"
            : "Talk it over…";

  function send() {
    const text = draft.trim();
    if (!text || closed) return;
    if (oneWord && !isOneWord(text)) {
      setHint("One word only. That's the rule right now.");
      return;
    }
    setHint(null);
    setDraft("");
    void room.actions.sendText(text);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!compact && (
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <span className="label">Group chat</span>
          <span className="label text-paper-faint">{seats.length}/6 seated</span>
        </div>
      )}
      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 pb-2"
        aria-live="polite"
        aria-relevant="additions"
      >
        {visible.length === 0 ? (
          <p className="mt-6 text-center text-[13px] text-paper-faint">
            {phase === "LOBBY" ? "Nobody's said anything yet." : "New faces, clean slate. Somebody break the ice."}
          </p>
        ) : (
          <ul>
            <AnimatePresence initial={false}>
              {visible.map((m, i) => (
                <MessageRow
                  key={m.key}
                  m={m}
                  mine={m.uid === me}
                  showName={i === 0 || visible[i - 1].uid !== m.uid}
                  onRetry={() => void room.actions.sendText(m.text, m.key)}
                  onReport={(reason) => (m.id !== null ? room.actions.report(m.id, reason) : Promise.resolve())}
                />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
      <div className="h-6 px-4 text-[12px] text-paper-dim" aria-live="polite">
        {hint && oneWord ? (
          <span className="text-amber">{hint}</span>
        ) : typingNames.length > 0 && (
          <span className="inline-flex items-center gap-2">
            <TypingDots />
            {typingNames.length === 1 ? `${typingNames[0]} is typing` : `${typingNames.length} people typing`}
          </span>
        )}
      </div>
      <form
        className="flex gap-2 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setHint(null);
            if (e.target.value) room.actions.notifyTyping();
          }}
          disabled={closed}
          maxLength={oneWord ? 30 : 280}
          placeholder={placeholder}
          aria-label="Message"
          className="min-w-0 flex-1 border border-line-strong bg-ink-2 px-3 py-2.5 text-[16px] outline-none placeholder:text-paper-faint focus:border-amber md:text-[14px]"
        />
        <button
          type="submit"
          disabled={!draft.trim() || closed}
          className="font-display cursor-pointer bg-paper px-4 text-[16px] font-bold uppercase tracking-[0.08em] text-ink transition-opacity disabled:cursor-default disabled:opacity-30"
        >
          Send
        </button>
      </form>
    </div>
  );
}
