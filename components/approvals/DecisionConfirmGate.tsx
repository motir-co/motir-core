'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { ArrowUpRight, CircleAlert, FileText, Notebook } from 'lucide-react';
import { FrozenPill } from '@/components/pages/FrozenPill';
import {
  DecisionRecordPagePicker,
  type DecisionRecordPagePickerProps,
} from './DecisionRecordPagePicker';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { useRefusalReplanSlots, type RefusalReplanProps } from './RefusalReplan';
import type { DecisionChange, DecisionDraft } from '@/lib/approvalGates/decisionRecord';
import type { GateRefusal } from '@/lib/approvalGates/refusals';
import { attachmentContentPath } from '@/lib/blob/referencedUrls';
import type {
  ApprovalGateDTO,
  ConfirmedRecordDTO,
  DecisionDefectDTO,
  GateDecision,
  SupersededItemDTO,
} from '@/lib/dto/approvalGate';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import { formatBytes } from '@/lib/utils/bytes';
import {
  ApprovalGateControl,
  type ApprovalGateControlProps,
  type GateVerb,
} from '@/components/approvals/ApprovalGateControl';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';

// THE CONFIRM PORT (Story MOTIR-5871 · Subtask MOTIR-5960; design
// `design/work-items/approval-control--decision-confirm.mock.html` + `design-notes.md`
// § THE CONFIRM PORT). A person CONFIRMS a decision the planner settled WITH them —
// or OVERTURNS it: "that's not what we discussed".
//
// ⚠️ THE FRAME IS THE SHARED ONE. `DecisionConfirmGateFrame` renders
// `ApprovalGateControl` and supplies only what a kind supplies: the PORT (the four
// sections), the VERB SET (Overturn · Confirm) and the words. Overturn's REQUIRED note
// is the frame's own `note` verb (MOTIR-5960), never a second confirm step.
//
// ⚠️ THE DECIDED BANDS READ THE STAMP, NEVER THE BODY (design Panels 3–4): the record's
// name and size come from `confirmedRecord`, and the owed re-plan from `replanOwed` —
// so they survive any later edit of the body.

/** The view the port draws — the parsed port, or a defective body's draft. */
export interface DecisionPortView extends Omit<DecisionDraft, 'supersedes'> {
  supersedesItems: SupersededItemDTO[];
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase">
      {children}
    </p>
  );
}

/** A change value — ONE tint for the closed set, so it never reads as a severity. */
function ChangeChip({ change }: { change: DecisionChange }) {
  const t = useTranslations('approvalGate.decisionConfirm.change');
  return (
    <span className="inline-flex items-center rounded-(--radius-badge) border border-transparent bg-(--el-tint-lavender) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs font-medium text-(--el-text-strong)">
      {t(change)}
    </span>
  );
}

/** A work-item chip: the key in mono and its title, linked — or plain mono text for a
 *  key that names nothing (a removed item is what a less-requirement decision drops). */
export function SupersededChip({ item }: { item: SupersededItemDTO }) {
  const routes = useReaderRoutes();
  const key = <span className="font-mono text-xs text-(--el-text-identifier)">{item.key}</span>;
  if (item.title === null) {
    return (
      <span className="inline-flex items-center rounded-(--radius-badge) border border-(--el-border) px-(--spacing-chip-x) py-(--spacing-chip-y)">
        {key}
      </span>
    );
  }
  return (
    <Link
      href={routes.item(item.key)}
      className="inline-flex max-w-full items-center gap-1.5 rounded-(--radius-badge) border border-(--el-border) px-(--spacing-chip-x) py-(--spacing-chip-y) hover:bg-(--el-surface)"
    >
      {key}
      <span className="truncate text-xs text-(--el-text)">{item.title}</span>
    </Link>
  );
}

const bold = (chunks: ReactNode) => <b>{chunks}</b>;

