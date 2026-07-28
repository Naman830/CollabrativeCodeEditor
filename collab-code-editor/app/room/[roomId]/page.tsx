import RoomGate from "../../components/RoomGate";

export default async function RoomPage(props: PageProps<"/room/[roomId]">) {
  const { roomId } = await props.params;

  return (
    <div className="flex h-screen flex-col bg-app">
      {/* Keyed on the room so each room mounts a fresh editor — y-monaco leaves
          its cursor decorations behind, so a reused Monaco instance would show
          the previous room's cursors. On the gate, not the editor, so the
          existence check re-runs per room too. */}
      <RoomGate key={roomId} roomId={decodeURIComponent(roomId)} />
    </div>
  );
}
