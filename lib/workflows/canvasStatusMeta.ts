import {
  Ban,
  Check,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleDotDashed,
  CircleEllipsis,
  Eye,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import { DEFAULT_STATUS_KEYS } from '@/lib/workflows/defaultWorkflow';

// THE CANVAS STATUS CHIP, IN ONE PLACE (bug MOTIR-3170).
//
// ── Why this module exists ──────────────────────────────────────────────────
// The canvas kept a THIRD, private copy of the status vocabulary — a
// six-member `WorkItemStatus` union in `WorkItemNode`, plus a `KNOWN_STATUSES`
// literal in `lib/planning/roadmapClient` and another in `PlanItemNode`. Each
// coerced anything outside its set to `todo`, so `implemented` (MOTIR-3003) and
// `planning` (MOTIR-2425) — both added to the default workflow years after the
// node was written — drew on every canvas as **To Do**. A card whose pull
// request is open read as *not started*, which is worse than reading as
// nothing: a gap invites a second look and a confident wrong answer does not.
//
// It is also not only about those two keys. A project may define its OWN
// workflow statuses (a shipped feature), and `RoadmapNodeDto.status` is a bare
// `string` precisely because the set is not closed. Six hard-coded keys means
// every customer's own vocabulary renders as To Do.
//
// So the resolution order is the one `statusElVar` (`lib/workflows/statusColor.ts`,
// the status DOT) and `statusPillTone` (`components/issues/StatusPill.tsx`, the
// item-page CHIP) already use, for the same reason both of them do:
//
//   1. the status KEY, when the canvas has a treatment for it;
//   2. else its lifecycle CATEGORY (a custom status still reads as todo-ish /
//      active / resolved);
//   3. else the neutral chip — which is an HONEST unknown, not an impersonation
//      of a real state the card is definitively not in.
//
// ── Why `--el-tint-*` and not the documented chip recipe ────────────────────
// The canvas chip language is the flat six-tint palette family
// (`design/roadmap/design-notes.md`: *"status pill — tinted chip … per-status
// tint"*), deliberately, because `--el-tint-*` are PALETTE tokens whose author
// keeps the six mutually distinct — so the node states flip together and stay
// separable under every `data-palette`. The item-page chip uses a different
// recipe (`color-mix(var(--el-status-X) 14%, var(--el-surface))`,
// `packages/design-system/theme.css`). Adding two rows in the existing tint
// language is a code change; switching the canvas to the mix recipe would be a
// LANGUAGE change and owes `design/roadmap/` an amendment first — so this does
// the former and leaves the latter to a design card.
//
// The two new tints follow the mapping the existing five already imply, which
// mirrors the `--el-status-*` hue family: done↔mint↔success-green,
// in_progress↔sky↔info-blue, in_review↔lavender↔brand-indigo,
// blocked↔peach↔warning-amber. `--el-status-implemented` is `--color-accent`
// (pink), so `implemented` takes `--el-tint-rose`. `--el-status-planning` is
// teal and NO tint in the six-token family is teal, so `planning` takes the one
// remaining unspent tint, `--el-tint-yellow` — a defensible reading in its own
// right (a card whose plan is being reconsidered is an attention state) and, in
// the absence of a teal tint, the only choice that keeps the chip set mutually
// distinct.
//
// ── Not only the canvas any more (MOTIR-10534) ──────────────────────────────
// The "two recipes" above were two surfaces' recipes. Since MOTIR-10534 this
// chip is THE work item's status chip wherever the item's state is shown as a
// tag: the roadmap canvas card, the /boards card, the quick view header, the
// item page's eyebrow and its rail's read-only status, all through
// `components/workItems/WorkItemStateTags.tsx`. The `color-mix` recipe stays on
// the surfaces that EDIT a status (the item page's `StatusPicker`) and on the
// list rows' `StatusPill`, which that card left alone. The name stays
// `canvasStatusMeta` because the canvas is where the language is specified
// (`design/roadmap/design-notes.md`); a rename would touch every import for no
// reader's benefit.
//
// ── Not colour alone ────────────────────────────────────────────────────────
// Finding #35: every node state is icon + label + tint. `implemented` carries
// the SAME `CircleEllipsis` the shipped `StatusPill` gives it (and the CI pill
// in `DevelopmentSection` uses for a running build) — no new vocabulary, and it
// is literally what the card is waiting for. `planning` carries
// `CircleDotDashed`, one step off `in_progress`'s `CircleDot`: in progress on
// the planning axis, provisionally. Both are `aria-hidden`; the LABEL is the
// accessible name.

/** The three things a canvas status chip draws: its glyph, its fill, its ink. */
export interface CanvasStatusMeta {
  icon: LucideIcon;
  /** A `--el-tint-*` / `--el-muted` fill utility. */
  tint: string;
  /** The matching ink utility for AA on that fill. */
  text: string;
}

/** The receded, quiet chip — `todo`, `cancelled`, and every status we cannot
 *  place. It says "nothing to read here", which is the honest thing for a key
 *  this build has never heard of. */
const NEUTRAL: CanvasStatusMeta = {
  icon: CircleDashed,
  tint: 'bg-(--el-muted)',
  text: 'text-(--el-text-secondary)',
};

/** PER-KEY treatments. A key in here wins over its category (below). Every
 *  default-workflow key has a row; a project's custom key falls through. */
const META_BY_KEY: Record<string, CanvasStatusMeta> = {
  todo: NEUTRAL,
  blocked: { icon: Ban, tint: 'bg-(--el-tint-peach)', text: 'text-(--el-text-strong)' },
  in_progress: { icon: CircleDot, tint: 'bg-(--el-tint-sky)', text: 'text-(--el-text-strong)' },
  implemented: {
    icon: CircleEllipsis,
    tint: 'bg-(--el-tint-rose)',
    text: 'text-(--el-text-strong)',
  },
  planning: {
    icon: CircleDotDashed,
    tint: 'bg-(--el-tint-yellow)',
    text: 'text-(--el-text-strong)',
  },
  in_review: { icon: Eye, tint: 'bg-(--el-tint-lavender)', text: 'text-(--el-text-strong)' },
  // A person's YES (MOTIR-5141). ⚠️ THE SIX-TINT FAMILY WAS SPENT — this
  // module's own header records `planning` taking "the one remaining unspent
  // tint" — so `approved` takes a SEVENTH, `--el-tint-sage`, added to the base
  // token block for it. That is the in-LANGUAGE answer the header asks for; the
  // alternative it warns against is switching the canvas to the item page's
  // `color-mix` recipe, which would be a language change.
  //
  // Borrowing a tint another status already holds was the third option and is
  // the one that is actually forbidden: it re-creates MOTIR-3170 exactly — two
  // statuses rendering as one on the canvas. `CircleCheck` against `done`'s
  // bare `Check` is the same distinction the item-page chip draws, so the two
  // surfaces tell the same story about the same pair.
  approved: { icon: CircleCheck, tint: 'bg-(--el-tint-sage)', text: 'text-(--el-text-strong)' },
  done: { icon: Check, tint: 'bg-(--el-tint-mint)', text: 'text-(--el-text-strong)' },
  cancelled: { ...NEUTRAL, icon: XCircle },
};

/** The per-CATEGORY fallback: a custom status still reads as its lifecycle
 *  bucket rather than as a specific state it is not in. `todo` deliberately
 *  resolves to the neutral chip — the same one `todo` itself draws. */
const META_BY_CATEGORY: Record<StatusCategoryDto, CanvasStatusMeta> = {
  todo: NEUTRAL,
  in_progress: META_BY_KEY.in_progress!,
  done: META_BY_KEY.done!,
};

/**
 * The chip treatment for ONE workflow status on the canvas: its own when it has
 * one, else its lifecycle category's, else the neutral chip. Never throws and
 * never returns undefined — an unknown key is a rendering question, not an
 * error, and this read sits under a best-effort level fetch.
 */
export function canvasStatusMeta(
  statusKey: string | null | undefined,
  category: StatusCategoryDto | null | undefined,
): CanvasStatusMeta {
  if (statusKey && META_BY_KEY[statusKey]) return META_BY_KEY[statusKey]!;
  return category ? META_BY_CATEGORY[category] : NEUTRAL;
}

/**
 * The DISPLAY LABEL for a status on the canvas — the shipped rule, which the
 * filter bar, the advanced-filter editor and its summary all already write:
 * a PROTECTED default status cannot be renamed, so its canonical label is
 * translated by key; a project's custom status renders its stored, user-authored
 * `label` verbatim (user content, not translatable).
 *
 * `wireLabel` is the workflow's own label as the level read carried it. It is
 * the fallback rather than the primary because the catalog is the only localized
 * source — reading the workflow row first would regress every default status to
 * English in `zh`.
 *
 * @param translate the `labels.defaultStatus` translator (`useTranslations`).
 */
export function canvasStatusLabel(
  statusKey: string,
  wireLabel: string | null | undefined,
  translate: (key: string) => string,
): string {
  if (DEFAULT_STATUS_KEYS.has(statusKey)) return translate(statusKey);
  return wireLabel ?? statusKey;
}