/** What a person who can edit the card needs to point at a page as the record. */
export type DecisionRecordPicker = Omit<DecisionRecordPagePickerProps, 'chosen'>;

/** The record LINK (or its absence) the port shows while the question is open. */
function RecordLine({
  record,
  count,
  picker,
}: {
  record: ConfirmedRecordDTO;
  count: number;
  picker?: DecisionRecordPicker;
}) {
  const t = useTranslations('approvalGate.decisionConfirm.record');
  // A person who can edit the card may CHOOSE a page as the record (MOTIR-7444): with no
  // record yet, or to change a page already chosen. An attachment record renders as before.
  if (picker && (record.kind === 'none' || record.kind === 'page')) {
    return (
      <DecisionRecordPagePicker
        {...picker}
        chosen={
          record.kind === 'page'
            ? { pageId: record.pageId, title: record.title, versionNumber: record.versionNumber }
            : null
        }
      />
    );
  }
  if (record.kind === 'none') {
    return <p className="text-[13px] text-(--el-text-secondary)">{t('none')}</p>;
  }
  if (record.kind === 'page') {
    // A published page version (MOTIR-7444, delta 4 Panel 2a) — read-only here; the
    // editable row with *Change* is the picker's.
    return (
      <p
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]"
        data-testid="decision-record-page"
      >
        <span className="text-(--el-text-secondary)">{t('link')}</span>
        <Notebook className="h-3.5 w-3.5 flex-none text-(--el-text-secondary)" aria-hidden />
        <span className="text-(--el-text)">
          {t.rich('page', { title: record.title, number: record.versionNumber, b: bold })}
        </span>
        <Link
          href={`/pages/${encodeURIComponent(record.pageId)}?version=${record.versionNumber}`}
          className="inline-flex items-center gap-1 font-semibold text-(--el-link) hover:text-(--el-link-pressed)"
        >
          {t('open')}
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </p>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
      <span className="text-(--el-text-secondary)">{t('link')}</span>
      <a
        href={attachmentContentPath(record.attachmentId)}
        className="inline-flex items-center gap-1 text-(--el-link) hover:underline"
      >
        <FileText className="h-3.5 w-3.5 flex-none" aria-hidden />
        {record.originalFilename}
      </a>
      <span className="text-(--el-text-secondary)">
        {t('detail', { size: formatBytes(record.sizeBytes), count })}
      </span>
    </p>
  );
}

/** THE PORT (design Panel 1) — the four sections, in the body's order. */
export function DecisionPortBody({
  view,
  record,
  recordCount,
  recordPicker,
  workItemRefs,
}: {
  view: DecisionPortView;
  /** The chips of every `[KEY](motir:<id>)` in the sections (MOTIR-10023). */
  workItemRefs: WorkItemRefMap;
  /** The record the port links — omitted on a decided gate, whose band reads the stamp. */
  record?: ConfirmedRecordDTO;
  recordCount?: number;
  /** *Choose page*, for a person who can edit the card while the question is open. */
  recordPicker?: DecisionRecordPicker;
}) {
  const t = useTranslations('approvalGate.decisionConfirm.eyebrow');
  return (
    <div className="flex flex-col gap-3" data-testid="decision-confirm-port">
      {view.decisionMd ? (
        <div>
          <Eyebrow>{t('decision')}</Eyebrow>
          <MarkdownView
            value={view.decisionMd}
            workItemRefs={workItemRefs}
            className="mt-1 text-sm font-medium text-(--el-text)"
          />
        </div>
      ) : null}
      {view.changes.length > 0 || view.whatChangedMd ? (
        <div className="rounded-(--radius-card) border border-(--el-border-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8)">
          <div className="flex flex-wrap items-center gap-2">
            <Eyebrow>{t('whatChanged')}</Eyebrow>
            {view.changes.map((change) => (
              <ChangeChip key={change} change={change} />
            ))}
          </div>
          {view.whatChangedMd ? (
            <MarkdownView
              value={view.whatChangedMd}
              workItemRefs={workItemRefs}
              className="mt-2 text-[13px] leading-snug text-(--el-text-secondary)"
            />
          ) : null}
        </div>
      ) : null}
      {view.supersedesItems.length > 0 ? (
        <div>
          <Eyebrow>{t('supersedes', { count: view.supersedesItems.length })}</Eyebrow>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {view.supersedesItems.map((item) => (
              <SupersededChip key={item.key} item={item} />
            ))}
          </div>
        </div>
      ) : null}
      {view.resultingDirectionMd ? (
        <div className="rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8)">
          <Eyebrow>{t('resultingDirection')}</Eyebrow>
          <MarkdownView
            value={view.resultingDirectionMd}
            workItemRefs={workItemRefs}
            className="mt-1 text-[13px] leading-snug text-(--el-text)"
          />
        </div>
      ) : null}
      {record ? (
        <RecordLine record={record} count={recordCount ?? 0} picker={recordPicker} />
      ) : null}
    </div>
  );
}

