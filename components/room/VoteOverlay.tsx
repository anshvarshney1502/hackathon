"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useMemo } from "react";
import type { Verdict } from "@/lib/game/types";
import { formatClock, useNow } from "@/hooks/useNow";
import type { RoomApi } from "@/hooks/useRoom";
import type { Seat } from "./RoomView";

function Stamp({ verdict }: { verdict: Verdict }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      key={verdict}
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 1.9, rotate: verdict === "BOT" ? 4 : -14 }}
      animate={{ opacity: 0.92, scale: 1, rotate: verdict === "BOT" ? -6 : -9 }}
      exit={{ opacity: 0, transition: { duration: 0.08 } }}
      transition={{ type: "spring", stiffness: 900, damping: 30, mass: 0.6 }}
      className="pointer-events-none absolute right-4 top-12 z-10"
      aria-hidden="true"
    >
      <span className={`stamp block text-[34px] leading-none ${verdict === "BOT" ? "text-[#94540f]" : "text-[#1a1611]"}`}>
        {verdict}
      </span>
    </motion.div>
  );
}

function SuspectCard({
  index,
  seat,
  quotes,
  defense,
  verdict,
  onVote,
}: {
  index: number;
  seat: Seat;
  quotes: string[];
  defense: string | null;
  verdict: Verdict | undefined;
  onVote: (v: Verdict) => void;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.article
      initial={reduce ? false : { opacity: 0, y: 18, rotate: index % 2 ? 0.8 : -0.8 }}
      animate={verdict && !reduce ? { opacity: 1, y: [0, 3, 0], rotate: index % 2 ? 0.5 : -0.5 } : { opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05, duration: 0.25 }}
      className="case-paper relative flex flex-col p-4 shadow-[0_18px_40px_rgba(0,0,0,0.55)]"
      aria-label={`Verdict for ${seat.name}`}
    >
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#6b5f4c]">Subject 0{index + 1}</p>
      <h3 className="font-display mt-0.5 truncate text-[30px] font-bold uppercase leading-none">{seat.name}</h3>
      <div className="mt-2 border-l-2 border-[#1a1611] pl-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#6b5f4c]">Final word</p>
        <p className="text-[14px] font-medium leading-snug text-[#1a1611]">{defense ? <>&ldquo;{defense}&rdquo;</> : <em>No statement.</em>}</p>
      </div>
      <div className="mt-2 min-h-[54px] space-y-1 text-[12.5px] leading-snug text-[#3d342a]">
        {quotes.length ? (
          quotes.map((q, i) => (
            <p key={i} className="line-clamp-2">
              &ldquo;{q}&rdquo;
            </p>
          ))
        ) : (
          <p className="italic text-[#7a6d58]">Said nothing. Suspicious, or shy.</p>
        )}
      </div>
      <AnimatePresence>{verdict && <Stamp verdict={verdict} />}</AnimatePresence>
      <div className="mt-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label={`Is ${seat.name} human or bot?`}>
        {(["HUMAN", "BOT"] as const).map((v) => (
          <button
            key={v}
            role="radio"
            aria-checked={verdict === v}
            onClick={() => onVote(v)}
            className={`font-display cursor-pointer border-2 py-2 text-[18px] font-bold uppercase tracking-[0.1em] transition-colors active:translate-y-px ${
              verdict === v
                ? v === "BOT"
                  ? "border-[#94540f] bg-[#94540f] text-[#f3ead8]"
                  : "border-[#1a1611] bg-[#1a1611] text-[#f3ead8]"
                : "border-[#1a1611]/40 text-[#1a1611] hover:border-[#1a1611]"
            }`}
          >
            {v}
          </button>
        ))}
      </div>
    </motion.article>
  );
}

export function VoteOverlay({ room, seats }: { room: RoomApi; seats: Seat[] }) {
  const now = useNow(250);
  const { game, myBallots, voted, voteStatus } = room;
  const me = room.me?.uid;
  const suspects = seats.map((s, i) => ({ s, i })).filter(({ s }) => s.uid !== me);
  const left = game.endsAt ? Math.max(0, game.endsAt - now) : 0;
  const filed = game.roster.filter((uid) => voted[uid]).length;
  const done = suspects.every(({ s }) => myBallots[s.uid]);

  const quotes = useMemo(() => {
    const byUid: Record<string, string[]> = {};
    const since = (game.roundStartedAt || game.phaseStartedAt) - 2000;
    for (const m of room.messages) {
      if (m.at < since) continue;
      (byUid[m.uid] ??= []).push(m.text);
    }
    for (const k of Object.keys(byUid)) byUid[k] = byUid[k].slice(-2);
    return byUid;
  }, [room.messages, game.roundStartedAt, game.phaseStartedAt]);

  return (
    <div className="flex min-h-full flex-col bg-ink/80 p-4 backdrop-blur-[3px] md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="label text-amber">Verdicts</p>
          <h2 className="font-display text-[34px] font-bold uppercase leading-none md:text-[44px]">Who&apos;s real?</h2>
          <p className="mt-1 text-[13px] text-paper-dim">Stamp every file. You can change your mind until the clock runs out.</p>
        </div>
        <div className="text-right">
          <p className={`font-display text-[44px] font-bold tabular-nums leading-none ${left < 10_000 ? "text-amber" : ""}`}>{formatClock(left)}</p>
          <p className="label">
            {filed}/{game.roster.length} filed
          </p>
        </div>
      </div>

      <div className="mt-5 grid flex-1 content-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {suspects.map(({ s, i }) => (
          <SuspectCard
            key={s.uid}
            index={i}
            seat={s}
            quotes={quotes[s.uid] ?? []}
            defense={room.defenses[s.uid]?.text ?? null}
            verdict={myBallots[s.uid]}
            onVote={(v) => room.actions.castVote(s.uid, v)}
          />
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3 text-[13px]" aria-live="polite">
        {me && voted[me] && Object.keys(myBallots).length === 0 && (
          <span className="text-paper-dim">Your verdicts were filed before you reconnected. Stamp again to change them.</span>
        )}
        {voteStatus === "sending" && <span className="text-paper-dim">Filing…</span>}
        {voteStatus === "sent" && (
          <span className="text-paper-dim">{done ? "All verdicts filed. Wait for the lights." : "Saved. Keep going."}</span>
        )}
        {voteStatus === "failed" && (
          <button onClick={() => void room.actions.retryVote()} className="cursor-pointer text-amber underline underline-offset-2">
            Couldn&apos;t file your verdicts. Retry
          </button>
        )}
      </div>
    </div>
  );
}
