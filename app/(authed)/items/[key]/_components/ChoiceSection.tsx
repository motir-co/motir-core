'use client';

import { useTranslations } from 'next-intl';
import { Pill } from '@/components/ui/Pill';
import { GateCallToActionBand } from '@/components/approvals/GateCallToActionBand';
import {
  ChoiceDefectBody,
  ChoiceGateFrame,
  ChoicePortBody,
} from '@/components/approvals/ChoiceGate';
import type { ApprovalGateDTO, ChoiceBodyDTO } from '@/lib/dto/approvalGate';
import type { WorkItemRefMap } from '@/lib/dto/workItems';

// THE ITEM PAGE'S **CHOICE** SECTION (Story MOTIR-4914 · Subtask MOTIR-5896; design
// `approval-control--choice.mock.html` Panels 3, 5 and 6a). It sits in the late stack
// where a design result would, and — per MOTIR-5215 — the page keeps the RECORD and
// none of the verbs: a decision is made in ONE place, the approval overlay, which the
// band's *Review & choose* opens.
//
// Four shapes, by what the reads say:
//   · the body is DEFECTIVE — no gate was raised, so no frame: the reason, then the
//     options as far as they parse (Panel 3);
//   · a gate AWAITS a reader who may decide — the options read-only, then the ONE
//     door (Panel 6a);
//   · a gate is decided, withdrawn, or awaits someone else — the shared frame, flush,
//     without verbs: its record, or who it waits on;
//   · no gate yet (the choice is blocked, or already done) — the options, read-only.

/* v8 ignore next 3 -- UNREACHABLE: the section renders the frame with `canDecide={false}`,
   so it draws no verbs and nothing can call this. The page keeps the record and none of
   the verbs (MOTIR-5215); a decision is made in the overlay. */
async function decideNothing(): Promise<null> {
  return null;
}

export function ChoiceSection({
  body,
  workItemRefs,
  gate,
  canDecide,
  routedToLabel,
  routedToViewer,
  itemIdentifier,
  canReplan = false,
}: {
  body: ChoiceBodyDTO;
  /** The body's work-item links, resolved by the page's late read (MOTIR-10023). */
  workItemRefs: WorkItemRefMap;
  gate: ApprovalGateDTO | null;
  canDecide: boolean;
  routedToLabel: string | null;
  routedToViewer: boolean;
  itemIdentifier: string;
  /** May this reader open the planner on the card — `WorkItemPlanEntrance`'s condition
   *  (MOTIR-6211). The decided refusal's record carries Re-plan with AI when true;
   *  omitted, it carries none. */
  canReplan?: boolean;
}) {
  const t = useTranslations('approvalGate.choice');

  const decided =
    gate !== null && (gate.state === 'approved' || gate.state === 'changes_requested');

  if (!body.ok && !decided) {
    return (
      <div className="flex flex-col gap-3">
        <div>
          <Pill severity="warning">{t('defect.title')}</Pill>
        </div>
        <ChoiceDefectBody defects={body.defects} draft={body.draft} workItemRefs={workItemRefs} />
      </div>
    );
  }

  // A DECIDED gate's record outlives a body that stopped parsing — the record is read
  // from `chosenOption`, never from the body — so the options shown are the draft.
  const view = body.ok ? body.port : body.draft;

  if (gate === null) {
    return (
      <ChoicePortBody
        body={view}
        workItemRefs={workItemRefs}
        mode="read"
        groupName={`choice-${itemIdentifier}`}
      />
    );
  }

  if (gate.state === 'awaiting' && canDecide) {
    return (
      <div className="flex flex-col gap-3">
        <ChoicePortBody
          body={view}
          workItemRefs={workItemRefs}
          mode="read"
          groupName={`choice-${itemIdentifier}`}
        />
        <GateCallToActionBand
          kind="decision_choice"
          subjectLabel={t('meta', { count: view.options.length })}
          askedAt={gate.createdAt}
          itemIdentifier={itemIdentifier}
          routedElsewhereName={routedToViewer ? null : routedToLabel}
          body={t('cta.body')}
          buttonLabel={t('cta.button')}
        />
      </div>
    );
  }

  return (
    <ChoiceGateFrame
      // FLUSH IN THE SECTION: the section card is the container and its title the label.
      layout="section"
      gate={gate}
      port={view}
      workItemRefs={workItemRefs}
      // Nothing is pressed on the page: a decided or withdrawn gate is pressable by
      // nobody, and a reader who may not decide sees who it waits on (state B).
      canDecide={false}
      routedToLabel={routedToLabel}
      identifier={itemIdentifier}
      onDecide={decideNothing}
      replan={{ canReplan }}
    />
  );
}
