"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useState } from "react";
import { formatClock, useNow } from "@/hooks/useNow";
import type { RoomApi } from "@/hooks/useRoom";
import { PlayerPicker } from "./PlayerPicker";
import type { Seat } from "./RoomView";

/**
 * Quiet, psychological beat between the interview and the defenses. Not "who is a bot",
 * but "who would you trust?". Two steps, one pick each, then sealed.
 */
export function TrustOverlay({ room, seats }: { room: RoomApi; seats: Seat[] }) {
  const now = useNow(250);
  const reduce = useReducedMotion();
  const me = room.me?.uid;
  const others = seats.filter((s) => s.uid !== me);
  const [most, setMost] = useState<string | null>(room.myTrust.most);
  const [least, setLeast] = useState<string | null>(room.myTrust.least);
  const step = most === null ? 1 : 2;
  // Also sealed if we reconnected after picking: the envelope is in history, its content stays private.
  const sealed = room.trustStatus === "sent" || room.trustStatus === "sending" || (!!me && !!room.trusted[me]);
  const left = room.game.endsAt ? Math.max(0, room.game.endsAt - now) : 0;
  const decided = room.game.roster.filter((uid) => room.trusted[uid]).length;
  const nameOf = (uid: string | null) => seats.find((s) => s.uid === uid)?.name ?? "";

  return (
    <div className="flex min-h-full flex-col items-center bg-ink/85 p-4 backdrop-blur-[3px] md:justify-center md:p-6">
      <div className="w-full max-w-[460px]">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="label text-amber">Trust · step {sealed ? 2 : step} of 2</p>
            <AnimatePresence mode="wait">
              <motion.h2
                key={sealed ? "sealed" : step}
                initial={reduce ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.35 }}
                className="font-display text-[36px] font-bold uppercase leading-none md:text-[44px]"
              >
                {sealed ? "Your read is sealed" : step === 1 ? "Who do you trust?" : "Who do you trust least?"}
              </motion.h2>
            </AnimatePresence>
            <p className="mt-1 text-[13px] text-paper-dim">
              {sealed ? "Nobody sees your picks until the lights come up." : "Not who's a bot. Who feels like a real person you'd trust. Pick one."}
            </p>
          </div>
          <div className="text-right" aria-live="off">
            <p className="font-display text-[34px] font-bold tabular-nums leading-none">{formatClock(left)}</p>
            <p className="label">
              {decided}/{room.game.roster.length} decided
            </p>
          </div>
        </div>

        <div className="mt-5">
          {sealed ? (
            <dl className="divide-y divide-line border-y border-line text-[14px]">
              <div className="flex justify-between py-3">
                <dt className="label">Trust most</dt>
                <dd className="font-display text-[22px] font-semibold uppercase">{nameOf(most) || "Sealed"}</dd>
              </div>
              <div className="flex justify-between py-3">
                <dt className="label">Trust least</dt>
                <dd className="font-display text-[22px] font-semibold uppercase">{nameOf(least) || "Sealed"}</dd>
              </div>
            </dl>
          ) : (
            <PlayerPicker
              seats={others}
              allSeats={seats}
              label={step === 1 ? "Who do you trust most?" : "Who do you trust least?"}
              marker={step === 1 ? "Trusted" : "Least"}
              selected={step === 1 ? most : least}
              excluded={step === 2 && most ? [most] : []}
              onPick={(uid) => (step === 1 ? setMost(uid) : setLeast(uid))}
            />
          )}
        </div>

        {!sealed && (
          <div className="mt-4 flex items-center gap-3">
            {step === 2 && (
              <button
                onClick={() => {
                  setMost(null);
                  setLeast(null);
                }}
                className="cursor-pointer border border-line-strong px-4 py-3 text-[12px] uppercase tracking-[0.14em] hover:border-paper"
              >
                Back
              </button>
            )}
            <button
              disabled={step === 1 || !least}
              onClick={() => most && least && void room.actions.submitTrust(most, least)}
              className="font-display flex-1 cursor-pointer bg-amber py-3 text-[19px] font-bold uppercase tracking-[0.08em] text-ink transition-opacity disabled:cursor-default disabled:opacity-30"
            >
              {step === 1 ? "Pick who you trust" : least ? "Seal it" : "Pick who you trust least"}
            </button>
          </div>
        )}
        {room.trustStatus === "failed" && (
          <p role="alert" className="mt-2 text-[13px] text-amber">
            Couldn&apos;t seal your picks. Tap Seal it again.
          </p>
        )}
      </div>
    </div>
  );
}
