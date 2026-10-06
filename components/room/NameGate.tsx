"use client";

import { useState } from "react";
import { ApiError, ensureSession } from "@/lib/client/api";
import { DisplayNameSchema } from "@/lib/game/ids";
import { StatusScreen } from "./StatusScreen";

/** People arriving through a shared link pick a name before sitting down. */
export function NameGate({ roomId, onReady }: { roomId: string; onReady: (name: string) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const parsed = DisplayNameSchema.safeParse(name);
    if (!parsed.success) return setError(parsed.error.issues[0].message);
    setBusy(true);
    setError(null);
    try {
      await ensureSession(parsed.data, roomId);
      onReady(parsed.data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't reach the server.");
      setBusy(false);
    }
  }

  return (
    <StatusScreen
      kicker={`Case ${roomId.toUpperCase()}`}
      title="You've been invited to a case"
      body="Tell us your real name once. Nobody sees it until the reveal: in the room you'll get a random name."
    >
      <form
        className="mt-5 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="block">
          <span className="label">What should we call you?</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={18}
            autoComplete="nickname"
            className="mt-1.5 w-full border border-line-strong bg-ink-2 px-3 py-3 text-[16px] outline-none focus:border-amber"
          />
        </label>
        <button
          disabled={busy}
          className="font-display w-full cursor-pointer bg-amber py-3 text-[19px] font-bold uppercase tracking-[0.08em] text-ink disabled:opacity-60"
        >
          {busy ? "Signing in…" : "Take a seat"}
        </button>
        <p role="alert" className="min-h-5 text-[13px] text-amber">
          {error}
        </p>
      </form>
    </StatusScreen>
  );
}
