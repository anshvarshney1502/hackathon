"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useNow } from "@/hooks/useNow";
import type { RoomApi } from "@/hooks/useRoom";

const SHOW_MS = 6_500;

/** The lights go down: everyone learns the name they'll hide behind this round. */
export function AliasIntro({ room }: { room: RoomApi }) {
  const now = useNow(250);
  const reduce = useReducedMotion();
  const { game, me } = room;
  const alias = me ? game.aliases[me.uid] : undefined;
  const show = game.phase === "CHAT" && !!alias && now - game.roundStartedAt < SHOW_MS;
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 1.04 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.4 } }}
          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-ink/80 p-6"
          role="status"
        >
          <div className="text-center">
            <p className="label text-amber">
              Identities sealed · {game.roster.length} players
            </p>
            <p className="mt-3 text-[15px] text-paper-dim">Tonight you are</p>
            <p className="font-display mt-1 text-[64px] font-bold uppercase leading-none md:text-[88px]">{alias}</p>
            <p className="mt-4 text-[13px] text-paper-dim">Your friends are in the room. Their identities aren&apos;t.</p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
