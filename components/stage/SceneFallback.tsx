"use client";

import { useEffect, useState } from "react";
import { SEAT_COUNT, useSceneState } from "@/lib/client/sceneStore";

/**
 * 2D stand-in for the interrogation room: same seats, same lamp, same reveal cues.
 * Used while three.js loads, without WebGL, on low-end devices, or when 3D is switched off.
 */
export function SceneFallback({ quiet = false }: { quiet?: boolean }) {
  const scene = useSceneState();
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!scene.reveal) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [scene.reveal]);

  const step = scene.reveal ? Math.floor((now - scene.reveal.startAt) / scene.reveal.stepMs) : -1;
  const shiftX = (scene.insetLeft - scene.insetRight) / 2;
  const shiftY = -scene.insetBottom / 2;

  return (
    <div className="absolute inset-0 overflow-hidden bg-ink">
      <div
        className="absolute left-1/2 top-[42%] h-[min(62vw,420px)] w-[min(62vw,420px)]"
        style={{ transform: `translate(calc(-50% + ${shiftX}px), calc(-50% + ${shiftY}px))` }}
      >
        {/* lamp pool */}
        <div className="absolute inset-[-30%] rounded-full bg-[radial-gradient(circle,rgba(242,163,58,0.18)_0%,transparent_60%)]" />
        {/* table */}
        <div className="absolute inset-[22%] rounded-full border border-line-strong bg-ink-3 shadow-[inset_0_0_60px_rgba(0,0,0,0.8)]" />
        {!quiet &&
          Array.from({ length: SEAT_COUNT }, (_, i) => {
            const seat = scene.seats[i];
            const a = Math.PI / 6 + (i * Math.PI) / 3;
            const x = 50 + Math.sin(a) * 44;
            const y = 50 + Math.cos(a) * 44;
            const revealIdx = scene.reveal?.steps.findIndex((s) => s.seat === i) ?? -1;
            const revealed = revealIdx !== -1 && step >= revealIdx;
            const isBot = revealed && scene.reveal?.steps[revealIdx].isBot;
            const active = revealIdx !== -1 && step === revealIdx;
            return (
              <div
                key={i}
                className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
                style={{ left: `${x}%`, top: `${y}%` }}
              >
                <div
                  className={[
                    "h-10 w-10 rounded-t-full border transition-all duration-500",
                    !seat ? "border-dashed border-line opacity-40" : "border-line-strong bg-ink-2",
                    seat?.typing ? "shadow-[0_0_18px_rgba(242,163,58,0.45)]" : "",
                    active ? "scale-125 border-amber" : "",
                    revealed && isBot ? "border-dashed border-paper-dim bg-transparent" : "",
                    revealed && !isBot ? "bg-amber/70" : "",
                    seat?.signalLost ? "opacity-40" : "",
                  ].join(" ")}
                />
                {seat && <span className="max-w-20 truncate text-[10px] text-paper-dim">{seat.name}</span>}
              </div>
            );
          })}
      </div>
    </div>
  );
}
