import type { ComponentType } from 'react';
import { CircleCheck, CircleDashed, CircleEllipsis, CircleMinus, CircleX } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { LinkedPullRequestPreviewDto } from '@/lib/dto/github';
import { knownFailureReason } from '@/lib/preview/failureReason';

// THE PREVIEW LINE on a pull request's row (Story MOTIR-5766 · MOTIR-10099; design
// `design/github/github--pr-row-preview.mock.html`, `design-notes.md` § 31).
//
// The third line of the row's text column, under `owner/name · #n`: a glyph, then
// ONE inline text span holding the word and its tail — the reason when it failed,
// the preview host as a link when it is live. It is NOT a pill: the pill group's
// second slot is already an arbitration (conflict → review chip → CI), and a fourth
// claimant would hide behind the conflict pill on exactly the rows a reviewer most
// needs it on.
//
// A pure render of what the page was given: the rows are server-rendered and refresh
// through the block's one re-read, so there is no loading, error or refreshing state
// here, and no timer, effect or fetch.
//
// Inks are the design's, measured on the row's `--el-surface` fill: the word in
// `--el-text-identifier` (the meta line's own ink), the reason in
// `--el-text-secondary`, the host in `--el-link`. The muted ink fails AA on that fill
// and is used nowhere in the line.

type PreviewWord = 'building' | 'ready' | 'failed' | 'closed' | 'unknown';

/** What a preview state draws. */
export interface PreviewRowState {
  /** The copy key under `github.development.preview`. */
  readonly word: PreviewWord;
  readonly glyph: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  /** Whether the line ends with the host as a live link — `ready` only. */
  readonly link: boolean;
}

/**
 * The drawn state for a record's state — TOTAL over any string, because the value
 * set is a database enum a migration can widen. `starting` draws as `building` (a
 * viewer cannot act differently on the two, and the preview host's page for both is
 * the building page); a value this build does not know draws its own raw word, never
 * a blank and never another state's label.
 */
export function previewRowState(state: string): PreviewRowState {
  switch (state) {
    case 'building':
    case 'starting':
      return { word: 'building', glyph: CircleEllipsis, link: false };
    case 'ready':
      return { word: 'ready', glyph: CircleCheck, link: true };
    case 'failed':
      return { word: 'failed', glyph: CircleX, link: false };
    case 'closed':
      return { word: 'closed', glyph: CircleMinus, link: false };
    default:
      return { word: 'unknown', glyph: CircleDashed, link: false };
  }
}

export function PreviewLine({ preview }: { preview: LinkedPullRequestPreviewDto | null }) {
  const t = useTranslations('github.development.preview');
  const tGate = useTranslations('previewGate');
  // Absence is not a state: no wrapper, no label, no placeholder — the shipped row.
  if (!preview) return null;
  const { word, glyph: Glyph, link } = previewRowState(preview.state);
  // The SAME sentence the preview host's failed page shows (`preview-gate/page.tsx`):
  // a reason the lifecycle wrote from a template reads in the viewer's language, any
  // other stored text verbatim — one sentence, one translation.
  const known = preview.failureReason ? knownFailureReason(preview.failureReason) : null;
  const reason = known ? tGate(`failed.reason.${known.key}`, known.values) : preview.failureReason;
  return (
    <div
      className="mt-0.5 flex min-w-0 items-start gap-1.5 font-sans text-xs"
      data-testid="pr-row-preview"
      data-preview-state={preview.state}
    >
      <Glyph className="mt-[3px] h-3 w-3 shrink-0 text-(--el-icon-muted)" aria-hidden />
      <span className="min-w-0 text-(--el-text-identifier)">
        {word === 'failed' && reason
          ? // The reason is a TAG around its argument so a language places it where
            // its grammar wants it, and the reason alone takes the secondary ink.
            t.rich('failedReason', {
              reason,
              tone: (chunks) => <span className="text-(--el-text-secondary)">{chunks}</span>,
            })
          : word === 'unknown'
            ? t('unknown', { state: preview.state })
            : t(word)}
        {link ? (
          <>
            {' '}
            <a
              href={preview.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-(--radius-control) font-mono text-[12.5px] text-(--el-link) underline [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              {preview.host}
            </a>
          </>
        ) : null}
      </span>
    </div>
  );
}
