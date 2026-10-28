// The few models a Calculator category names as its examples.
//
// ⚠️ NOT THE FIRST FEW. motir-ai lists a band's models cheapest first, so the head of
// the flagship band is a run of one family's dated snapshots (`gpt-4o`,
// `gpt-4o-2024-08-06`, `gpt-4o-2024-11-20`) — three names for one old model. An
// example is there to say what the category serves NOW, so the pick:
//  - drops dated snapshots (`-2024-08-06`, `-20251001`, `-2507`) and the
//    search / audio / preview / `latest` variants;
//  - keeps one model per family, its highest version (`5.5` from `claude-opus-5-5`,
//    `6.1` from `gpt-6.1-sol`);
//  - names the families in FAMILY_ORDER first, then the others in the band's own
//    order, so the examples span makers.
// A band with nothing left after the filter falls back to its first models. motir.co's
// calculator picks the same way (motir-marketing `app/_components/price/modelExamples.ts`).

/** A model id's family: the maker's name for the line, `o3` and `o4` with `gpt`. */
function family(id: string): string {
  const head = id.toLowerCase().match(/^[a-z]+/)?.[0] ?? id;
  return head === 'o' ? 'gpt' : head;
}

/** The families named first, when a band has them. */
const FAMILY_ORDER = ['claude', 'gpt'];

const DATED = /-(?:\d{4}-\d{2}-\d{2}|\d{8}|\d{4})$/;
const VARIANT = /(?:^|-)(?:search|audio|preview|latest|realtime|tts|transcribe)(?:-|$)/;

/** The first version number in an id: `5.5` from `…-5-5`, `3.8` from `qwen3.8-…`. */
function version(id: string): number {
  const m = id.match(/(\d+)(?:[.-](\d{1,2})(?!\d))?/);
  return m ? Number(`${m[1]}.${m[2] ?? '0'}`) : 0;
}

export function exampleModels(ids: readonly string[], count: number): string[] {
  const current = ids.filter((id) => !DATED.test(id) && !VARIANT.test(id));
  if (current.length === 0) return ids.slice(0, count);
  const best = new Map<string, string>();
  for (const id of current) {
    const kept = best.get(family(id));
    if (kept === undefined || version(id) > version(kept)) best.set(family(id), id);
  }
  const rank = (f: string) => {
    const i = FAMILY_ORDER.indexOf(f);
    return i === -1 ? FAMILY_ORDER.length : i;
  };
  return [...best.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .slice(0, count)
    .map(([, id]) => id);
}
