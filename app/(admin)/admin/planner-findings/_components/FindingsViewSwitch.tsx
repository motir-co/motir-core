'use client';

import { useRef, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { FINDING_FILTER_KEYS } from './filterKeys';

/**
 * The VIEW SWITCH — design MOTIR-10362 § Elements: the Segmented anatomy as a
 * labelled radio group of links. Grouped is the default (no `view` in the URL);
 * All findings is `?view=all`. A switch keeps every filter and starts the cursor
 * walk over. One tab stop; the arrow keys move the choice.
 */

const BASE = '/admin/planner-findings';
const VIEWS = ['grouped', 'all'] as const;
type View = (typeof VIEWS)[number];

export function findingsViewHref(view: View, params: URLSearchParams): string {
  const url = new URLSearchParams();
  for (const key of FINDING_FILTER_KEYS) {
    const value = params.get(key);
    if (value) url.set(key, value);
  }
  if (view === 'all') url.set('view', 'all');
  const qs = url.toString();
  return qs ? `${BASE}?${qs}` : BASE;
}

export function FindingsViewSwitch() {
  const t = useTranslations('platformAdmin.plannerFindings');
  const params = useSearchParams();
  const router = useRouter();
  const refs = useRef<Record<View, HTMLAnchorElement | null>>({ grouped: null, all: null });
  const active: View = params.get('view') === 'all' ? 'all' : 'grouped';

  function onKeyDown(event: KeyboardEvent<HTMLAnchorElement>) {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = VIEWS[(VIEWS.indexOf(active) + step + VIEWS.length) % VIEWS.length]!;
    refs.current[next]?.focus();
    router.push(findingsViewHref(next, params));
  }

  return (
    <div
      role="radiogroup"
      aria-label={t('view.label')}
      aria-describedby="planner-findings-view-hint"
      data-testid="planner-findings-view-switch"
      className="inline-flex items-center gap-0.5 rounded-(--radius-btn) border border-(--el-border) bg-(--el-tabnav-track) p-0.5"
    >
      <span id="planner-findings-view-hint" className="sr-only">
        {t('a11y.viewGroup')}
      </span>
      {VIEWS.map((view) => {
        const checked = view === active;
        return (
          <Link
            key={view}
            ref={(el) => {
              refs.current[view] = el;
            }}
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            href={findingsViewHref(view, params)}
            onKeyDown={onKeyDown}
            className={`inline-flex h-(--height-control) items-center rounded-[calc(var(--radius-btn)-2px)] px-(--spacing-control-x) font-sans text-sm ${
              checked
                ? 'bg-(--el-page-bg) text-(--el-text-strong) shadow-(--shadow-subtle)'
                : 'text-(--el-text-secondary) hover:text-(--el-text)'
            }`}
          >
            {view === 'grouped' ? t('view.grouped') : t('view.all')}
          </Link>
        );
      })}
    </div>
  );
}
