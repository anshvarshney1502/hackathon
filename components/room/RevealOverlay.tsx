"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useState } from "react";
import { ranked } from "@/lib/game/trust";
import { type PlayerResult, REVEAL_PREFACE_MS, REVEAL_STEP_MS, type RevealDetail } from "@/lib/game/types";
import { AWARD_TITLES, buildRecap } from "@/lib/game/recap";
import { useNow } from "@/hooks/useNow";
import type { RoomApi } from "@/hooks/useRoom";
import type { Seat } from "./RoomView";
import { CopyLinkButton } from "./TopBar";

const VERDICT_AT = 0.38;
type DetailRow = RevealDetail["players"][number];


function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line py-1">
      <dt className="label">{label}</dt>
      <dd className="font-display text-[20px] font-bold tabular-nums">{value}</dd>
    </div>
  );
}

function ObjectiveBlock({ objective }: { objective: NonNullable<DetailRow["objective"]> }) {
  const done = objective.status === "COMPLETED";
  return (
    <div className="mt-3 border border-line-strong p-3">
      <p className="label text-amber">Secret objective</p>
      <p className="mt-1 text-[15px] leading-snug">{objective.title}</p>
      <p className={`stamp mt-2 inline-block text-[18px] leading-none ${done ? "text-amber" : "text-paper-dim"}`}>
        {done ? "✓ Completed" : "✕ Failed"}
      </p>
    </div>
  );
}

function Spotlight({
  r,
  row,
  index,
  t,
  isMe,
  humanVoters,
  nameOf,
}: {
  r: PlayerResult;
  row: DetailRow | undefined;
  index: number;
  t: number;
  isMe: boolean;
  humanVoters: number;
  nameOf: (uid: string) => string;
}) {
  const reduce = useReducedMotion();
  const shown = t >= VERDICT_AT;
  return (
    <motion.article
      key={r.uid}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12, transition: { duration: 0.15 } }}
      transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}
      className="relative max-h-[78dvh] w-full max-w-[560px] overflow-y-auto border border-line bg-ink/92 p-5 backdrop-blur-[2px]"
      aria-live="polite"
    >
      <p className="label">
        Subject 0{index + 1}
        {isMe && " · you"}
      </p>
      <div className="mt-1 flex items-end justify-between gap-4">
        <h2 className="font-display truncate text-[44px] font-bold uppercase leading-[0.9] md:text-[54px]">{r.name}</h2>
        <AnimatePresence>
          {shown && (
            <motion.span
              initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 2.2, rotate: -18 }}
              animate={{ opacity: 1, scale: 1, rotate: -7 }}
              transition={{ type: "spring", stiffness: 700, damping: 26 }}
              className={`stamp shrink-0 text-[38px] leading-none md:text-[46px] ${r.isBot ? "text-amber" : "text-paper"}`}
            >
              {r.isBot ? "Bot" : "Human"}
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      {/* Social consequences land before the stamp: what the table believed, then the truth. */}
      {row && humanVoters > 0 && (
        <div className="mt-2 space-y-0.5 text-[14px]">
          <p>
            {row.humansSaidHuman === 0
              ? "No human believed "
              : `${row.humansSaidHuman} ${row.humansSaidHuman === 1 ? "human" : "humans"} believed `}
            {r.name} was human.
          </p>
          {row.trustedBy.length > 0 && (
            <p className="text-paper-dim">
              Trusted most by {row.trustedBy.map(nameOf).join(", ")}.
            </p>
          )}
        </div>
      )}

      {shown && (
        <motion.div initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: reduce ? 0 : 0.35 }}>
          {/* Layer two of the reveal: who (or what) was actually in the chair. */}
          {row?.realName && (
            <motion.p
              initial={reduce ? false : { opacity: 0, letterSpacing: "0.4em" }}
              animate={{ opacity: 1, letterSpacing: "0.02em" }}
              transition={{ delay: reduce ? 0 : 0.5, duration: 0.6 }}
              className="mt-2 text-[15px]"
            >
              Actually: <span className="font-display text-[26px] font-bold uppercase">{row.realName}</span>
            </motion.p>
          )}
          {row?.personaName && (
            <p className="mt-2 text-[15px]">
              AI persona: <span className="font-display text-[22px] font-bold uppercase">{row.personaName}</span>
            </p>
          )}
          {row && <p className="mt-1 text-[15px] italic text-paper-dim">&ldquo;{row.archetype}&rdquo;</p>}
          <dl className="mt-3 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
            <Stat label="Messages" value={r.messages} />
            {r.isBot ? <Stat label="Humans fooled" value={`${r.fooled} / ${humanVoters}`} /> : <Stat label="Correct calls" value={r.correctGuesses} />}
            <Stat label="Called human / bot" value={`${r.votesHuman} / ${r.votesBot}`} />
            <Stat label="Trusted most" value={r.trustMost} />
            <Stat label="Trusted least" value={r.trustLeast} />
            {(r.pointedAt > 0 || r.defendedBy > 0) && <Stat label="Pointed at / vouched" value={`${r.pointedAt} / ${r.defendedBy}`} />}
          </dl>
          {row?.defense && <p className="mt-3 text-[13px] text-paper-dim">Final word: &ldquo;{row.defense}&rdquo;</p>}
          {row?.objective && <ObjectiveBlock objective={row.objective} />}
          {row?.persona && (
            <div className="mt-3">
              <p className="label">Persona</p>
              <p className="mt-1 text-[14px]">{row.persona.line}</p>
              <p className="text-[13px] text-paper-dim">{row.persona.traits.join(" · ")}</p>
            </div>
          )}
          <p className="mt-3 text-[13px] text-paper-dim">
            {r.isBot
              ? r.botWon
                ? "Bot wins the room."
                : r.majorityCorrect
                  ? "The table saw through it."
                  : "Nobody pinned it down."
              : `+${r.roundScore} this round${r.humanBonus ? " · passed as human" : ""}`}
          </p>
        </motion.div>
      )}
    </motion.article>
  );
}

