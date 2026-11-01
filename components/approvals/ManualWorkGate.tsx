'use client';

import { useCallback, type MouseEvent } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Hand } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { buttonVariants } from '@/components/ui/Button';
import { BrandMark } from '@/components/brand/BrandMark';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { withPlanningOverlay } from '@/lib/planning/launcher';
import { isPlainPrimaryClick } from '@/lib/hooks/useOpenPlanningWorkspace';
import { withoutApprovalOverlay } from '@/lib/approvals/overlayAddress';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import {
  TodoRowReadOnly,
  type TodoRowContent,
} from '@/app/(authed)/items/[key]/_components/TodoListSection';
import { ContentSectionCard } from '@/app/(authed)/items/[key]/_components/ContentSectionCard';
import { ApprovalGateControl, type GateVerb } from '@/components/approvals/ApprovalGateControl';
import type { GateRefusal } from '@/lib/approvalGates/refusals';
import type { ApprovalGateDTO, GateDecision, ManualWorkPortDTO } from '@/lib/dto/approvalGate';
import type { ReactNode } from 'react';

// THE MANUAL-WORK GATE'S PORT (Story MOTIR-7460 · Subtask MOTIR-7478), built to
// `design/workbench/approval-overlay--manual-work.mock.html` and § 33.3 of
// `design/workbench/design-notes.md`.
//
// A run reached a manual card and handed it to a person (`docs/decisions/manual-work-gate.md`).
// The kind opens in the shipped overlay like every card kind: `ApprovalGateControl`'s
// three bands, and this file supplies only what the kind puts in them —
//   · band 1: the manual type's `hand` glyph, *Manual work*, and the to-do progress;
//   · band 2: one lead sentence and the card's to-do list in its READ FACE
//     (`TodoRowReadOnly`, the box drawn by state). ⚠️ THE BOX IS NOT A CONTROL HERE:
//     ticking is the item page's and the guide's, and a third tick surface inside a
//     decision frame would split the list's writers;
//   · band 3: *Guide me through* — a DOOR, so a link — and *Mark done*, the ONE verb.
//     ⚠️ THERE IS NO REQUEST CHANGES (ADR §4): manual work is done or not done.
//
// State `B` (a reader who may not decide) draws NEITHER control, through the frame's own
// rule: the door rides `verbsLead`, which the frame renders exactly when it renders verbs.

/** The manual type's mark — `workItemTypeMeta`'s own glyph and hue for `type: manual`. */
export function ManualWorkGlyph() {
  return <Hand className="h-4 w-4 shrink-0 text-(--el-type-manual)" aria-hidden />;
}

/**
 * THE GUIDE ME THROUGH DOOR's two halves for one card (design § 33.2 / § 33.3): a REAL
 * `href` — the card's page with the guide open on it, so a modified click opens that in a
 * new tab — and a plain primary click that opens the guide over the page the door sits on
 * (`useOpenGuide`'s address), with `shallowPush`.
 *
 * `leaveApproval` drops the approval overlay's address on the way: the guide is its own
 * full-screen surface, and opening it from inside the approval overlay replaces that
 * overlay rather than stacking a second one over it.
 */
export function useGuideDoor(
  itemKey: string,
  { leaveApproval = false }: { leaveApproval?: boolean } = {},
): { href: string; onClick: (event: MouseEvent<HTMLElement>) => void } {
  const routes = useReaderRoutes();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const href = withPlanningOverlay(routes.item(itemKey), { kind: 'guide', itemKey });
  const onClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (!isPlainPrimaryClick(event)) return;
      event.preventDefault();
      const qs = searchParams.toString();
      const here = `${pathname}${qs ? `?${qs}` : ''}`;
      shallowPush(
        withPlanningOverlay(leaveApproval ? withoutApprovalOverlay(here) : here, {
          kind: 'guide',
          itemKey,
        }),
      );
    },
    [pathname, searchParams, itemKey, leaveApproval],
  );
  return { href, onClick };
}

/** Band 3's *Guide me through* — the shipped secondary button recipe, as a link. */
function GuideDoorButton({ itemKey, pending }: { itemKey: string; pending: boolean }) {
  const t = useTranslations('runs.guide');
  const door = useGuideDoor(itemKey, { leaveApproval: true });
  return (
    <a
      href={door.href}
      data-testid="manual-work-guide-door"
      // Dimmed for the length of the write (Panel 3), so the reader cannot leave for the
      // guide with the decision half-made. A link has no `disabled`, so it says so.
      aria-disabled={pending || undefined}
      tabIndex={pending ? -1 : undefined}
      onClick={(event) => {
        if (pending) {
          event.preventDefault();
          return;
        }
        door.onClick(event);
      }}
      className={cn(
        buttonVariants({ variant: 'secondary', size: 'sm' }),
        pending && 'pointer-events-none opacity-50',
      )}
    >
      <BrandMark variant="mark" size={14} />
      <span>{t('door')}</span>
    </a>
  );
}

