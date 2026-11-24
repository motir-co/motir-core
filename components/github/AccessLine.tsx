import Link from 'next/link';
import type { ReactNode } from 'react';
import { Lock, Mail } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReaderAccessVariant } from './readerAccessLine';

// THE ACCESS LINE on a pull request's row (Story MOTIR-4881 · MOTIR-12116; design
// `design/github/design-notes.md` § 35.3–35.6, `github--pr-row-reader-access.mock.html`).
//
// The row's text column's FOURTH child, directly under the preview line, and built in its
// shape: a 12px glyph, then ONE text span that wraps like a sentence, with at most one
// inline link. It is NOT a pill — the pill group's second slot is the conflict → review
// chip → CI arbitration, which this never touches. It speaks to the reader only.

/** Where access to a Motir-created repository is given. The page opens on the reader's
 *  active project and reads no query (`getActiveProject`), so none is added. */
export const CODE_ACCESS_HREF = '/settings/project/code-access';

const LINK =
  'rounded-(--radius-control) text-(--el-link) underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';

export function AccessLine({
  variant,
  invitationUrl,
}: {
  variant: ReaderAccessVariant;
  /** The stored invitation on GitHub — read for the `invited` variant only. */
  invitationUrl: string | null;
}) {
  const t = useTranslations('github.development.access');
  const Glyph = variant === 'invited' || variant === 'invitedNoLink' ? Mail : Lock;
  const codeAccessLink = (chunks: ReactNode) => (
    <Link href={CODE_ACCESS_HREF} className={LINK}>
      {chunks}
    </Link>
  );
  const tone = (chunks: ReactNode) => <span className="text-(--el-text-secondary)">{chunks}</span>;

  let sentence: ReactNode;
  switch (variant) {
    case 'invited':
      sentence = t.rich('invited', {
        link: (chunks) => (
          <a
            href={invitationUrl ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            className={LINK}
          >
            {chunks}
          </a>
        ),
      });
      break;
    case 'invitedNoLink':
    case 'notInvited':
      sentence = t.rich(variant, { link: codeAccessLink });
      break;
    case 'roleCannotEdit':
      sentence = t('roleCannotEdit');
      break;
    case 'noGithubPreview':
    case 'noGithubNoPreview':
      sentence = t.rich(variant, { tone });
      break;
  }

  return (
    <div
      className="mt-0.5 flex min-w-0 items-start gap-1.5 font-sans text-xs"
      data-testid="pr-row-access"
      data-access-variant={variant}
    >
      <Glyph className="mt-[3px] h-3 w-3 shrink-0 text-(--el-icon-muted)" aria-hidden />
      <span className="min-w-0 text-(--el-text-identifier)">{sentence}</span>
    </div>
  );
}