export interface DecisionConfirmGateFrameProps {
  gate: ApprovalGateDTO;
  view: DecisionPortView;
  /** The chips of every `[KEY](motir:<id>)` in the sections (MOTIR-10023). */
  workItemRefs: WorkItemRefMap;
  /** The record the port would stamp now, and how many there are. */
  record: ConfirmedRecordDTO;
  recordCount: number;
  /** The ids of the records present now — a stamped one missing from them was deleted. */
  presentRecordIds: string[];
  /**
   * THE RE-PLAN WITH AI DOOR, and the ask right after an Overturn (Story MOTIR-6068 ·
   * MOTIR-6211). The overturned record offers the SEEDED planner on this decision, in
   * place of the plain epic entrance it used to carry. Omitted: no door.
   */
  replan?: RefusalReplanProps;
  canDecide: boolean;
  /** *Choose page* in the open port (MOTIR-7444); omitted for a reader who cannot edit. */
  recordPicker?: DecisionRecordPicker;
  routedToLabel: string | null;
  /** The card's `KEY-<n>`, named in the consequence and confirm lines. */
  identifier: string;
  layout?: ApprovalGateControlProps['layout'];
  onDecide: (
    decision: GateDecision,
    optionId?: string,
    noteMd?: string,
  ) => Promise<GateRefusal | null>;
  alert?: ReactNode;
  onShowCurrentVersion?: () => void;
  focusPortOnMount?: boolean;
}

