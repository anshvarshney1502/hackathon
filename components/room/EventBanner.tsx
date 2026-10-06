"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { EVENT_SPECS } from "@/lib/game/events";
import { ranked } from "@/lib/game/trust";
import { useNow } from "@/hooks/useNow";
import type { RoomApi } from "@/hooks/useRoom";
import { PlayerPicker } from "./PlayerPicker";
import type { Seat } from "./RoomView";

const RESULT_SHOW_MS = 9_000;

/** Interrogation events break into the chat: a hard cut, a command, a short clock. */
export function EventBanner({ room, seats }: { room: RoomApi; seats: Seat[] }) {
  const now = useNow(200);
  const reduce = useReducedMotion();
  const event = room.game.event;
  const me = room.me?.uid;
  const lastResult = room.game.eventLog.at(-1);
  const showResult = !event && lastResult && now - lastResult.endedAt < RESULT_SHOW_MS;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 p-3 md:p-5">
      <AnimatePresence mode="wait">
        {event && (
          <motion.section
            key={event.id}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -16, scaleY: 0.92 }}
            animate={{ opacity: 1, y: 0, scaleY: 1 }}
            exit={{ opacity: 0, y: -10, transition: { duration: 0.15 } }}
            transition={{ type: "spring", stiffness: 520, damping: 30 }}
            className="pointer-events-auto relative mx-auto max-w-[560px] overflow-hidden border border-amber bg-ink/95 p-4 shadow-[0_20px_50px_rgba(0,0,0,0.6)]"
            role="alert"
            aria-live="assertive"
          >
            {/* Interruption: one hard flash of the accent, then gone. */}
            {!reduce && (
              <motion.div
                initial={{ opacity: 0.85 }}
                animate={{ opacity: 0 }}
                transition={{ duration: 0.45, ease: "easeOut" }}
                className="pointer-events-none absolute inset-0 bg-amber"
                aria-hidden="true"
              />
            )}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="label text-amber">Interrogation · {EVENT_SPECS[event.type].title}</p>
                <p className="font-display mt-1 text-[24px] font-bold uppercase leading-tight md:text-[28px]">
                  {event.prompt}
                </p>
                {event.targetUid === me && event.type !== "MEMORY" && (
                  <p className="mt-1 text-[13px] font-medium text-amber">You&apos;re on the spot. Answer in the chat.</p>
                )}
                {event.examinerUid === me && <p className="mt-1 text-[13px] font-medium text-amber">You&apos;re asking. One question, make it count.</p>}
                {event.evidence.length > 0 && (
                  <div className="mt-2 space-y-1 border-l-2 border-amber pl-3 text-[13px] text-paper">
                    {event.evidence.map((q) => (
                      <p key={q}>{q}</p>
                    ))}
                  </div>
                )}
                {event.type !== "HOT_SEAT" && event.prompt !== EVENT_SPECS[event.type].instruction && (
                  <p className="mt-1 text-[13px] text-paper-dim">{EVENT_SPECS[event.type].instruction}</p>
                )}
                {event.type === "ONE_WORD" && <p className="mt-1 text-[12px] text-paper-faint">Your chat box only takes one word right now.</p>}
              </div>
              <p className="font-display shrink-0 text-[30px] font-bold tabular-nums leading-none" aria-label="Seconds left">
                {Math.max(0, Math.ceil((event.endsAt - now) / 1000))}
              </p>
            </div>
            <div className="mt-3 h-0.5 w-full bg-line" aria-hidden="true">
              <div
                className="h-full bg-amber"
                style={{ width: `${Math.max(0, (event.endsAt - now) / (event.endsAt - event.startedAt)) * 100}%` }}
              />
            </div>
            {EVENT_SPECS[event.type].mode === "pick" && (
              <div className="mt-3 max-h-[42vh] overflow-y-auto">
                <PlayerPicker
                  seats={seats.filter((s) => s.uid !== me)}
                  allSeats={seats}
                  label={event.prompt}
                  marker={event.type === "POINT" ? "Suspect" : event.type === "MEMORY" ? "Them" : "Vouched"}
                  selected={room.myPicks[event.id] ?? null}
                  onPick={(uid) => void room.actions.pickInEvent(uid)}
                />
                <p className="label mt-2">
                  {Object.keys(room.picked[event.id] ?? {}).length}/{room.game.roster.length} picked · results are shown, identities are not
                </p>
              </div>
            )}
          </motion.section>
        )}
        {showResult && lastResult && (
          <motion.section
            key={`result-${lastResult.id}`}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="pointer-events-auto mx-auto max-w-[460px] border border-line-strong bg-ink/95 p-4"
            role="status"
          >
            <p className="label text-amber">
              {lastResult.type === "POINT" ? "The room points at" : lastResult.type === "MEMORY" ? "The room remembers" : "The room vouches for"}
            </p>
            {lastResult.type === "MEMORY" && (
              <p className="mt-1 text-[13px] text-paper-dim">
                It was <span className="text-paper">{seats.find((s) => s.uid === lastResult.answerUid)?.name ?? "someone"}</span> who said{" "}
                <span className="text-paper">{lastResult.cue?.toUpperCase()}</span>.{" "}
                {lastResult.answerUid ? `${lastResult.counts[lastResult.answerUid] ?? 0} remembered.` : ""}
              </p>
            )}
            <ol className="mt-2 space-y-1.5">
              {ranked(lastResult.counts)
                .slice(0, 3)
                .map((r) => (
                  <li key={r.uid} className="flex items-center gap-3 text-[14px]">
                    <span className="font-display w-28 truncate text-[18px] font-semibold uppercase">
                      {seats.find((s) => s.uid === r.uid)?.name ?? "someone"}
                    </span>
                    <span className="h-2 bg-paper" style={{ width: `${r.count * 18}px` }} aria-hidden="true" />
                    <span className="tabular-nums text-paper-dim">
                      {r.count} {r.count === 1 ? "pick" : "picks"}
                    </span>
                  </li>
                ))}
              {Object.keys(lastResult.counts).length === 0 && <li className="text-[13px] text-paper-dim">Nobody committed.</li>}
            </ol>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
}
