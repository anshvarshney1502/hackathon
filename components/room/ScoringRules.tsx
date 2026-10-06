"use client";

import { useState } from "react";

/** The exact rules lib/game/scoring.ts implements, in plain words. */
export function ScoringRules() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="cursor-pointer text-[12px] uppercase tracking-[0.14em] text-paper-dim underline decoration-line-strong underline-offset-4 hover:text-paper"
      >
        How scoring works
      </button>
      {open && (
        <div className="absolute bottom-8 left-0 z-30 w-[300px] border border-line-strong bg-ink-2 p-4 text-[13px] leading-relaxed text-paper-dim shadow-2xl">
          <p className="label mb-2 text-amber">Scoring</p>
          <ul className="space-y-1.5">
            <li>
              <span className="text-paper">+1</span> for every player you label correctly.
            </li>
            <li>
              <span className="text-paper">+2</span> if most humans believe <em>you</em> are human.
            </li>
            <li>A bot wins if most humans call it HUMAN.</li>
            <li>Bots vote too. They can be wrong.</li>
          </ul>
        </div>
      )}
    </div>
  );
}