/** The confirm gate in the shared frame (design Panels 1–4, 6). */
export function DecisionConfirmGateFrame({
  gate,
  view,
  workItemRefs,
  record,
  recordCount,
  presentRecordIds,
  replan,
  canDecide,
  recordPicker,
  routedToLabel,
  identifier,
  layout,
  onDecide,
  alert,
  onShowCurrentVersion,
  focusPortOnMount,
}: DecisionConfirmGateFrameProps) {
  const t = useTranslations('approvalGate.decisionConfirm');
  const tRow = useTranslations('approvalGate.decisionConfirm.change');
  const format = useFormatter();
  const live = canDecide && gate.state === 'awaiting';
  const keys = view.supersedesItems.map((item) => item.key);

  const verbs: GateVerb[] = [
    {
      decision: 'overturn',
      label: t('verb.overturn'),
      // SECONDARY, never a danger button (design): it refuses a direction and deletes
      // nothing — the required note and the confirm list carry its weight.
      variant: 'secondary',
      confirms: true,
      note: { label: t('note.label'), helper: t('note.helper'), required: t('note.required') },
      confirm: {
        title: t('overturnStep.title'),
        consequences: [
          t('overturnStep.record'),
          t('overturnStep.cancelled', { key: identifier }),
          t('overturnStep.owed', { keys: keys.join(', ') }),
        ],
        proceedLabel: t('overturnStep.proceed'),
      },
    },
    {
      decision: 'approve',
      label: t('verb.confirm'),
      variant: 'primary',
      confirms: true,
      confirm: {
        title: t('confirmStep.title'),
        consequences: [
          record.kind === 'attachment'
            ? t('confirmStep.recordWith', { file: record.originalFilename })
            : record.kind === 'page'
              ? t.rich('confirmStep.recordWithPage', {
                  title: record.title,
                  number: record.versionNumber,
                  b: bold,
                })
              : t('confirmStep.recordWithout'),
          // Delta 4 Panel 3: a page record is FROZEN by the Confirm — said before it happens.
          ...(record.kind === 'page'
            ? [
                t.rich('confirmStep.freeze', {
                  title: record.title,
                  number: record.versionNumber,
                  b: bold,
                }),
              ]
            : []),
          t('confirmStep.done', { key: identifier }),
          t('confirmStep.nothingElse'),
        ],
        proceedLabel: t('confirmStep.proceed'),
      },
    },
  ];

  const when = gate.decidedAt
    ? format.dateTime(new Date(gate.decidedAt), { dateStyle: 'medium', timeStyle: 'short' })
    : '';
  const name = gate.decidedByLabel ?? '';
  const { door, ask } = useRefusalReplanSlots({
    gate,
    itemKey: identifier,
    replan,
    sectioned: layout === 'section',
  });

  return (
    <ApprovalGateControl
      gate={gate}
      layout={layout}
      canDecide={live}
      kindLabel={t('kindLabel')}
      subjectMeta={t('meta', {
        changes: view.changes.map((change) => tRow(change)).join(' · '),
        count: view.supersedesItems.length,
      })}
      port={
        <DecisionPortBody
          view={view}
          workItemRefs={workItemRefs}
          // The DECIDED bands read the stamp; only an open question links the record now.
          {...(gate.state === 'awaiting' ? { record, recordCount, recordPicker } : {})}
        />
      }
      verbs={verbs}
      consequence={t('consequence', { key: identifier })}
      confirmConsequences={[]}
      approvedStateLabel={t('state.confirmed')}
      routedToLabel={routedToLabel}
      filesKept={null}
      alert={alert}
      recordLead={
        gate.state === 'approved' && gate.decidedAt ? (
          <span className="font-medium text-(--el-text)">
            {t('band.confirmedBy', { name, when })}
          </span>
        ) : gate.state === 'overturned' && gate.decidedAt ? (
          <span className="font-medium text-(--el-text)">
            {t('band.overturnedBy', { name, when })}
          </span>
        ) : undefined
      }
      recordDetail={
        gate.state === 'approved' ? (
          <ConfirmedBand stamp={gate.confirmedRecord} presentRecordIds={presentRecordIds} />
        ) : gate.state === 'overturned' ? (
          <OverturnedBand
            noteMd={gate.noteMd}
            keys={gate.replanOwed?.keys ?? keys}
            items={view.supersedesItems}
            door={door}
          />
        ) : undefined
      }
      recordBand={ask}
      onDecide={onDecide}
      onShowCurrentVersion={onShowCurrentVersion}
      focusPortOnMount={focusPortOnMount}
    />
  );
}

