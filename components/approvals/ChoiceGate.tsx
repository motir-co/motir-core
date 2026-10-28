'use client';

import { useState, type ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { MarkdownView } from '@/components/ui/MarkdownView';
import type { ChoiceOption, ChoiceSituation, ChoiceWhy } from '@/lib/approvalGates/choiceOptions';
import type { GateRefusal } from '@/lib/approvalGates/refusals';
import { useNoneOfTheseVerb } from './RefusalReason';
import { useRefusalReplanSlots, type RefusalReplanProps } from './RefusalReplan';
import type { ApprovalGateDTO, ChoiceDefectDTO, GateDecision } from '@/lib/dto/approvalGate';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import {
  ApprovalGateControl,
  type ApprovalGateControlProps,
  type GateVerb,
} from '@/components/approvals/ApprovalGateControl';

// THE CHOICE PORT (Story MOTIR-4914 · Subtask MOTIR-5896; design
// `design/work-items/approval-control--choice.mock.html` + `design-notes.md`
// § THE CHOICE PORT). A person PICKS one of N options, each with its WHY and what
// it is best for, and what they chose is stamped.
//
// ⚠️ THE FRAME IS THE SHARED ONE. `ChoiceGateFrame` renders `ApprovalGateControl`
// — the same bands, states, confirm band, refusals and record every kind uses —
// and supplies only the three things a kind supplies: the PORT, the VERB SET and
// the words. Nothing here draws a second approve control.
//
// ⚠️ SELECT, THEN COMMIT (design § Band 3). The options are selected WHERE THEIR
// REASON IS WRITTEN — a radio row in the port — and band 3 carries ONE commit verb
// naming the selection, plus *None of these*. A row of N buttons would put the
// options in two places and have a person press a NAME. So the verb list is
// DERIVED from the parsed options through the selection: a 2-option and a 6-option
// choice take the same path.

/** A chip in the shipped Pill SHAPE with a tint that carries no status meaning. */
function Chip({
  tint,
  children,
}: {
  tint: 'sky' | 'lavender' | 'mint' | 'peach';
  children: ReactNode;
}) {
  const bg = {
    sky: 'bg-(--el-tint-sky)',
    lavender: 'bg-(--el-tint-lavender)',
    mint: 'bg-(--el-tint-mint)',
    peach: 'bg-(--el-tint-peach)',
  }[tint];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-(--radius-badge) border border-transparent px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs font-medium text-(--el-text-strong) ${bg}`}
    >
      {children}
    </span>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase">
      {children}
    </p>
  );
}

/** The situation's words — one of three, closed. */
export function useSituationLabel(): (situation: ChoiceSituation) => string {
  const t = useTranslations('approvalGate.choice.situation');
  return (situation) => t(situation);
}

/** WHY THIS IS A CHOICE (design Panel 1d) — under the question, above the options. */
function WhyBlock({ why, workItemRefs }: { why: ChoiceWhy; workItemRefs: WorkItemRefMap }) {
  const t = useTranslations('approvalGate.choice');
  const situationLabel = useSituationLabel();
  return (
    <div className="rounded-(--radius-card) border border-(--el-border-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8)">
      <div className="flex flex-wrap items-center gap-2">
        <Eyebrow>{t('why')}</Eyebrow>
        <Chip tint="lavender">{situationLabel(why.situation)}</Chip>
      </div>
      {why.youSaid ? (
        <p className="mt-2 border-l-2 border-(--el-border-strong) pl-3 text-[13px] leading-snug text-(--el-text)">
          <span className="text-xs text-(--el-text-secondary)">{t('youSaid')}</span>
          <br />“{why.youSaid}”
        </p>
      ) : null}
      {why.evidenceMd ? (
        <MarkdownView
          value={why.evidenceMd}
          workItemRefs={workItemRefs}
          className="mt-2 text-[13px] leading-snug text-(--el-text-secondary)"
        />
      ) : null}
    </div>
  );
}

function BestFor({ value }: { value: string }) {
  const t = useTranslations('approvalGate.choice');
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-xs text-(--el-text-secondary)">{t('bestIfYouWant')}</span>
      <Chip tint="sky">{value}</Chip>
    </span>
  );
}

/**
 * How the option rows behave:
 *   · `pick`   — a radio group; the whole row is the hit target (state A);
 *   · `read`   — the rows WITHOUT radios, not disabled ones (state B, the item page);
 *   · `chosen` — the chosen row carries the accent glyph and a *Chosen* chip, the
 *                others are NOT dimmed (state E);
 *   · `defect` — read-only, and an option missing its best-for line is flagged.
 */
export type ChoiceRowMode = 'pick' | 'read' | 'chosen' | 'defect';

export interface ChoiceBodyView {
  question: string;
  why: ChoiceWhy | null;
  options: ChoiceOption[];
  followUpMd: string;
}

export function ChoicePortBody({
  body,
  workItemRefs,
  mode,
  groupName,
  selectedId = null,
  onSelect,
  chosenId = null,
}: {
  body: ChoiceBodyView;
  /** The chips of every `[KEY](motir:<id>)` in the body (MOTIR-10023). */
  workItemRefs: WorkItemRefMap;
  mode: ChoiceRowMode;
  /** The radio group's name — unique per gate on the page. */
  groupName: string;
  selectedId?: string | null;
  onSelect?: (optionId: string) => void;
  chosenId?: string | null;
}) {
  const t = useTranslations('approvalGate.choice');
  return (
    <div className="flex flex-col gap-3" data-testid="choice-port">
      {body.question ? (
        <div>
          <Eyebrow>{t('question')}</Eyebrow>
          <p className="mt-1 text-sm font-medium text-(--el-text)">{body.question}</p>
        </div>
      ) : null}
      {body.why ? <WhyBlock why={body.why} workItemRefs={workItemRefs} /> : null}
      <div
        className="flex flex-col gap-2"
        {...(mode === 'pick'
          ? { role: 'radiogroup', 'aria-label': t('options', { count: body.options.length }) }
          : {})}
      >
        <Eyebrow>{t('options', { count: body.options.length })}</Eyebrow>
        {body.options.map((option) => (
          <OptionRow
            key={option.id}
            option={option}
            workItemRefs={workItemRefs}
            mode={mode}
            groupName={groupName}
            selected={selectedId === option.id}
            chosen={chosenId === option.id}
            onSelect={onSelect}
          />
        ))}
      </div>
      {body.followUpMd ? (
        <div className="rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8)">
          <Eyebrow>{t('gates')}</Eyebrow>
          <MarkdownView
            value={body.followUpMd}
            workItemRefs={workItemRefs}
            className="mt-1 text-[13px] leading-snug text-(--el-text)"
          />
        </div>
      ) : null}
    </div>
  );
}

function OptionRow({
  option,
  workItemRefs,
  mode,
  groupName,
  selected,
  chosen,
  onSelect,
}: {
  option: ChoiceOption;
  workItemRefs: WorkItemRefMap;
  mode: ChoiceRowMode;
  groupName: string;
  selected: boolean;
  chosen: boolean;
  onSelect?: (optionId: string) => void;
}) {
  const t = useTranslations('approvalGate.choice');
  const text = (
    <span className="min-w-0 flex-1">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-(--el-text)">{option.label}</span>
        {option.bestFor ? <BestFor value={option.bestFor} /> : null}
        {chosen ? <Chip tint="mint">{t('state.chosen')}</Chip> : null}
      </span>
      {option.whyMd ? (
        <MarkdownView
          value={option.whyMd}
          workItemRefs={workItemRefs}
          className="mt-0.5 block text-[13px] leading-snug text-(--el-text-secondary)"
        />
      ) : null}
      {mode === 'defect' && !option.bestFor ? (
        <span className="mt-1 flex items-center gap-1.5 text-xs text-(--el-danger-on-surface)">
          <CircleAlert className="h-3.5 w-3.5 flex-none" aria-hidden />
          {t('defect.flag')}
        </span>
      ) : null}
    </span>
  );

  if (mode === 'pick') {
    return (
      <label
        className={`flex cursor-pointer gap-3 rounded-(--radius-card) border px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) hover:bg-(--el-surface) ${
          selected
            ? 'border-(--el-accent) bg-(--el-surface-soft)'
            : 'border-(--el-border) bg-(--el-page-bg)'
        }`}
        data-option-id={option.id}
      >
        <input
          type="radio"
          name={groupName}
          value={option.id}
          checked={selected}
          onChange={() => onSelect?.(option.id)}
          className="sr-only"
        />
        <span
          aria-hidden
          className={`mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full border bg-(--el-page-bg) ${
            selected ? 'border-(--el-accent)' : 'border-(--el-border-strong)'
          }`}
        >
          {selected ? <span className="h-2 w-2 rounded-full bg-(--el-accent)" /> : null}
        </span>
        {text}
      </label>
    );
  }

  return (
    <div
      className="flex gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8)"
      data-option-id={option.id}
    >
      {chosen ? (
        <CircleCheck
          className="mt-0.5 h-4 w-4 flex-none text-(--el-accent-on-surface)"
          aria-hidden
        />
      ) : (
        <span aria-hidden className="mt-0.5 h-4 w-4 flex-none" />
      )}
      {text}
    </div>
  );
}

/** What is being asked, flattened for a sentence (a confirm line, the record). */
function plain(markdown: string): string {
  return markdown
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ChoiceGateFrameProps {
  gate: ApprovalGateDTO;
  /**
   * The options the gate asks about — the route's / the page's parse. A DRAFT is
   * accepted too: a decided gate's record outlives a body that stopped parsing.
   */
  port: ChoiceBodyView;
  /** The chips of every `[KEY](motir:<id>)` in the port (MOTIR-10023). */
  workItemRefs: WorkItemRefMap;
  canDecide: boolean;
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
  /**
   * THE RE-PLAN WITH AI DOOR on a None-of-these record, and the ask right after the press
   * (Story MOTIR-6068 · MOTIR-6211). Omitted: no door.
   */
  replan?: RefusalReplanProps;
}

/**
 * The choice gate in the shared frame. Holds ONE piece of state — which option is
 * selected — and derives the verbs, the consequence and the confirm band from it.
 */
export function ChoiceGateFrame({
  gate,
  port,
  workItemRefs,
  canDecide,
  routedToLabel,
  identifier,
  layout,
  onDecide,
  alert,
  onShowCurrentVersion,
  focusPortOnMount,
  replan,
}: ChoiceGateFrameProps) {
  const t = useTranslations('approvalGate.choice');
  const format = useFormatter();
  const situationLabel = useSituationLabel();
  const noneOfThese = useNoneOfTheseVerb();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = port.options.find((option) => option.id === selectedId) ?? null;
  const decided = gate.state === 'approved' || gate.state === 'changes_requested';
  const live = canDecide && gate.state === 'awaiting';

  // ⚠️ THE RECORD IS READ FROM `chosenOption`, NEVER FROM THE BODY (design Panel 5a):
  // the body may have changed since, and the record must say what was picked then.
  const chosen = gate.state === 'approved' ? gate.chosenOption : null;
  const gates = plain(port.followUpMd);
  // None of these offers the seeded planner (§10h), and so does an option CHOSEN
  // (MOTIR-6436 — its follow-up planning): the door on the record, or — for the reader
  // who has just pressed it — the ask in its place.
  const { door, ask } = useRefusalReplanSlots({
    gate,
    itemKey: identifier,
    replan,
    sectioned: layout === 'section',
  });

  // THE VERB SET, derived — *None of these*, then ONE commit verb for the selection.
  // Before a pick the commit verb is drawn DISABLED with its reason as the
  // consequence line (the frame's honest-disabled rule, MOTIR-5678).
  const verbs: GateVerb[] = [
    // *None of these* is a refusal, so it SAYS WHY (ADR §10a; design Panel 3).
    noneOfThese(identifier),
    {
      decision: 'choose',
      label: selected ? t('verb.choose', { label: selected.label }) : t('verb.chooseEmpty'),
      variant: 'primary',
      confirms: true,
      ...(selected ? { optionId: selected.id } : { disabled: true }),
    },
  ];

  return (
    <ApprovalGateControl
      gate={gate}
      layout={layout}
      canDecide={live}
      kindLabel={t('kindLabel')}
      subjectMeta={t('meta', { count: port.options.length })}
      port={
        <ChoicePortBody
          body={port}
          workItemRefs={workItemRefs}
          mode={chosen ? 'chosen' : live ? 'pick' : 'read'}
          groupName={`choice-${gate.id}`}
          selectedId={selectedId}
          onSelect={setSelectedId}
          chosenId={chosen?.optionId ?? null}
        />
      }
      verbs={verbs}
      consequence={
        selected
          ? t('consequence.picked', { key: identifier })
          : t('consequence.pick', { key: identifier })
      }
      confirmTitle={t('confirm.title')}
      confirmConsequences={
        selected
          ? [
              t('confirm.record', { label: selected.label, bestFor: selected.bestFor }),
              t('confirm.done', { key: identifier }),
              t('confirm.askPlan', { gates }),
            ]
          : []
      }
      confirmProceedLabel={selected ? t('confirm.proceed', { label: selected.label }) : undefined}
      approvedStateLabel={t('state.chosen')}
      changesRequestedLine={t('record.willRevise')}
      routedToLabel={routedToLabel}
      filesKept={null}
      alert={alert}
      recordLead={
        decided && chosen && gate.decidedAt ? (
          <span className="font-medium text-(--el-text)">
            {t('record.lead', {
              name: gate.decidedByLabel ?? '',
              when: format.dateTime(new Date(gate.decidedAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              }),
            })}
          </span>
        ) : undefined
      }
      recordDetail={
        chosen ? (
          <>
            <span className="flex basis-full flex-wrap items-center gap-2">
              <span className="text-(--el-text)">{t('record.chose')}</span>
              <Chip tint="mint">{chosen.label}</Chip>
              <BestFor value={chosen.bestFor} />
            </span>
            <span className="flex basis-full flex-wrap items-center gap-2">
              <span className="text-(--el-text)">{t('record.askedBecause')}</span>
              <Chip tint="lavender">{situationLabel(chosen.situation)}</Chip>
            </span>
            {/* What the choice gates stays as INFORMATION; the word *owed* goes, and the
                door is how to start it (design MOTIR-6432 panel 1). */}
            <span className="basis-full text-(--el-text)">
              {t.rich('record.gates', {
                gates: plain(chosen.followUp),
                b: (chunks) => <b>{chunks}</b>,
              })}
            </span>
            {door}
          </>
        ) : (
          door
        )
      }
      recordBand={ask}
      onDecide={onDecide}
      onShowCurrentVersion={onShowCurrentVersion}
      focusPortOnMount={focusPortOnMount}
    />
  );
}

/**
 * THE DEFECT STATE (design Panel 3) — no gate is raised, so there is NO frame: the
 * section says what is missing, then shows the options as far as they parse,
 * read-only. One sentence per reason, and every one ends with the same next step.
 */
export function ChoiceDefectBody({
  defects,
  draft,
  workItemRefs,
}: {
  defects: ChoiceDefectDTO[];
  draft: ChoiceBodyView;
  workItemRefs: WorkItemRefMap;
}) {
  const t = useTranslations('approvalGate.choice');
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
          {defects.map((defect, index) => (
            <p key={index}>
              <b>{defectSentence(t, defect)}</b>
            </p>
          ))}
          <p className="text-(--el-text-secondary)">{t('defect.fix')}</p>
        </div>
      </div>
      <ChoicePortBody
        body={draft}
        workItemRefs={workItemRefs}
        mode="defect"
        groupName="choice-defect"
      />
    </div>
  );
}

function defectSentence(
  t: ReturnType<typeof useTranslations<'approvalGate.choice'>>,
  defect: ChoiceDefectDTO,
): string {
  switch (defect.reason) {
    case 'option_without_best_for':
    case 'duplicate_option':
      return t(`defect.${defect.reason}`, { label: defect.label });
    case 'unknown_situation':
      return t('defect.unknown_situation', { value: defect.value });
    default:
      return t(`defect.${defect.reason}`);
  }
}
