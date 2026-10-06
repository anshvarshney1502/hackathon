import type { Metadata } from "next";
import { RoomScreen } from "@/components/room/RoomScreen";
import { StatusScreen } from "@/components/room/StatusScreen";
import { RoomIdSchema } from "@/lib/game/ids";

export const metadata: Metadata = {
  title: "NOT A BOT · Room",
  description: "You've been called in. Someone at this table isn't real.",
};

export default async function RoomPage({ params }: PageProps<"/r/[id]">) {
  const { id } = await params;
  const parsed = RoomIdSchema.safeParse(id.toLowerCase());
  if (!parsed.success) {
    return (
      <StatusScreen
        kicker="Wrong door"
        title="No such room"
        body="Room codes are 6 letters or numbers. Check the link you were sent."
        action={{ href: "/", label: "Back to the lobby" }}
      />
    );
  }
  return <RoomScreen roomId={parsed.data} />;
}