/** Design Panels 3a–3c — read from the STAMP: with a record, without one, or removed. */
function ConfirmedBand({
  stamp,
  presentRecordIds,
}: {
  stamp: ConfirmedRecordDTO | null;
  presentRecordIds: string[];
}) {
  const t = useTranslations('approvalGate.decisionConfirm.band');
  if (!stamp || stamp.kind === 'none') {
    return <span className="basis-full text-(--el-text)">{t('withoutRecord')}</span>;
  }
  if (stamp.kind === 'page') {
    // Delta 4 Panel 4: the FROZEN version, read from the stamp — never the live page.
    return (
      <span className="flex basis-full flex-wrap items-center gap-2 text-(--el-text)">
        <span>{t('withRecord')}</span>
        <Link
          href={`/pages/${encodeURIComponent(stamp.pageId)}?version=${stamp.versionNumber}`}
          className="inline-flex items-center gap-1 text-(--el-link) hover:underline"
        >
          <Notebook className="h-3.5 w-3.5 flex-none" aria-hidden />
          {t('pageRecord', { title: stamp.title, number: stamp.versionNumber })}
        </Link>
        <FrozenPill>{t('frozen')}</FrozenPill>
      </span>
    );
  }
  const present = presentRecordIds.includes(stamp.attachmentId);
  return (
    <span className="flex basis-full flex-wrap items-center gap-2 text-(--el-text)">
      <span>{t('withRecord')}</span>
      {present ? (
        <a
          href={attachmentContentPath(stamp.attachmentId)}
          className="inline-flex items-center gap-1 text-(--el-link) hover:underline"
        >
          <FileText className="h-3.5 w-3.5 flex-none" aria-hidden />
          {stamp.originalFilename}
        </a>
      ) : (
        <>
          <span className="font-mono text-xs">{stamp.originalFilename}</span>
          <span className="text-(--el-text-secondary)">{t('recordRemoved')}</span>
        </>
      )}
    </span>
  );
}

/**
 * Design Panel 4a — the note, the owed re-plan and its chips, then **Re-plan with AI**.
 *
 * ⚠️ THE PLAIN EPIC ENTRANCE IS GONE (MOTIR-6211; `approval-control--replan-door.mock.html`
 * panel 1c). It opened a BLANK planner on the epic; the door opens the planner on THIS
 * decision, SEEDED with the note and the superseded keys. The owed chip, its line and every
 * superseded chip stay exactly as they were.
 */
function OverturnedBand({
  noteMd,
  keys,
  items,
  door,
}: {
  noteMd: string | null;
  keys: string[];
  items: SupersededItemDTO[];
  door: ReactNode;
}) {
  const t = useTranslations('approvalGate.decisionConfirm.band');
  const titled = new Map(items.map((item) => [item.key, item.title]));
  return (
    <>
      {noteMd ? (
        <span className="basis-full border-l-2 border-(--el-border-strong) pl-3 text-(--el-text)">
          “{noteMd}”
        </span>
      ) : null}
      <span className="flex basis-full flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-(--radius-badge) border border-transparent bg-(--el-tint-peach) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-strong)">
          {t('replanOwed')}
        </span>
        <span className="text-(--el-text-secondary)">{t('replanOwedDetail')}</span>
      </span>
      <span className="flex basis-full flex-wrap gap-1.5">
        {keys.map((key) => (
          <SupersededChip key={key} item={{ key, title: titled.get(key) ?? null }} />
        ))}
      </span>
      {door}
    </>
  );
}

/**
 * THE DEFECT STATE (design Panel 5) — no gate is raised, so there is NO frame: the
 * reason in words, the shared tail, then the sections as far as they parse.
 */
export function DecisionConfirmDefectBody({
  defect,
  view,
  workItemRefs,
}: {
  defect: DecisionDefectDTO;
  view: DecisionPortView;
  workItemRefs: WorkItemRefMap;
}) {
  const t = useTranslations('approvalGate.decisionConfirm.defect');
  return (
    <div>
      <div
        role="status"
        className="mb-3 flex gap-2.5 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-tint-peach) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8)"
      >
        <CircleAlert
          className="mt-0.5 h-4 w-4 flex-none text-(--el-danger-on-surface)"
          aria-hidden
        />
        <div className="text-[13px] leading-snug text-(--el-text-strong)">
          <p>
            <b>
              {defect.reason === 'unknown_change'
                ? t('unknown_change', { value: defect.value })
                : t(defect.reason)}
            </b>
          </p>
          <p className="text-(--el-text-secondary)">{t('tail')}</p>
        </div>
      </div>
      <DecisionPortBody view={view} workItemRefs={workItemRefs} />
    </div>
  );
}
