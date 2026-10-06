"use client";

import { motion, useReducedMotion } from "framer-motion";
import type { Seat } from "./RoomView";

/**
 * A list of suspects to choose one from. Reused by Trust and the "point at / defend" events.
 * Selection is shown with a text marker as well as colour (never colour alone).
 */
export function PlayerPicker({
  seats,
  allSeats,
  selected,
  onPick,
  label,
  marker,
  disabled = false,
  excluded = [],
}: {
  seats: Seat[];
  /** Full seat list, for stable "Subject 0n" numbering. */
  allSeats: Seat[];
  selected: string | null;
  onPick: (uid: string) => void;
  label: string;
  /** Text shown on the chosen row, e.g. "Trusted". */
  marker: string;
  disabled?: boolean;
  excluded?: string[];
}) {
  const reduce = useReducedMotion();
  return (
    <ul role="radiogroup" aria-label={label} className="divide-y divide-line border-y border-line">
      {seats.map((s, i) => {
        const chosen = selected === s.uid;
        const off = excluded.includes(s.uid);
        return (
          <motion.li
            key={s.uid}
            layout={!reduce}
            initial={reduce ? false : { opacity: 0, x: i % 2 ? 10 : -10 }}
            animate={{ opacity: off ? 0.35 : 1, x: 0 }}
            transition={{ delay: reduce ? 0 : i * 0.06, type: "spring", stiffness: 420, damping: 32 }}
          >
            <button
              role="radio"
              aria-checked={chosen}
              disabled={disabled || off}
              onClick={() => onPick(s.uid)}
              className={`flex w-full cursor-pointer items-center gap-3 py-3 pl-3 pr-2 text-left transition-colors disabled:cursor-not-allowed ${
                chosen ? "border-l-2 border-amber bg-ink-3" : "border-l-2 border-transparent hover:bg-ink-2"
              }`}
            >
              <span className="w-6 text-[12px] text-paper-faint">0{allSeats.findIndex((x) => x.uid === s.uid) + 1}</span>
              <span className="font-display flex-1 truncate text-[22px] font-semibold uppercase leading-none">{s.name}</span>
              {chosen && <span className="label text-amber">{marker}</span>}
              {off && !chosen && <span className="label">taken</span>}
            </button>
          </motion.li>
        );
      })}
    </ul>
  );
}
