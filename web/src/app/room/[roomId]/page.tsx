import RoomGate from "@/components/editor/RoomGate";

export default async function RoomPage(props: PageProps<"/room/[roomId]">) {
  const { roomId } = await props.params;

  return (
    // INVARIANT: `h-dvh`, not `h-screen` — `100vh` on mobile hides the collapsed
    // output bar under the URL bar, and that bar is the only way to restore output.
    <div className="flex h-dvh flex-col overflow-hidden bg-app">
      {/* Keyed on the room: a reused Monaco instance keeps the last room's cursors. */}
      {/* INVARIANT: no decodeURIComponent — App Router already delivers this decoded. Decoding
          twice threw URIError on `/room/%` (an unauthenticated 500) and silently resolved
          `/room/%2541` to a *different* room than the URL named. y-websocket does not encode the
          room name either, so this value is exactly the doc name the sync server will see. */}
      <RoomGate key={roomId} roomId={roomId} />
    </div>
  );
}