function SocialPreface({ results, seats }: { results: PlayerResult[]; seats: Seat[] }) {
  const reduce = useReducedMotion();
  const name = (uid: string) => results.find((r) => r.uid === uid)?.name ?? seats.find((s) => s.uid === uid)?.name ?? "someone";
  const most = ranked(Object.fromEntries(results.map((r) => [r.uid, r.trustMost]))).slice(0, 2);
  const least = ranked(Object.fromEntries(results.map((r) => [r.uid, r.trustLeast]))).slice(0, 2);
  const block = (title: string, rows: { uid: string; count: number }[], delay: number) => (
    <motion.div initial={reduce ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay }}>
      <p className="label text-amber">{title}</p>
      {rows.length === 0 ? (
        <p className="mt-1 text-[13px] text-paper-dim">No consensus.</p>
      ) : (
        rows.map((r) => (
          <div key={r.uid} className="mt-1.5 flex items-center gap-3">
            <span className="font-display w-32 truncate text-[24px] font-bold uppercase">{name(r.uid)}</span>
            <span className="h-2.5 bg-paper" style={{ width: `${r.count * 22}px` }} aria-hidden="true" />
            <span className="text-[13px] tabular-nums text-paper-dim">
              {r.count} {r.count === 1 ? "vote" : "votes"}
            </span>
          </div>
        ))
      )}
    </motion.div>
  );
  return (
    <div className="w-full max-w-[520px] border border-line bg-ink/92 p-5" role="status">
      <p className="label">Identities unsealed in a moment</p>
      <div className="mt-3 space-y-4">
        {block("Most trusted", most, 0.2)}
        {block("Least trusted", least, 1.2)}
      </div>
    </div>
  );
}

