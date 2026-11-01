import type { Metadata } from 'next';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { ChevronLeft, ChevronRight, Layers, Plus } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import { seedRegistryConsoleService } from '@/lib/services/seedRegistryConsoleService';
import { StarterFilters } from './_components/StarterFilters';
import { StarterTable } from './_components/StarterTable';
import {
  STARTER_TARGET_NONE,
  isFilteredStarterView,
  readStarterListView,
  starterListHref,
  toStarterConsoleFilter,
  type StarterListView,
  type StarterSearchParams,
} from './_components/starterListQuery';

/**
 * The console's STARTERS page — design `starter-library` §2 (MOTIR-705), card
 * MOTIR-712, story MOTIR-704.
 *
 * Every entry of the seed registry, newest first, 25 to a page, narrowed by role,
 * status and hosting target — all in the URL, so a reload and a shared link
 * agree. Operator and superadmin only (R97): for support the rail row is absent
 * and this page's gate answers the app's 404, as Fleet settings and Audit log do.
 * The read itself is audited (`seed_registry.library_read`).
 */

export const metadata: Metadata = { title: 'Starters' };

/** Never cached — a starter retired a minute ago must read as retired on the next load. */
export const dynamic = 'force-dynamic';

export default async function AdminStartersPage({
  searchParams,
}: {
  searchParams: Promise<StarterSearchParams>;
}) {
  const principal = await requirePlatformStaffPage('operator');
  const t = await getTranslations('platformAdmin.starters');
  const ts = await getTranslations('repositorySet.seed');
  const view = readStarterListView(await searchParams);
  const library = await seedRegistryConsoleService.listLibrary(
    principal,
    toStarterConsoleFilter(view),
    view.page,
  );
  const filtered = isFilteredStarterView(view);

  let body: React.ReactNode;
  if (library.rows.length > 0) {
    body = <StarterTable rows={library.rows} promoted={view.promoted} />;
  } else {
    // The specific sentence needs both a role and a real target; any other
    // empty filter reads the generic one (design §2.5).
    const specific =
      view.status === 'active' &&
      view.role !== undefined &&
      view.target !== undefined &&
      view.target !== STARTER_TARGET_NONE;
    body = (
      <EmptyState
        data-testid="starters-empty"
        icon={<Layers />}
        title={t('empty.title')}
        description={
          specific
            ? t('empty.bodyRoleTarget', {
                role: view.role ?? '',
                target:
                  view.target && view.target !== STARTER_TARGET_NONE
                    ? ts(`target.${view.target}`)
                    : '',
              })
            : t('empty.body')
        }
        action={
          filtered ? (
            <Link
              href={starterListHref({})}
              className={buttonVariants({ variant: 'secondary', size: 'sm' })}
            >
              {t('empty.clear')}
            </Link>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="mx-auto flex max-w-[80rem] flex-col gap-4 px-6 py-6">
      <p className="font-sans text-xs uppercase tracking-wide text-(--el-text-secondary)">
        {t('breadcrumb')}
      </p>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex max-w-prose flex-col gap-2">
          <h1 className="font-serif text-2xl text-(--el-text)">{t('title')}</h1>
          <p className="font-sans text-sm text-(--el-text-secondary)">{t('subtitle')}</p>
        </div>
        <Link
          href="/admin/starters/promote"
          data-testid="starters-promote"
          className={buttonVariants({ variant: 'primary' })}
        >
          <Plus aria-hidden="true" className="size-4" />
          {t('promote')}
        </Link>
      </div>

      <Card
        data-testid="starters-card"
        header={
          <div className="flex min-w-0 items-start gap-3">
            <span
              aria-hidden
              className="flex h-(--height-control-32) w-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-lavender) text-(--el-text-strong)"
            >
              <Layers className="h-4 w-4" />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <h2 className="font-sans text-sm font-semibold text-(--el-text)">
                {t('card.title')}
              </h2>
              <p
                data-testid="starters-count"
                className="font-sans text-xs text-(--el-text-secondary)"
              >
                {t('card.count', { count: library.total })}
              </p>
            </div>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <StarterFilters view={view} />
          {body}
          {library.total > library.pageSize ? (
            <Pager
              view={view}
              page={library.page}
              pageSize={library.pageSize}
              total={library.total}
              shown={library.rows.length}
            />
          ) : null}
        </div>
      </Card>
    </div>
  );
}

/** Design §2.5: "Showing {from}–{to} of {total}", previous and next, disabled at the ends. */
function Pager({
  view,
  page,
  pageSize,
  total,
  shown,
}: {
  view: StarterListView;
  page: number;
  pageSize: number;
  total: number;
  shown: number;
}) {
  const t = useTranslations('platformAdmin.starters.pager');
  const from = (page - 1) * pageSize + 1;
  const to = from + shown - 1;
  const { promoted: _promoted, ...rest } = view;
  const button = (target: number, label: string, icon: React.ReactNode, enabled: boolean) =>
    enabled ? (
      <Link
        href={starterListHref({ ...rest, page: target })}
        aria-label={label}
        className={buttonVariants({ variant: 'secondary', size: 'sm' })}
      >
        {icon}
      </Link>
    ) : (
      <Button variant="secondary" size="sm" disabled aria-label={label}>
        {icon}
      </Button>
    );
  return (
    <nav
      aria-label={t('label')}
      data-testid="starters-pager"
      className="flex flex-wrap items-center justify-between gap-2 border-t border-(--el-border-soft) pt-3 font-sans text-xs text-(--el-text-secondary)"
    >
      <span>{t('showing', { from, to, total })}</span>
      <div className="flex items-center gap-2">
        {button(page - 1, t('previous'), <ChevronLeft aria-hidden className="size-4" />, page > 1)}
        {button(page + 1, t('next'), <ChevronRight aria-hidden className="size-4" />, to < total)}
      </div>
    </nav>
  );
}
