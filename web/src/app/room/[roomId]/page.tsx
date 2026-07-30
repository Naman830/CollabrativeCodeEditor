import RoomGate from "@/components/editor/RoomGate";

export default async function RoomPage(props: PageProps<"/room/[roomId]">) {
  const { roomId } = await props.params;

  return (
    // INVARIANT: `h-dvh`, not `h-screen` — `100vh` on mobile hides the collapsed
    // output bar under the URL bar, and that bar is the only way to restore output.
    <div className="flex h-dvh flex-col overflow-hidden bg-app">
      {/* Keyed on the room: a reused Monaco instance keeps the last room's cursors. */}
      <RoomGate key={roomId} roomId={decodeURIComponent(roomId)} />
    </div>
  );
}
