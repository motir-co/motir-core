import { CircleCheck, CircleEllipsis, CirclePause } from 'lucide-react';
import { Pill, type PillProps } from '@/components/ui/Pill';
import type { StatusCategoryDto } from '@/lib/dto/workflows';

// THE STATUS CHIP, IN ONE PLACE (MOTIR-3103).
//
// ── Why it stopped being a bare map ─────────────────────────────────────────
// Every surface used to write `<Pill status={STATUS_TONE[category]}>` for
// itself, and the map was per-CATEGORY: `todo → planned`, `in_progress →
// in-progress`, `done → done`. That was true enough while the categories held
// one interesting status each. `implemented` (MOTIR-3003) broke it: it sits in
// the `in_progress` category with In Progress, Planning and In Review, so four
// statuses rendered a byte-identical chip and the only thing telling them apart
// was the label — which is exactly what MOTIR-2999's acceptance criterion rules
// out ("a person can tell BUILT from READY FOR ME without reading the label").
//
// So the tone is resolved by status KEY first and by CATEGORY second, and it is
// resolved HERE — one component, seven call sites, no second copy of the rule.
// This mirrors `lib/workflows/statusColor.ts`, which does exactly this for the
// status DOT and for the same reason (MOTIR-1273 un-collapsed `in_review` there
// long before this axis needed it).
//
// ── The glyph is not decoration ─────────────────────────────────────────────
// A per-status chip is a 14% tint over the surface, which is a deliberately
// quiet mark. Finding #35 forbids resting a state on colour alone, so the one
// status whose whole point is "you cannot tell these apart" carries a glyph as
// well — and it is the SAME `CircleEllipsis` the shipped CI pill uses for a
// running build (`components/github/DevelopmentSection.tsx`), because that is
// literally what a card at Implemented is waiting for. It is `aria-hidden`, so
// the accessible name stays the status label.
//
// ── Server-safe on purpose ──────────────────────────────────────────────────
// No `'use client'`: two of the seven call sites are PUBLIC project pages that
// render on the server. `Pill` is a plain span and the icon is inline SVG, so
// this renders in both trees unchanged.

/** The PER-STATUS tones. A key in here wins over its category (below). */
const TONE_BY_STATUS_KEY: Record<string, NonNullable<PillProps['status']>> = {
  implemented: 'implemented',
  // MOTIR-5141 — the SECOND per-status tone, for the same reason as the first.
  // `approved` sits in the `in_progress` category beside In Progress, Planning
  // and In Review, so without this row a person cannot tell A PERSON SAID YES
  // from NOBODY HAS LOOKED YET, which is the whole point of the status.
  approved: 'approved',
  // The THIRD (To plan): an `in_progress`-category status that must NOT read
  // as In Progress — a card stopped because a decision it rests on changed is
  // the opposite of work being done.
  to_plan: 'to-plan',
};

/** The per-CATEGORY fallback — the mapping every status had before, unchanged,
 *  so a custom workflow's own status still gets its lifecycle bucket's chip. */
const TONE_BY_CATEGORY: Record<StatusCategoryDto, NonNullable<PillProps['status']>> = {
  todo: 'planned',
  in_progress: 'in-progress',
  done: 'done',
};

/**
 * Statuses that take the NEUTRAL chip rather than their category's hue
 * (MOTIR-4777 · MOTIR-4782, `design/workbench/design-notes.md` § Recently
 * finished).
 *
 * `cancelled` is a `done`-category status that means ABANDONED, not
 * accomplished, and until the Workbench there was no surface where the two sat
 * side by side — `/home` excluded done work outright, and a board column or a
 * detail rail shows one card at a time. Recently finished lists them together,
 * and giving Cancelled the accomplishment tint there would be a false claim in
 * a colour.
 *
 * It is fixed HERE rather than branched at that one list, because the claim is
 * not local: a cancelled card is not an achievement on `/items`, on a board or
 * in a mention either. The same discrimination `applyStatusTransition`'s
 * `completedAt` stamp and `roadmapDoneStatusKeys` already make.
 */
const NEUTRAL_STATUS_KEYS: ReadonlySet<string> = new Set(['cancelled']);

/** The glyph a status carries in addition to its label, or none. */
const GLYPH_BY_STATUS_KEY: Record<string, typeof CircleEllipsis> = {
  implemented: CircleEllipsis,
  // `CircleCheck` against `done`'s bare `Check`: the same mark, formalised — a
  // person put a ring around it. It joins the `Circle*` vocabulary this ramp
  // already speaks, and it is load-bearing rather than decorative: `approved`
  // and `done` are the two closest chips in the set at a 14% tint.
  approved: CircleCheck,
  // A ring around a pause: stopped, and not being worked. It also tells this
  // chip apart from the computed "To plan" slot pill a childless story wears,
  // which shares the label and means something else.
  to_plan: CirclePause,
};

/**
 * The HUED `Pill` tone for a workflow status: its own tone when it has one, else
 * its lifecycle category's. Exported for the surfaces that need the tone without
 * the component (a legend, a test); everything that renders a chip should use
 * {@link StatusPill} instead so the glyph travels with it.
 *
 * **`null` means the NEUTRAL chip**, and two different statuses reach it: one
 * this project cannot classify (a status a project deleted, with cards still
 * pointing at it), and one that is deliberately not hued — see
 * {@link NEUTRAL_STATUS_KEYS}. They render the same chip because they are
 * making the same claim about it, which is none.
 */
export function statusPillTone(
  statusKey: string | null | undefined,
  category: StatusCategoryDto | null,
): NonNullable<PillProps['status']> | null {
  if (statusKey && NEUTRAL_STATUS_KEYS.has(statusKey)) return null;
  if (statusKey && TONE_BY_STATUS_KEY[statusKey]) return TONE_BY_STATUS_KEY[statusKey]!;
  return category ? TONE_BY_CATEGORY[category] : null;
}

export interface StatusPillProps {
  /** The workflow status KEY (`in_progress`, `implemented`, a custom one). */
  statusKey: string | null | undefined;
  /** Its lifecycle category — the fallback, and null for an unresolvable status. */
  category: StatusCategoryDto | null;
  /** The status's display label, which is the chip's accessible name. */
  label: string;
  className?: string;
}

/**
 * ONE work-item status, as its chip. A status with no hued tone renders the
 * neutral chip rather than disappearing — an unresolvable one (a status a
 * project deleted still has cards pointing at it), and `cancelled`, which is
 * neutral on purpose.
 */
export function StatusPill({ statusKey, category, label, className }: StatusPillProps) {
  const tone = statusPillTone(statusKey, category);
  const Glyph = statusKey ? GLYPH_BY_STATUS_KEY[statusKey] : undefined;
  if (!tone) {
    return (
      <Pill tone="neutral" {...(className ? { className } : {})}>
        {label}
      </Pill>
    );
  }
  return (
    <Pill status={tone} {...(className ? { className } : {})}>
      {Glyph ? <Glyph className="h-3 w-3" aria-hidden /> : null}
      {label}
    </Pill>
  );
}
