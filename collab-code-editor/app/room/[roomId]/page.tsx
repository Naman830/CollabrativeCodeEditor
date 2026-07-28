import RoomGate from "../../components/RoomGate";

export default async function RoomPage(props: PageProps<"/room/[roomId]">) {
  const { roomId } = await props.params;

  return (
    <div className="flex h-screen flex-col bg-[#1e1e1e]">
      {/* Keyed on the room so navigating between rooms mounts a fresh editor.
          y-monaco's binding.destroy() leaves its remote-cursor decorations on
          the model, so reusing one Monaco instance across rooms would carry
          the previous room's cursors over. The key sits on the gate rather than
          the editor so the existence check re-runs per room too. */}
      <RoomGate key={roomId} roomId={decodeURIComponent(roomId)} />
    </div>
  );
}
