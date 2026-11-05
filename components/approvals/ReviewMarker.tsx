'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, BotOff, SquareTerminal } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import type { ReviewMarkerDTO } from '@/lib/dto/reviewState';

// THE REVIEW MARKERS (Story MOTIR-10327 · MOTIR-10341; `design/github/design-notes.md`
// § 32.1, `design/work-items/decision-waiting--review-path.mock.html` M2–M4, M7, M9) — one
// component, TWO forms, mirroring `DecisionWaitingMarker`, whose slot, size and precedence
// they take.
//
// | marker                        | loud for          | glyph            |
// | Agent reviewing               | nobody — quiet    | `Bot`            |
// | Review could not run          | the routed person | `BotOff`         |
// | Waiting for your review agent | the routed person | `SquareTerminal` |
//
// ⚠️ LOUD AND QUIET DIFFER IN FILL, INK AND WORDS TOGETHER, never in colour alone: the
// routed person's pill is `tone="awaiting"` (the glyph form a yellow disc) and says *your*;
// everyone else's is neutral and names the person. The three glyph SHAPES differ from each
// other and from the decision marker's `Stamp` / `Hourglass`. Glyphs are `aria-hidden`; the
// words, or the glyph form's accessible name, carry the meaning.
//
// ⚠️ IT DRAWS WHAT THE READ MODEL RETURNED (`reviewStateService`) and computes nothing: who
// the marker is loud for is `forViewer`, already decided against the reader.
//
// The copyable command is NOT here: on a board card the whole card is one button, and a
// copy button inside it would nest one control in another. The item header draws it
// beside the marker (`ReviewCommand`).

interface ReviewMarkerProps {
  marker: ReviewMarkerDTO;
  /** The card's key — the waiting marker's sentence names `motir review <KEY>`. */
  identifier: string;
  /** `label` on a board card and the item header; `glyph` in a List / Tree status cell. */
  form?: 'label' | 'glyph';
  /** For the board card's `aria-describedby`, which the card's own label would hide. */
  id?: string;
  /** Label form only: a trailing glyph after the words (the header pointer's arrow). */
  trailing?: ReactNode;
  /** Label form only: extra classes on the pill (the header button's hover border). */
  className?: string;
}

/** The marker's words and its full sentence, from the read model's answer. */
export function useReviewMarkerCopy(marker: ReviewMarkerDTO, identifier: string) {
  const t = useTranslations('approvalGate');
  const name = ('routedTo' in marker ? marker.routedTo?.name : null) ?? t('theAssignee');
  switch (marker.kind) {
    case 'agent_reviewing':
      return {
        loud: false,
        words: t('reviewPath.marker.reviewing'),
        sentence: t('reviewPath.marker.reviewingName'),
      };
    case 'could_not_run':
      return marker.forViewer
        ? {
            loud: true,
            words: t('reviewPath.marker.couldNotRun'),
            sentence: t('reviewPath.marker.couldNotRunName'),
          }
        : {
            loud: false,
            words: t('reviewPath.marker.couldNotRunOn', { name }),
            sentence: t('reviewPath.marker.couldNotRunOnName', { name }),
          };
    case 'waiting_for_own_agent':
      return marker.forViewer
        ? {
            loud: true,
            words: t('reviewPath.marker.waitingYours'),
            sentence: t('reviewPath.marker.waitingYoursName', { key: identifier }),
          }
        : {
            loud: false,
            words: t('reviewPath.marker.waitingOn', { name }),
            sentence: t('reviewPath.marker.waitingOnName', { name }),
          };
  }
}

function MarkerGlyph({ kind, className }: { kind: ReviewMarkerDTO['kind']; className: string }) {
  if (kind === 'could_not_run') return <BotOff className={className} aria-hidden />;
  if (kind === 'waiting_for_own_agent') return <SquareTerminal className={className} aria-hidden />;
  return <Bot className={className} aria-hidden />;
}

export function ReviewMarker({
  marker,
  identifier,
  form = 'label',
  id,
  trailing,
  className,
}: ReviewMarkerProps) {
  const { loud, words, sentence } = useReviewMarkerCopy(marker, identifier);

  if (form === 'glyph') {
    // ⚠️ `shrink-0` is load-bearing, as on the decision glyph: the status cell is a flex
    // row, and a squeezed marker overlaps the status pill instead of the row truncating.
    return (
      <span
        id={id}
        className={`inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center ${
          loud
            ? 'rounded-full bg-(--el-tint-yellow) text-(--el-text-strong)'
            : 'text-(--el-text-secondary)'
        }`}
        role="img"
        aria-label={sentence}
        title={sentence}
        data-review-marker={marker.kind}
        data-review-loud={loud ? '' : undefined}
      >
        <MarkerGlyph
          kind={marker.kind}
          className={loud ? 'h-3 w-3 shrink-0' : 'h-3.5 w-3.5 shrink-0'}
        />
      </span>
    );
  }

  return (
    <Pill
      id={id}
      tone={loud ? 'awaiting' : 'neutral'}
      title={sentence}
      className={
        className ? `min-w-0 max-w-full shrink-0 ${className}` : 'min-w-0 max-w-full shrink-0'
      }
      data-review-marker={marker.kind}
      data-review-loud={loud ? '' : undefined}
    >
      <MarkerGlyph kind={marker.kind} className="h-3 w-3 shrink-0" />
      <span className="truncate">{words}</span>
      {trailing}
    </Pill>
  );
}