export function RevealOverlay({ room, roomId, seats }: { room: RoomApi; roomId: string; seats: Seat[] }) {
  const now = useNow(100);
  const reduce = useReducedMotion();
  const [skipped, setSkipped] = useState(false);
  const [resetting, setResetting] = useState(false);
  const reveal = room.game.reveal;
  if (!reveal) return null;

  const results = reveal.results;
  const detail = room.revealDetail?.roundId === reveal.roundId ? room.revealDetail.detail : null;
  const rowOf = (uid: string) => detail?.players.find((p) => p.uid === uid);
  const elapsed = now - reveal.revealedAt;
  const idx = Math.floor(elapsed / REVEAL_STEP_MS);
  const t = (elapsed % REVEAL_STEP_MS) / REVEAL_STEP_MS;
  const finished = skipped || idx >= results.length;
  const me = room.me?.uid;
  const seatIndex = (uid: string) => seats.findIndex((s) => s.uid === uid);
  const humanVoters = results.filter((r) => !r.isBot && r.voted).length;
  const nameOf = (uid: string) => results.find((r) => r.uid === uid)?.name ?? "someone";

  if (!finished) {
    return (
      <div className="flex min-h-full flex-col items-start justify-end gap-3 p-4 md:p-6">
        <div className="flex gap-1.5" aria-hidden="true">
          {results.map((r, i) => (
            <span key={r.uid} className={`h-1 w-7 ${i < idx ? "bg-paper-dim" : i === idx ? "bg-amber" : "bg-line-strong"}`} />
          ))}
        </div>
        {elapsed < 0 ? (
          elapsed < -REVEAL_PREFACE_MS - 400 ? (
            <p className="font-display text-[34px] font-bold uppercase">The lights are coming up…</p>
          ) : (
            <SocialPreface results={results} seats={seats} />
          )
        ) : (
          <AnimatePresence mode="wait">
            <Spotlight
              key={results[idx].uid}
              r={results[idx]}
              row={rowOf(results[idx].uid)}
              index={seatIndex(results[idx].uid)}
              t={t}
              isMe={results[idx].uid === me}
              humanVoters={humanVoters}
              nameOf={nameOf}
            />
          </AnimatePresence>
        )}
        <button onClick={() => setSkipped(true)} className="cursor-pointer text-[12px] uppercase tracking-[0.14em] text-paper-faint hover:text-paper">
          Skip to the file
        </button>
      </div>
    );
  }

  const total = (uid: string) => room.game.scores[uid] ?? 0;
  // Composition-aware: a Solo Case never shows human-vs-human stats like "Most bot-like human".
  const recap = buildRecap({ results, awards: reveal.awards, detail });
  const realOf = (uid: string) => detail?.players.find((p) => p.uid === uid)?.realName;
  const personaOf = (uid: string) => detail?.players.find((p) => p.uid === uid)?.personaName;

  return (
    <div className="flex min-h-full items-start justify-center bg-ink/75 p-4 backdrop-blur-[3px] md:p-6">
      <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-[680px] border border-line bg-ink-2 p-5 md:p-6">
        <p className="label text-amber">Case closed · identities unsealed · round {room.game.round}</p>
        <h2 className="font-display text-[40px] font-bold uppercase leading-none">{recap.title}</h2>
        {recap.intro.map((line) => (
          <p key={line} className="mt-1 text-[14px] text-paper-dim">
            {line}
          </p>
        ))}

        <dl className="mt-4 grid grid-cols-2 gap-x-6 border-y border-line py-2 sm:grid-cols-3">
          {recap.rows.map(([k, v], i) => (
            <motion.div
              key={k}
              initial={reduce ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: reduce ? 0 : 0.1 + i * 0.12 }}
              className="py-1.5"
            >
              <dt className="label">{k}</dt>
              <dd className="font-display text-[22px] font-bold uppercase leading-tight">{v}</dd>
            </motion.div>
          ))}
        </dl>

        <div className="mt-4">
          <p className="label">Roster</p>
          <ul className="mt-1 divide-y divide-line border-y border-line">
            {results.map((r, i) => (
              <motion.li
                key={r.uid}
                initial={reduce ? false : { opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: reduce ? 0 : 0.2 + i * 0.1 }}
                className="flex flex-wrap items-baseline gap-x-3 py-1.5"
              >
                <span className="font-display w-28 text-[20px] font-bold uppercase">{r.name}</span>
                <span className={`label ${r.isBot ? "text-amber" : "text-paper"}`}>{r.isBot ? "Bot" : "Human"}</span>
                <span className="text-[13px] text-paper-dim">
                  {r.isBot ? (personaOf(r.uid) ? `Persona: ${personaOf(r.uid)}` : "") : realOf(r.uid) ? `Actually: ${realOf(r.uid)}` : ""}
                  {r.uid === me ? " (you)" : ""}
                </span>
              </motion.li>
            ))}
          </ul>
        </div>

        {reveal.awards.length > 0 && (
          <ul className="mt-4 grid gap-3 sm:grid-cols-2" aria-label="Awards">
            {reveal.awards.filter((a) => recap.kind === "SOCIAL" || a.kind !== "bot_like_human").map((a, i) => (
              <motion.li
                key={a.kind}
                initial={reduce ? false : { opacity: 0, y: 12, rotate: i % 2 ? 0.6 : -0.6 }}
                animate={{ opacity: 1, y: 0, rotate: 0 }}
                transition={{ delay: reduce ? 0 : 0.25 + i * 0.45, type: "spring", stiffness: 380, damping: 28 }}
                className="border border-line p-3"
              >
                <p className="label">{AWARD_TITLES[a.kind]}</p>
                <p className="font-display mt-1 text-[24px] font-bold uppercase">{nameOf(a.uid)}</p>
                <p className="text-[12px] text-paper-dim">{a.detail}</p>
              </motion.li>
            ))}
          </ul>
        )}

        <details className="mt-4">
          <summary className="cursor-pointer text-[12px] uppercase tracking-[0.14em] text-paper-dim hover:text-paper">The full file</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-[13px]">
            <thead>
              <tr className="label">
                <th className="py-2 font-normal">Player</th>
                <th className="py-2 font-normal">Was</th>
                <th className="py-2 font-normal">Objective</th>
                <th className="py-2 text-right font-normal">H / B</th>
                <th className="py-2 text-right font-normal">Trust + / −</th>
                <th className="py-2 text-right font-normal">Round</th>
                <th className="py-2 text-right font-normal">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line border-t border-line">
              {results.map((r) => {
                const obj = rowOf(r.uid)?.objective;
                return (
                  <tr key={r.uid} className={r.uid === me ? "text-amber" : ""}>
                    <td className="py-2">
                      {r.name}
                      {realOf(r.uid) && <span className="text-paper-dim"> · actually {realOf(r.uid)}</span>}
                      {!realOf(r.uid) && personaOf(r.uid) && <span className="text-paper-dim"> · AI as {personaOf(r.uid)}</span>}
                      {r.uid === me && <span className="text-paper-faint"> (you)</span>}
                    </td>
                    <td className="py-2">
                      <span className={`font-display text-[15px] font-bold uppercase tracking-[0.08em] ${r.isBot ? "text-amber" : "text-paper"}`}>
                        {r.isBot ? "Bot" : "Human"}
                      </span>
                      {r.botWon && <span className="ml-1 text-[11px] text-paper-dim">won</span>}
                    </td>
                    <td className="py-2 text-paper-dim" title={obj?.title}>
                      {obj ? (obj.status === "COMPLETED" ? "✓ done" : "✕ failed") : "·"}
                    </td>
                    <td className="py-2 text-right tabular-nums text-paper-dim">
                      {r.votesHuman} / {r.votesBot}
                    </td>
                    <td className="py-2 text-right tabular-nums text-paper-dim">
                      {r.trustMost} / {r.trustLeast}
                    </td>
                    <td className="py-2 text-right tabular-nums">{r.isBot ? `${r.fooled} fooled` : `+${r.roundScore}`}</td>
                    <td className="py-2 text-right tabular-nums">{r.isBot ? "·" : total(r.uid)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </details>

        {detail && detail.players.some((p) => p.objective) && (
          <details className="mt-3 text-[13px] text-paper-dim">
            <summary className="cursor-pointer uppercase tracking-[0.14em] hover:text-paper">What the bots were secretly trying to do</summary>
            <ul className="mt-2 space-y-1">
              {detail.players
                .filter((p) => p.objective)
                .map((p) => (
                  <li key={p.uid}>
                    <span className="text-paper">{nameOf(p.uid)}</span>: {p.objective?.title}{" "}
                    <span className="text-paper">{p.objective?.status === "COMPLETED" ? "✓ completed" : "✕ failed"}</span>
                  </li>
                ))}
            </ul>
          </details>
        )}

        <p className="mt-3 text-[11px] text-paper-faint">
          {room.revealVerified === true && "Roster was sealed at round start (sha-256 commitment) and verified on your device. No one swapped the bots."}
          {room.revealVerified === false && "Warning: the revealed roster does not match the commitment published at round start."}
          {room.revealVerified === null && "Verifying the sealed roster…"}
        </p>

        <p className="font-display mt-5 text-[24px] font-bold uppercase">Could you tell who was real?</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {room.isHost ? (
            <button
              disabled={resetting}
              onClick={async () => {
                setResetting(true);
                await room.actions.advance({ action: "lobby" }).catch(() => setResetting(false));
              }}
              className="font-display cursor-pointer bg-amber px-6 py-3 text-[19px] font-bold uppercase tracking-[0.08em] text-ink disabled:opacity-60"
            >
              {resetting ? "Clearing the table…" : "Play again"}
            </button>
          ) : (
            <p className="text-[13px] text-paper-dim">The host will reset the table.</p>
          )}
          <CopyLinkButton roomId={roomId} />
        </div>
      </motion.div>
    </div>
  );
}
