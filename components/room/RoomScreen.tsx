"use client";

import { useEffect, useState } from "react";
import { readSession } from "@/lib/client/api";
import { publicEnv } from "@/lib/client/env";
import { ConfigError } from "@/components/ui/ConfigError";
import { useRoom } from "@/hooks/useRoom";
import { NameGate } from "./NameGate";
import { RoomView } from "./RoomView";
import { StatusScreen } from "./StatusScreen";

const ERRORS: Record<string, { kicker: string; title: string; body: string; retry?: boolean }> = {
  not_found: { kicker: "Wrong door", title: "Room not found", body: "This room doesn't exist or has been cleared. Open a new one." },
  full: { kicker: "No chairs left", title: "Case is full", body: "Five people are already in (the sixth seat always goes to an AI). Start your own case." },
  invalid_room: { kicker: "Wrong door", title: "No such room", body: "Check the link you were sent." },
  server_not_configured: { kicker: "Room is dark", title: "Server not configured", body: "The server is missing environment variables. See the README." },
  network: { kicker: "No signal", title: "Can't reach the server", body: "Check your connection and try again.", retry: true },
  player_limit: {
    kicker: "No room at the table",
    title: "Player limit reached",
    body: "This game's free CometChat plan allows 100 player accounts and they're all used. The host has been told. Ask them to free up space, then try again.",
    retry: true,
  },
  rate_limited: { kicker: "Easy", title: "Too many attempts", body: "Wait a few seconds and try again.", retry: true },
};

export function RoomScreen({ roomId }: { roomId: string }) {
  const [name, setName] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // localStorage is browser-only; resolve the stored identity after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(readSession()?.name ?? null);
    setChecked(true);
  }, []);

  const env = publicEnv();
  if (!env.ok) return <ConfigError missing={env.missing} />;
  if (!checked) return <StatusScreen kicker="Checking ID" title="One moment" busy />;
  if (!name) return <NameGate roomId={roomId} onReady={setName} />;
  return <ConnectedRoom key={attempt} roomId={roomId} name={name} onRetry={() => setAttempt((a) => a + 1)} />;
}

function ConnectedRoom({ roomId, name, onRetry }: { roomId: string; name: string; onRetry: () => void }) {
  const room = useRoom(roomId, name);

  if (room.status === "error") {
    const known = ERRORS[room.error?.code ?? ""];
    return (
      <StatusScreen
        kicker={known?.kicker ?? "Line dropped"}
        title={known?.title ?? "Couldn't join"}
        body={known?.body ?? room.error?.message ?? "Something went wrong while joining."}
        onRetry={known && !known.retry ? undefined : onRetry}
        action={{ href: "/", label: "Back to the lobby" }}
      />
    );
  }
  if (room.status === "waiting") {
    return (
      <StatusScreen
        kicker="Round in progress"
        title="Hold at the door"
        body="A round is running. You'll be seated automatically when it ends."
        busy
        action={{ href: "/", label: "Leave" }}
      />
    );
  }
  if (room.status !== "ready" || !room.me) {
    return <StatusScreen kicker="Taking your seat" title="Lights coming up" body="Connecting to the room…" busy />;
  }
  return <RoomView room={room} roomId={roomId} />;
}
