import CodeEditor from "../../components/CodeEditor";

export default async function RoomPage(props: PageProps<"/room/[roomId]">) {
  const { roomId } = await props.params;

  return (
    <div className="flex h-screen flex-col bg-[#1e1e1e]">
      <CodeEditor roomId={decodeURIComponent(roomId)} />
    </div>
  );
}
