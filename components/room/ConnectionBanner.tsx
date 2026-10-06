"use client";

import { AnimatePresence, motion } from "framer-motion";
import type { Connection } from "@/hooks/useRoom";

export function ConnectionBanner({ connection }: { connection: Connection }) {
  const show = connection !== "connected";
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="relative z-20 overflow-hidden bg-amber text-ink"
          role="status"
        >
          <p className="flex items-center justify-center gap-2 py-1.5 text-[12px] font-medium uppercase tracking-[0.14em]">
            <span className="inline-block h-1.5 w-1.5 animate-pulse bg-ink" />
            {connection === "disconnected" ? "Signal lost. Reconnecting…" : "Reconnecting…"}
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
