import { BookOpen, Bug, CircleCheck, CircleDot, EyeOff } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';

/**
 * The ATTRIBUTION and TRIAGE chips — design MOTIR-10362 § Elements. The hue sits
 * in the tint with `--el-text-strong` ink (finding #35); a value the design never
 * drew (a newer motir-ai's) is the neutral chip carrying the raw label.
 */

const ATTRIBUTION_TINT: Record<string, string> = {
  code: 'bg-(--el-tint-peach) text-(--el-text-strong) border-transparent',
  corpus: 'bg-(--el-tint-lavender) text-(--el-text-strong) border-transparent',
  model: 'bg-(--el-tint-sky) text-(--el-text-strong) border-transparent',
  unattributed: 'bg-(--el-surface) text-(--el-text-strong) border-transparent',
};

export function AttributionChip({ value, label }: { value: string; label: string }) {
  const tint = ATTRIBUTION_TINT[value];
  return tint ? <Pill className={tint}>{label}</Pill> : <Pill tone="neutral">{label}</Pill>;
}

export function TriageChip({ status, label }: { status: string; label: string }) {
  const glyph = 'h-3 w-3';
  switch (status) {
    case 'new':
      return <Pill tone="awaiting">{label}</Pill>;
    case 'promoted_to_lesson':
      return (
        <Pill severity="success">
          <BookOpen aria-hidden className={glyph} />
          {label}
        </Pill>
      );
    case 'filed_as_bug':
      return (
        <Pill severity="danger">
          <Bug aria-hidden className={glyph} />
          {label}
        </Pill>
      );
    case 'dismissed':
      return (
        <Pill tone="archived">
          <EyeOff aria-hidden className={glyph} />
          {label}
        </Pill>
      );
    default:
      return <Pill tone="neutral">{label}</Pill>;
  }
}

/** The outcome as the all-findings table draws it: Fixed success, Reported neutral, Fix failed danger. */
export function OutcomeChip({ outcome, label }: { outcome: string; label: string }) {
  if (outcome === 'fixed') return <Pill severity="success">{label}</Pill>;
  if (outcome === 'fix_failed') return <Pill severity="danger">{label}</Pill>;
  return <Pill tone="neutral">{label}</Pill>;
}

/**
 * The record's VERDICT chip — design MOTIR-11470 § Elements: two values, each a
 * word, a glyph and a tint (Open peach, Attributed mint) with `--el-text-strong`
 * ink, so neither reads by colour alone. A value the design never drew is the
 * neutral chip carrying the raw label.
 */
export function VerdictChip({ state, label }: { state: string; label: string }) {
  const glyph = 'h-3 w-3';
  if (state === 'open') {
    return (
      <Pill className="border-transparent bg-(--el-tint-peach) text-(--el-text-strong)">
        <CircleDot aria-hidden className={glyph} />
        {label}
      </Pill>
    );
  }
  if (state === 'attributed') {
    return (
      <Pill className="border-transparent bg-(--el-tint-mint) text-(--el-text-strong)">
        <CircleCheck aria-hidden className={glyph} />
        {label}
      </Pill>
    );
  }
  return <Pill tone="neutral">{label}</Pill>;
}
