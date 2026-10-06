"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useState } from "react";
import { DEFENSE_MAX_CHARS } from "@/lib/game/types";
import { useNow } from "@/hooks/useNow";
import type { RoomApi } from "@/hooks/useRoom";
import { TypingDots } from "./ChatPanel";
import type { Seat } from "./RoomView";

/**
 * ONE LAST CHANCE. Every player gets exactly one statement before the verdicts.
 * The countdown gets more urgent; statements land one by one, like testimony.
 */
export function DefenseOverlay({ room, seats }: { room: RoomApi; seats: Seat[] }) {
  const now = useNow(100);
  const reduce = useReducedMotion();
  const [draft, setDraft] = useState("");
  const me = room.me?.uid ?? "";
  const mine = room.defenses[me];
  // Public pressure only: aggregate "point at someone" results everyone already saw.
  const pointed = room.game.eventLog.filter((e) => e.type === "POINT").reduce((n, e) => n + (e.counts[me] ?? 0), 0);
  const locked = !!mine || room.defenseStatus === "locked";
  const sending = room.defenseStatus === "sending";
  const left = room.game.endsAt ? Math.max(0, room.game.endsAt - now) : 0;
  const secs = Math.ceil(left / 1000);
  const urgent = secs <= 5;
  const total = Math.max(1, (room.game.endsAt ?? 0) - room.game.phaseStartedAt);
  const statements = seats
    .map((s) => ({ seat: s, d: room.defenses[s.uid] }))
    .sort((a, b) => (a.d?.at ?? Infinity) - (b.d?.at ?? Infinity));

  return (
    <div className="flex min-h-full flex-col bg-ink/90 p-4 backdrop-blur-[3px] md:p-6">
      <div className="mx-auto w-full max-w-[620px]">
        <p className="label text-amber">Final defense</p>
        <div className="flex items-end justify-between gap-4">
          <h2 className="font-display text-[40px] font-bold uppercase leading-[0.9] md:text-[56px]">One last chance.</h2>
          <motion.p
            key={urgent ? secs : "calm"}
            initial={reduce || !urgent ? false : { scale: 1.25 }}
            animate={{ scale: 1 }}
            className={`font-display text-[52px] font-bold tabular-nums leading-none md:text-[64px] ${urgent ? "text-amber" : ""}`}
            role="timer"
            aria-label={`${secs} seconds left`}
          >
            {secs}
          </motion.p>
        </div>
        <div className="mt-2 h-1 w-full bg-line" aria-hidden="true">
          <div className={`h-full ${urgent ? "bg-amber" : "bg-paper-dim"}`} style={{ width: `${(left / total) * 100}%` }} />
        </div>
        <p className="mt-3 text-[13px] text-paper-dim">Everyone is watching. Say one thing that proves you&apos;re human.</p>
        {pointed > 0 && (
          <p className="mt-1 text-[13px] text-amber">
            The room pointed at you {pointed === 1 ? "once" : `${pointed} times`}. Make it count.
          </p>
        )}

        {locked ? (
          <div className="mt-4 border border-line-strong p-4" role="status">
            <p className="stamp inline-block text-[22px] text-amber">Defense locked</p>
            <p className="mt-2 text-[15px] text-paper">&ldquo;{mine?.text ?? draft}&rdquo;</p>
          </div>
        ) : (
          <form
            className="mt-4 flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              void room.actions.submitDefense(draft);
            }}
          >
            <label className="sr-only" htmlFor="defense">
              Your one final message
            </label>
            <input
              id="defense"
              autoFocus
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (e.target.value) room.actions.notifyTyping();
              }}
              maxLength={DEFENSE_MAX_CHARS}
              disabled={sending || left === 0}
              placeholder="Make it count. You only get one."
              className="min-w-0 flex-1 border border-amber/60 bg-ink-2 px-3 py-3 text-[16px] outline-none placeholder:text-paper-faint focus:border-amber"
            />
            <button
              disabled={!draft.trim() || sending || left === 0}
              className="font-display cursor-pointer bg-amber px-6 py-3 text-[19px] font-bold uppercase tracking-[0.08em] text-ink disabled:cursor-default disabled:opacity-40"
            >
              {sending ? "Locking…" : "Lock it in"}
            </button>
          </form>
        )}
        {room.defenseStatus === "failed" && (
          <p role="alert" className="mt-2 text-[13px] text-amber">
            It didn&apos;t send. Try once more before the clock runs out.
          </p>
        )}

        <ol className="mt-6 space-y-2" aria-live="polite" aria-label="Statements">
          <AnimatePresence initial={false}>
            {statements.map(({ seat, d }) => (
              <motion.li
                key={seat.uid}
                layout={!reduce}
                className={`border-l-2 py-1.5 pl-3 ${d ? "border-paper" : "border-line"}`}
              >
                <p className="font-display text-[15px] font-semibold uppercase tracking-[0.06em] text-paper-dim">
                  {seat.uid === me ? "You" : seat.name}
                </p>
                {d ? (
                  <motion.p
                    initial={reduce ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="text-[15px] leading-snug"
                  >
                    &ldquo;{d.text}&rdquo;
                  </motion.p>
                ) : (
                  <p className="flex items-center gap-2 text-[13px] text-paper-faint">
                    {room.typing[seat.uid] ? (
                      <>
                        <TypingDots /> composing
                      </>
                    ) : left === 0 ? (
                      "No statement."
                    ) : (
                      "…"
                    )}
                  </p>
                )}
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      </div>
    </div>
  );
}
