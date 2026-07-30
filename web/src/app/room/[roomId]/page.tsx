import RoomGate from "@/components/editor/RoomGate";

export default async function RoomPage(props: PageProps<"/room/[roomId]">) {
  const { roomId } = await props.params;

  return (
    // `h-dvh`, not `h-screen`: `100vh` on mobile is the viewport *without* the
    // URL bar, so the bottom of the layout sat under it. That used to clip a
    // corner off a fixed 224px output strip; it would now hide the collapsed
    // output bar, which is the only control that brings the output back.
    // `overflow-hidden` because the panel group is the only thing allowed to
    // scroll here — the page itself never should.
    <div className="flex h-dvh flex-col overflow-hidden bg-app">
      {/* Keyed on the room so each room mounts a fresh editor — y-monaco leaves
          its cursor decorations behind, so a reused Monaco instance would show
          the previous room's cursors. On the gate, not the editor, so the
          existence check re-runs per room too. */}
      <RoomGate key={roomId} roomId={decodeURIComponent(roomId)} />
    </div>
  );
}
