'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { NotebookText } from 'lucide-react';
import { Place } from '@/app/(authed)/items/[key]/_components/PagePlace';
import type { PageSearchHitDto } from '@/lib/dto/pages';
import { emphasise } from './snippetEmphasis';

// ONE HIT ROW (Story MOTIR-9491 · MOTIR-9638) — `pages--tree--search.mock.html`
// panel 4: the page glyph, the Hit title, the Hit place and the Hit snippet, the
// whole row one link to the page. The link is NAMED by the title alone (the
// place and snippet describe it), so a reader and a test find a hit by its title.
// `rank` is never shown. An empty snippet draws no snippet line.

export function PageSearchHitRow({ hit, query }: { hit: PageSearchHitDto; query: string }) {
  const t = useTranslations('pages');
  const titleId = `page-hit-${hit.id}`;
  const descId = `page-hit-${hit.id}-desc`;
  const segments = emphasise(hit.snippet, query);
  return (
    <li className="border-(--el-border-soft) not-first:border-t">
      <Link
        href={`/pages/${hit.id}`}
        data-page-hit=""
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="flex min-h-(--height-control-40) items-start gap-2.5 px-(--spacing-control-x-12) py-(--spacing-control-y-8) text-(--el-text) no-underline hover:bg-(--el-surface) focus-visible:shadow-[inset_0_0_0_2px_var(--focus-ring-color)] focus-visible:outline-none"
      >
        <NotebookText className="mt-0.5 h-4 w-4 shrink-0 text-(--el-icon-muted)" aria-hidden />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span id={titleId} className="truncate text-sm font-medium text-(--el-text)">
            {hit.title || t('untitled')}
          </span>
          <div id={descId} className="flex min-w-0 flex-col gap-0.5">
            <Place place={hit.place} />
            {segments.length > 0 ? (
              <span
                data-testid="page-hit-snippet"
                className="line-clamp-2 text-[13px] leading-normal text-(--el-text-secondary)"
              >
                {segments.map((s, i) =>
                  s.match ? (
                    <mark
                      key={i}
                      className="rounded-(--radius-kbd) bg-(--el-tint-yellow) font-semibold text-(--el-text-strong)"
                    >
                      {s.text}
                    </mark>
                  ) : (
                    <span key={i}>{s.text}</span>
                  ),
                )}
              </span>
            ) : null}
          </div>
        </div>
      </Link>
    </li>
  );
}
