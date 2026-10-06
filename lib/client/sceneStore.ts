"use client";

import { useSyncExternalStore } from "react";
import type { Phase } from "@/lib/game/types";

export const SEAT_COUNT = 6;

export interface SceneSeat {
  uid: string;
  name: string;
  typing: boolean;
  signalLost: boolean;
  isMe: boolean;
}

export interface SceneReveal {
  /** Seat index order to spotlight, with the verdict for each. */
  steps: { seat: number; isBot: boolean }[];
  startAt: number;
  stepMs: number;
}

export interface SceneState {
  mode: "landing" | "room";
  phase: Phase;
  seats: (SceneSeat | null)[];
  pulse: { seat: number; at: number } | null;
  reveal: SceneReveal | null;
  /** Pixels covered by UI on the right / bottom, so the table stays framed in what's visible. */
  insetRight: number;
  insetBottom: number;
  insetLeft: number;
  /** Seat the lamp leans toward outside the reveal (hot seat). */
  focusSeat: number | null;
  /** Seat the room last pointed at (public event result): a faint suspicion ring. */
  suspectSeat: number | null;
}

let state: SceneState = {
  mode: "landing",
  phase: "LOBBY",
  seats: Array(SEAT_COUNT).fill(null),
  pulse: null,
  reveal: null,
  insetRight: 0,
  insetBottom: 0,
  insetLeft: 0,
  focusSeat: null,
  suspectSeat: null,
};

const listeners = new Set<() => void>();

export const sceneStore = {
  get: () => state,
  set(patch: Partial<SceneState>) {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useSceneState(): SceneState {
  return useSyncExternalStore(sceneStore.subscribe, sceneStore.get, sceneStore.get);
}
