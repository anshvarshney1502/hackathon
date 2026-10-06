"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError, ensureSession, readSession } from "@/lib/client/api";
import { publicEnv } from "@/lib/client/env";
import { SEAT_COUNT, sceneStore } from "@/lib/client/sceneStore";
import { DisplayNameSchema, normalizeRoomCode, RoomIdSchema } from "@/lib/game/ids";
import { ConfigError } from "./ui/ConfigError";
import { Wordmark } from "./ui/Wordmark";

const SUSPECTS = ["?", "?", "?", "?", "?", "?"];

/** Ambient life for the landing scene: silhouettes "type" now and then. */
function useAmbientTable() {
  useEffect(() => {
    sceneStore.set({
      mode: "landing",
      phase: "LOBBY",
      reveal: null,
      insetRight: 0,
      insetBottom: 0,
      insetLeft: window.innerWidth >= 1024 ? 520 : 0,
      seats: SUSPECTS.map((name, i) => ({ uid: `ghost-${i}`, name, typing: false, signalLost: false, isMe: false })),
    });
    const id = setInterval(() => {
      const seats = sceneStore.get().seats.map((s) => (s ? { ...s, typing: Math.random() < 0.18 } : s));
      const speaker = Math.floor(Math.random() * SEAT_COUNT);
      sceneStore.set({ seats, pulse: Math.random() < 0.4 ? { seat: speaker, at: Date.now() } : sceneStore.get().pulse });
    }, 1700);
    return () => clearInterval(id);
  }, []);
}

export function Landing() {
  const router = useRouter();
  const [name, setName] = useState("");
  // The real name is asked once. After that it's remembered and only shown back to you.
  const [known, setKnown] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"create" | "solo" | "join" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const env = publicEnv();
  useAmbientTable();

  useEffect(() => {
    const stored = readSession();
    // Prefill from the persisted session (browser-only, so it has to happen after mount).
    if (!stored) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(stored.name);
    setKnown(true);
  }, []);

  const nameCheck = DisplayNameSchema.safeParse(name);

  async function create(solo = false) {
    if (!nameCheck.success) return setError(nameCheck.error.issues[0].message);
    setBusy(solo ? "solo" : "create");
    setError(null);
    try {
      await ensureSession(nameCheck.data);
      const { roomId } = await api<{ roomId: string }>("/api/rooms", { body: {} });
      router.push(solo ? `/r/${roomId}?solo=1` : `/r/${roomId}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't open a room. Try again.");
      setBusy(null);
    }
  }

  async function join() {
    if (!nameCheck.success) return setError(nameCheck.error.issues[0].message);
    const roomId = normalizeRoomCode(code);
    if (!RoomIdSchema.safeParse(roomId).success) return setError("Room codes are 6 letters or numbers.");
    setBusy("join");
    setError(null);
    try {
      await ensureSession(nameCheck.data, roomId);
      router.push(`/r/${roomId}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't reach the server.");
      setBusy(null);
    }
  }

  if (!env.ok) return <ConfigError missing={env.missing} />;

  return (
    <main className="relative z-10 flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-5 py-4 md:px-10">
        <Wordmark />
        <span className="label hidden sm:block">Interrogation room 06 · after hours</span>
      </header>

      <div className="flex flex-1 flex-col justify-end px-5 pb-8 md:justify-center md:px-10 md:pb-16">
        <section className="w-full max-w-[460px] rounded-none border border-line bg-ink/80 p-6 backdrop-blur-[2px] md:p-8">
          <p className="label mb-3 text-amber">Case open</p>
          <h1 className="font-display text-[44px] font-bold uppercase leading-[0.92] md:text-[58px]">
            Can you tell
            <br />
            who&apos;s real?
          </h1>
          <p className="mt-4 text-[14px] text-paper-dim">
            Your friends are in the room.
            <br />
            Their identities aren&apos;t.
          </p>

          <form
            className="mt-7 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            {known ? (
              <p className="flex items-baseline justify-between text-[13px] text-paper-dim">
                <span>
                  Playing as <span className="text-paper">{name}</span>. Hidden until the reveal.
                </span>
                <button type="button" onClick={() => setKnown(false)} className="cursor-pointer text-[12px] uppercase tracking-[0.14em] underline underline-offset-4 hover:text-paper">
                  Change
                </button>
              </p>
            ) : (
            <label className="block">
              <span className="label">What should we call you?</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={18}
                autoComplete="nickname"
                placeholder="your real name"
                className="mt-1.5 w-full border border-line-strong bg-ink-2 px-3 py-3 text-[16px] text-paper outline-none placeholder:text-paper-faint focus:border-amber"
              />
              <span className="mt-1 block text-[11px] text-paper-faint">Nobody sees it until the reveal. You&apos;ll play under a random name.</span>
            </label>
            )}
            <button
              type="submit"
              disabled={busy !== null}
              className="font-display w-full cursor-pointer bg-amber py-3.5 text-[20px] font-bold uppercase tracking-[0.08em] text-ink transition-[transform,background] duration-150 hover:bg-[#ffb653] active:translate-y-px disabled:cursor-wait disabled:opacity-60"
            >
              {busy === "create" ? "Opening the room…" : "Play with friends"}
            </button>
            <button
              type="button"
              onClick={() => void create(true)}
              disabled={busy !== null}
              className="font-display w-full cursor-pointer border border-line-strong py-3 text-[18px] font-semibold uppercase tracking-[0.08em] transition-colors hover:border-paper disabled:opacity-60"
            >
              {busy === "solo" ? "Pulling up chairs…" : "Play solo"}
            </button>
          </form>

          <div className="mt-3 flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void join()}
              placeholder="room code"
              aria-label="Room code"
              maxLength={40}
              className="min-w-0 flex-1 border border-line-strong bg-ink-2 px-3 py-3 text-[16px] uppercase tracking-[0.2em] outline-none placeholder:normal-case placeholder:tracking-normal placeholder:text-paper-faint focus:border-amber"
            />
            <button
              type="button"
              onClick={() => void join()}
              disabled={busy !== null}
              className="font-display cursor-pointer border border-line-strong px-5 text-[18px] font-semibold uppercase tracking-[0.08em] transition-colors hover:border-paper disabled:opacity-60"
            >
              {busy === "join" ? "…" : "Join"}
            </button>
          </div>

          <p role="alert" aria-live="polite" className="mt-3 min-h-5 text-[13px] text-amber">
            {error}
          </p>

          <ol className="mt-4 space-y-2 border-t border-line pt-5 text-[13px] text-paper-dim">
            <li className="flex gap-3">
              <span className="text-amber">01</span> Chat under a fake name. Bluff if you like.
            </li>
            <li className="flex gap-3">
              <span className="text-amber">02</span> Trust, accuse, defend. Then stamp HUMAN or BOT.
            </li>
            <li className="flex gap-3">
              <span className="text-amber">03</span> Lights up. Score for every right call.
            </li>
          </ol>
        </section>
        <p className="label mt-4 max-w-[460px] normal-case tracking-normal text-paper-faint">
          Trust no one. Especially the one who types fast.
        </p>
      </div>
    </main>
  );
}
