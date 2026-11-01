// The Production room's title and lede — the Environment room's settings header
// markup, shared by the page and its not-found state.
export function ProductionHeader({ title, lede }: { title: string; lede: string }) {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{title}</h1>
      <p className="font-sans text-sm text-(--el-text-secondary)">{lede}</p>
    </header>
  );
}
