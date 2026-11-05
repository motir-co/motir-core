import { getTranslations } from 'next-intl/server';
import { Inbox } from 'lucide-react';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { withRequestLabel } from '@/lib/monitoring/requestLabel';
import type { HomeActorContext } from '@/lib/services/homeService';
import { EmptyState } from '@/components/ui/EmptyState';
import { ApprovalsList } from './ApprovalsList';

// The Approvals TAB's content (Story MOTIR-4879 · Subtask MOTIR-4794), built to
// `design/workbench/approvals-row.mock.html`.
//
// ⚠️ IT DOES ITS OWN READ, AND THAT IS WHAT PUTS A BOUNDARY AROUND IT. The four
// work tabs are read in the page's own `Promise.all`, so nothing can suspend
// around them; this one awaits HERE, which is what lets the page mount a
// `<Suspense>` between its GATE and this content — window 2 of
// `design/shell/design-notes.md`'s navigation-pending grammar, *"an in-page
// `<Suspense>` placed AFTER the page's gate"*.
//
// ⚠️ AND A `loading.tsx` IS THE WRONG INSTRUMENT HERE, not merely a different
// one. That grammar's whole constraint is that a route boundary can flush the
// response head before the page's gate has run, fixing the status at 200 — which
// is why this repo has no `loading.tsx` anywhere and
// `tests/navigation/loading-boundary-guard.test.ts` keeps it that way. The
// boundary belongs INSIDE the page, below the reads that decide who may see it.
//
// ⚠️ THIS READ IS THE FIRST PAINT ONLY (Story MOTIR-8539 · MOTIR-8581). After it,
// the list's rows come from the Workbench's one window read — the same response
// that sets the strip's counts — so nothing here is re-run to update them.
//
// ⚠️ SCOPED TO THIS TAB. The other four tabs keep the page's existing shape
// untouched — this card's boundary is the Approvals tab, and making all five
// suspend would be a page-shell change it is scoped away from.

/** The empty state — drawn by `design/workbench/`, not by this card. */
async function NothingWaiting() {
  const t = await getTranslations('workbench');
  return (
    <EmptyState
      icon={<Inbox className="h-12 w-12" aria-hidden />}
      title={t('empty.approvals.title')}
      description={t('empty.approvals.body')}
    />
  );
}

export async function ApprovalsTab({ ctx }: { ctx: HomeActorContext }) {
  const t = await getTranslations('workbench');
  // THE WHOLE SET, no page (MOTIR-5998) — bounded by the service's ceiling.
  // Labelled here, not by the page: this renders inside a `<Suspense>` after the
  // page function has returned, outside its label (MOTIR-8553).
  const queue = await withRequestLabel({ route: 'workbench' }, () =>
    approvalGatesService.listAwaitingMe(ctx),
  );

  // ⚠️ THE LIST IS MOUNTED EVEN WHEN IT IS EMPTY, and the empty state is handed
  // to it (Story MOTIR-5238 · MOTIR-5245). Returning `<NothingWaiting />`
  // INSTEAD of the list meant the component that knows what arrived did not
  // exist until the first row had already arrived — so the arrival a reader is
  // most certainly watching was the one that could never carry `New`. The empty
  // state is still server-rendered, still this file's, and still exactly what a
  // tab with nothing in it shows; only the branch moved.
  return (
    <ApprovalsList
      rows={queue.items}
      reviewsToRun={queue.reviewsToRun ?? []}
      label={t('tabs.toApprove')}
      ceiling={queue.truncated ? { shown: queue.items.length, total: queue.total } : null}
      empty={<NothingWaiting />}
    />
  );
}