/** The port's body: the lead sentence, then the list (or where the steps are instead). */
function ManualWorkPort({ view, done }: { view: ManualWorkPortDTO; done: boolean }) {
  const t = useTranslations('approvalGate.manualWork');
  const tTodos = useTranslations('workItemTodos');
  const hasList = view.progress.total > 0;
  return (
    <div className="flex max-w-[48rem] flex-col gap-4" data-testid="manual-work-port">
      <p className="text-[13.5px] text-(--el-text)">
        {done ? t('leadDone') : hasList ? t('lead') : t('leadNoList')}
      </p>
      {hasList ? (
        <ContentSectionCard
          title={tTodos('sectionTitle')}
          subtitle={tTodos('sectionSubtitle')}
          headerRight={
            <span className="font-mono text-[11px] text-(--el-text-secondary)">
              {tTodos('progress', { done: view.progress.done, total: view.progress.total })}
            </span>
          }
        >
          <ul className="list-none">
            {view.todos.map((todo) => {
              const row: TodoRowContent = todo;
              return (
                <TodoRowReadOnly
                  key={todo.id}
                  row={row}
                  workItemRefs={view.workItemRefs}
                  drawDone
                />
              );
            })}
          </ul>
        </ContentSectionCard>
      ) : (
        <div className="flex flex-col items-center justify-center gap-1 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) px-(--spacing-card-padding-16) py-10 text-center">
          <p className="text-[13px] font-medium text-(--el-text)">{t('noList.title')}</p>
          <p className="text-xs text-(--el-text-secondary)">{t('noList.body')}</p>
        </div>
      )}
    </div>
  );
}

export interface ManualWorkGateFrameProps {
  gate: ApprovalGateDTO;
  view: ManualWorkPortDTO;
  identifier: string;
  canDecide: boolean;
  routedToLabel: string | null;
  alert?: ReactNode;
  onDecide: (decision: GateDecision) => Promise<GateRefusal | null>;
  onShowCurrentVersion?: () => void;
  focusPortOnMount?: boolean;
}

/** The manual-work gate in the approval overlay's frame — `fill`, the overlay's layout. */
export function ManualWorkGateFrame({
  gate,
  view,
  identifier,
  canDecide,
  routedToLabel,
  alert,
  onDecide,
  onShowCurrentVersion,
  focusPortOnMount = false,
}: ManualWorkGateFrameProps) {
  const t = useTranslations('approvalGate.manualWork');
  const tGate = useTranslations('approvalGate');
  const tRow = useTranslations('workbench.approvals');
  const hasList = view.progress.total > 0;

  // ONE VERB, AND IT DOES NOT CONFIRM (§ 33.2: the press is the decision, and the
  // consequence it states is the status move the person asked for).
  const markDone: GateVerb = {
    decision: 'approve',
    label: tRow('markDone'),
    variant: 'primary',
    confirms: false,
    pendingLabel: tRow('marking'),
  };

  return (
    <ApprovalGateControl
      layout="fill"
      gate={gate}
      canDecide={canDecide}
      kindGlyph={<ManualWorkGlyph />}
      kindLabel={tRow('kind.manual_work')}
      subjectMeta={
        hasList
          ? t('meta', { done: view.progress.done, total: view.progress.total })
          : t('metaNoList')
      }
      approvedStateLabel={t('state.markedDone')}
      port={<ManualWorkPort view={view} done={gate.state === 'approved'} />}
      verbs={[markDone]}
      verbsLead={(pending) => <GuideDoorButton itemKey={identifier} pending={pending} />}
      // With an open delivering pull request the press records the decision and the
      // merge writes Done (ADR §4, `merge_writes_done`).
      consequence={
        view.mergeWritesDone
          ? t('consequenceMerges', { key: identifier })
          : t('consequence', { key: identifier })
      }
      confirmConsequences={[]}
      routedToLabel={routedToLabel}
      // ⚠️ THE SHIPPED `pulled_back` LINE IS FALSE FOR THIS KIND (§ 33.3) — *pulled back
      // out of review* — because a manual card never entered review: it was cancelled or
      // archived. Every other cause is the frame's own line.
      withdrawnPort={
        gate.supersededCause === 'pulled_back'
          ? {
              port: tGate('withdrawn.causeByKind.manual_work.pulled_back'),
              cite: tGate('withdrawn.portCite'),
            }
          : undefined
      }
      alert={alert}
      onDecide={(decision) => onDecide(decision)}
      onShowCurrentVersion={onShowCurrentVersion}
      focusPortOnMount={focusPortOnMount}
    />
  );
}
