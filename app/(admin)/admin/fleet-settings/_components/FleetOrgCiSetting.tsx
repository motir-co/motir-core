'use client';

import { useId, useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import {
  CircleAlert,
  CircleCheck,
  CircleQuestionMark,
  Info,
  Server,
  ServerCog,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { Switch } from '@/components/ui/Switch';
import type {
  FleetOrgCiCodeScanningDTO,
  FleetOrgCiStateDTO,
  FleetOrgCiTargetDTO,
} from '@/lib/dto/fleetOrgCiSetting';
import {
  setFleetOrgCiAction,
  type FleetOrgCiActionResult,
  type FleetOrgCiNotMetCondition,
} from '../actions';
import {
  strings,
  whyText,
  type FleetReadinessCondition,
  type FleetTranslate,
} from './fleetReadinessCopy';

/**
 * ONE (project, org) pair's fleet CI setting and its readiness verdict —
 * design `platform-admin/design-notes.md` § AMENDMENT 2026-10 (Fleet settings),
 * Panels 1–11, card MOTIR-8715.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ THIS ISLAND OWNS A DIALOG AND AN ANSWER, NEVER A STORED STATE
 * ---------------------------------------------------------------------------
 * The switch, the chip, the last-changed line, the variable read-back and every
 * readiness row are the server-rendered `state` prop. Moving the switch does
 * not flip it: it opens the confirm, and the switch keeps showing the stored
 * state until the action answers and `revalidatePath` re-reads the page
 * (`CLAUDE.md`'s page-state contract). So on any `ok: false` the switch is,
 * trivially, still at its previous state.
 *
 * ⚠️ PRESENTATION, NOT RULE. The disabled ON switch is `readiness.ready`
 * rendered; the service re-reads readiness inside `setEnabled` and refuses ON
 * itself. Readiness is rendered from `reasonCode` + `params`; the service's
 * English `message` is shown only for a code this catalogue has no sentence for.
 *
 * ⚠️ `unknown` IS NOT MET. It shares the warning hue with `unmet` and differs by
 * word, glyph and a dashed edge — never the success or neutral role.
 */

/** Code constants the copy interpolates; the page passes them so this island
 *  imports no server module and the catalogue spells none of them. */
export interface FleetOrgCiConstants {
  /** `MOTIR_RUNNER_VARIABLE`. */
  variableName: string;
  /** `MOTIR_RUNNER_LABEL`. */
  runnerLabel: string;
  fleetName: string;
  killSwitchVariable: string;
}

export interface FleetOrgCiSettingProps {
  target: FleetOrgCiTargetDTO;
  state: FleetOrgCiStateDTO;
  constants: FleetOrgCiConstants;
}

/** How many uncovered jobs show before `+N more`. */
const JOBS_SHOWN = 5;

type Answer =
  | { kind: 'changed'; enabled: boolean }
  | { kind: 'unchanged'; enabled: boolean }
  | { kind: 'notReady'; conditions: FleetOrgCiNotMetCondition[] }
  | {
      kind: 'githubFailed';
      enabled: boolean;
      org: string;
      status: number | null;
      operation: 'read' | 'set' | 'delete';
    }
  | {
      kind: 'codeScanningFailed';
      enabled: boolean;
      repo: string;
      status: number | null;
      operation: 'read' | 'write';
      to: 'fleet' | 'github_hosted';
    }
  | { kind: 'refused'; code: 'NOT_PERMITTED' | 'TARGET_UNKNOWN' | 'FAILED'; enabled: boolean };

type T = ReturnType<typeof useTranslations<'platformAdmin.fleetSettings'>>;

export function FleetOrgCiSetting({ target, state, constants }: FleetOrgCiSettingProps) {
  const t = useTranslations('platformAdmin.fleetSettings');
  const format = useFormatter();
  const router = useRouter();
  const titleId = useId();
  const blockedId = useId();
  const reasonFieldId = useId();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonRefused, setReasonRefused] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isRechecking, startRecheck] = useTransition();

  const { enabled, readiness, variable } = state;
  const ready = readiness.ready;
  const blocked = !enabled && !ready;
  const degraded = enabled && !ready;
  const asking = !enabled;
  const repositories = privateRepositories(readiness.conditions);
  const org = target.org;
  const name = constants.variableName;

  function closeConfirm() {
    setConfirming(false);
    setReason('');
    setReasonRefused(false);
  }

  function report(result: FleetOrgCiActionResult, asked: boolean) {
    if (!result.ok && result.code === 'REASON_REQUIRED') {
      // 8b — inline under the field; the dialog stays open, nothing changed.
      setReasonRefused(true);
      return;
    }
    closeConfirm();
    if (result.ok) {
      setAnswer(
        result.outcome === 'unchanged'
          ? { kind: 'unchanged', enabled: result.enabled }
          : { kind: 'changed', enabled: asked },
      );
      return;
    }
    switch (result.code) {
      case 'NOT_READY':
        setAnswer({ kind: 'notReady', conditions: result.conditions });
        return;
      case 'GITHUB_WRITE_FAILED':
        setAnswer({
          kind: 'githubFailed',
          enabled: asked,
          org: result.org,
          status: result.status,
          operation: result.operation,
        });
        return;
      case 'CODE_SCANNING_FAILED':
        setAnswer({
          kind: 'codeScanningFailed',
          enabled: asked,
          repo: `${result.org}/${result.repo}`,
          status: result.status,
          operation: result.operation,
          to: result.to,
        });
        return;
      case 'NOT_PERMITTED':
      case 'TARGET_UNKNOWN':
      case 'FAILED':
        setAnswer({ kind: 'refused', code: result.code, enabled: asked });
        return;
    }
  }

  function submit() {
    const trimmed = reason.trim();
    // Refused inline, before any action call (8a); the server's
    // `MissingAuditReasonError` is the rule (8b).
    if (!trimmed) {
      setReasonRefused(true);
      return;
    }
    const asked = asking;
    startTransition(async () => {
      report(await setFleetOrgCiAction(target.projectId, org, asked, trimmed), asked);
    });
  }

  const reasonEmpty = reason.trim().length === 0;
  const directionWord = (on: boolean) => t(on ? 'direction.on' : 'direction.off');

  return (
    <div className="flex flex-col gap-4" data-testid={`fleet-org-ci-${target.projectKey}`}>
      <Card
        header={
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex min-w-0 items-start gap-3">
              <span
                aria-hidden
                className="flex h-(--height-control-32) w-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-lavender) text-(--el-text-strong)"
              >
                <ServerCog className="h-4 w-4" />
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <h2 id={titleId} className="font-sans text-sm font-semibold text-(--el-text)">
                  {t('setting.title')}
                </h2>
                <p className="font-sans text-xs text-(--el-text-secondary)">
                  {t('setting.pair', { project: target.projectKey, org })}
                </p>
              </div>
            </div>
            <Pill memberRole="admin">{t('setting.superadminOnly')}</Pill>
          </div>
        }
        footer={
          <p className="flex items-center gap-2 font-sans text-xs">
            <Server aria-hidden className="h-3.5 w-3.5 shrink-0 text-(--el-icon-muted)" />
            <Link href="/admin/monitoring" className="text-(--el-link) underline">
              {t('monitoringLine')}
            </Link>
          </p>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">
            {t('setting.explanation', {
              org,
              label: constants.runnerLabel,
              fleet: constants.fleetName,
            })}
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <Switch
              checked={enabled}
              disabled={blocked || isPending}
              aria-labelledby={titleId}
              onCheckedChange={() => {
                setAnswer(null);
                setConfirming(true);
              }}
            />
            {enabled ? (
              <Pill severity="success">{t('state.on')}</Pill>
            ) : (
              <Pill tone="neutral">{t('state.off')}</Pill>
            )}
            <span className="font-sans text-sm text-(--el-text-secondary)">
              {t(enabled ? 'action.turnOff' : 'action.turnOn')}
            </span>
            {blocked ? (
              <span
                id={blockedId}
                data-testid="fleet-org-ci-blocked"
                className="flex items-center gap-1.5 font-sans text-xs text-(--el-text-secondary)"
              >
                <TriangleAlert aria-hidden className="h-3.5 w-3.5 shrink-0 text-(--el-warning)" />
                {t('blocked')}
              </span>
            ) : null}
            {degraded ? (
              <span className="flex items-center gap-1.5 font-sans text-xs text-(--el-text-secondary)">
                <Info aria-hidden className="h-3.5 w-3.5 shrink-0 text-(--el-info)" />
                {t('offNeverBlocked')}
              </span>
            ) : null}
          </div>

          {enabled && ready ? (
            <Band tone="info" role="status">
              <strong className="font-semibold">{t('onCallout.title')}</strong>{' '}
              <Link href="/admin/monitoring" className="text-(--el-text-strong) underline">
                {t('onCallout.link')}
              </Link>
            </Band>
          ) : null}

          {degraded ? (
            <Band tone="warning" role="status" testId="fleet-org-ci-degraded">
              <strong className="font-semibold">{t('degraded.title')}</strong> {t('degraded.body')}
            </Band>
          ) : null}

          {enabled && variable.state === 'absent' ? (
            <Band tone="warning" role="status" testId="fleet-org-ci-drift">
              <strong className="font-semibold">{t('drift.onAbsent.title')}</strong>{' '}
              {t('drift.onAbsent.body', { name, org })}
            </Band>
          ) : null}
          {!enabled && variable.state === 'present' ? (
            <Band tone="warning" role="status" testId="fleet-org-ci-drift">
              <strong className="font-semibold">{t('drift.offPresent.title')}</strong>{' '}
              {t('drift.offPresent.body', { name, org })}
            </Band>
          ) : null}

          {answer ? (
            <AnswerBand answer={answer} t={t} name={name} direction={directionWord} />
          ) : null}

          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 font-sans text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-(--el-text-secondary)">{t('meta.lastChanged')}</dt>
            <dd className="text-(--el-text)" data-testid="fleet-org-ci-last-changed">
              {state.updatedBy ? (
                <>
                  {t('meta.changedBy', {
                    email: state.updatedBy.email,
                    when: state.updatedAt ? format.relativeTime(new Date(state.updatedAt)) : '',
                    reason: state.lastReason ?? '',
                  })}{' '}
                  <Link
                    href={`/admin/audit-log?action=${enabled ? 'fleet.org_ci.enable' : 'fleet.org_ci.disable'}`}
                    className="text-(--el-link) underline"
                  >
                    {t('meta.auditLink')}
                  </Link>
                </>
              ) : (
                t('meta.neverChanged')
              )}
            </dd>
            <dt className="text-(--el-text-secondary)">{t('meta.variable')}</dt>
            <dd className="text-(--el-text)" data-testid="fleet-org-ci-variable">
              {variable.state === 'present'
                ? t('variable.present', { name, value: variable.value, org })
                : variable.state === 'absent'
                  ? t('variable.absent', { name, org })
                  : variable.status === null
                    ? t('variable.unreachable', { name, org })
                    : t('variable.unknown', { name, org, status: variable.status })}
            </dd>
            <dt className="text-(--el-text-secondary)">{t('meta.codeScanning')}</dt>
            <dd data-testid="fleet-org-ci-code-scanning">
              <CodeScanningList
                entries={state.codeScanning}
                t={t}
                org={org}
                label={constants.runnerLabel}
              />
            </dd>
            {repositories ? (
              <>
                <dt className="text-(--el-text-secondary)">{t('meta.repositories')}</dt>
                <dd className="text-(--el-text)">
                  <span className="font-mono text-xs text-(--el-text-strong)">
                    {repositories.map(shortName).join(' · ')}
                  </span>{' '}
                  <span className="text-(--el-text-secondary)">
                    —{' '}
                    {t('repositories.count', {
                      count: repositories.length,
                      project: target.projectKey,
                      org,
                    })}
                  </span>
                </dd>
              </>
            ) : null}
          </dl>
        </div>
      </Card>

      <ReadinessCard
        target={target}
        state={state}
        constants={constants}
        rechecked={answer?.kind === 'notReady'}
        rechecking={isRechecking}
        onRecheck={() => startRecheck(() => router.refresh())}
      />

      <Modal
        open={confirming}
        onOpenChange={(next) => (next ? undefined : closeConfirm())}
        role="alertdialog"
        title={t(asking ? 'confirm.onTitle' : 'confirm.offTitle', { org })}
        description={
          asking
            ? t('confirm.onBody', {
                count: repositories?.length ?? 0,
                repositories: (repositories ?? []).map(shortName).join(', '),
              })
            : t('confirm.offBody')
        }
        size="md"
      >
        <Modal.Body className="gap-4">
          <Input
            id={reasonFieldId}
            label={t('confirm.reasonLabel')}
            placeholder={t(asking ? 'confirm.reasonPlaceholderOn' : 'confirm.reasonPlaceholderOff')}
            helperText={t(reasonEmpty ? 'confirm.reasonHintEmpty' : 'confirm.reasonHint')}
            error={
              reasonRefused
                ? t('refused.reasonMissing', { direction: directionWord(asking) })
                : undefined
            }
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              setReasonRefused(false);
            }}
            autoFocus
            maxLength={280}
          />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onClick={closeConfirm} disabled={isPending}>
            {t('confirm.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={isPending}
            // A courtesy: the audit vocabulary's `required` reason policy is the
            // rule, asserted in the service.
            disabled={reasonEmpty}
          >
            {t(asking ? 'confirm.confirmOn' : 'confirm.confirmOff')}
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
}

/** A warning / info / error band — the console's toast roles as an inline row. */
function Band({
  tone,
  role,
  testId,
  children,
}: {
  tone: 'info' | 'warning' | 'danger';
  role: 'status' | 'alert';
  testId?: string;
  children: ReactNode;
}) {
  const ground =
    tone === 'info'
      ? 'bg-(--el-tint-sky)'
      : tone === 'warning'
        ? 'bg-(--el-tint-yellow)'
        : 'bg-(--el-tint-rose)';
  const glyph =
    tone === 'info' ? (
      <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-info)" />
    ) : tone === 'warning' ? (
      <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-warning)" />
    ) : (
      <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger)" />
    );
  return (
    <div
      role={role}
      data-testid={testId}
      data-tone={tone}
      className={`flex items-start gap-2 rounded-(--radius-card) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-sm text-(--el-text-strong) ${ground}`}
    >
      {glyph}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Panels 9–11 and the three refusals with no drawn panel. */
function AnswerBand({
  answer,
  t,
  name,
  direction,
}: {
  answer: Answer;
  t: T;
  name: string;
  direction: (on: boolean) => string;
}) {
  switch (answer.kind) {
    case 'changed':
      return (
        <Band tone="info" role="status" testId="fleet-org-ci-answer">
          {t(answer.enabled ? 'done.on' : 'done.off')}
        </Band>
      );
    case 'unchanged':
      return (
        <Band tone="info" role="status" testId="fleet-org-ci-answer">
          <strong className="font-semibold">
            {t(answer.enabled ? 'refused.alreadyOn' : 'refused.alreadyOff')}
          </strong>{' '}
          {t('refused.alreadyBody')}
        </Band>
      );
    case 'githubFailed':
      return (
        <Band tone="danger" role="alert" testId="fleet-org-ci-answer">
          <p>
            {answer.status === null
              ? t('refused.githubUnreachable', {
                  direction: direction(answer.enabled),
                  operation: t(`operation.${answer.operation}`),
                  name,
                  org: answer.org,
                })
              : t('refused.githubStatus', {
                  direction: direction(answer.enabled),
                  operation: t(`operation.${answer.operation}`),
                  name,
                  org: answer.org,
                  status: answer.status,
                })}
          </p>
          <p>{t('refused.nothingChanged')}</p>
        </Band>
      );
    case 'codeScanningFailed': {
      const values = {
        direction: direction(answer.enabled),
        repo: answer.repo,
        runner: t(answer.to === 'fleet' ? 'runner.fleet' : 'runner.githubHosted'),
      };
      const read = answer.operation === 'read';
      return (
        <Band tone="danger" role="alert" testId="fleet-org-ci-answer">
          <p>
            {answer.status === null
              ? t(
                  read
                    ? 'refused.codeScanningReadUnreachable'
                    : 'refused.codeScanningWriteUnreachable',
                  values,
                )
              : t(read ? 'refused.codeScanningReadStatus' : 'refused.codeScanningWriteStatus', {
                  ...values,
                  status: answer.status,
                })}
          </p>
          <p>{t('refused.codeScanningNothingChanged')}</p>
        </Band>
      );
    }
    case 'notReady':
      return (
        <Band tone="danger" role="alert" testId="fleet-org-ci-answer">
          <p>{t('refused.notReady')}</p>
          <p>
            {t('refused.notReadyList', {
              conditions: answer.conditions.map((c) => conditionLabel(t, c.key, null)).join(', '),
            })}
          </p>
        </Band>
      );
    case 'refused':
      return (
        <Band tone="danger" role="alert" testId="fleet-org-ci-answer">
          {answer.code === 'NOT_PERMITTED'
            ? t('refused.notPermitted')
            : answer.code === 'TARGET_UNKNOWN'
              ? t('refused.targetUnknown')
              : t('refused.failed', { direction: direction(answer.enabled) })}
        </Band>
      );
  }
}

/**
 * Where each private repository's CodeQL default setup runs (MOTIR-10289). Only
 * a repository with default setup CONFIGURED is listed — one without it has no
 * CodeQL job to place — plus any whose setting could not be read, which says so
 * rather than guessing.
 */
function CodeScanningList({
  entries,
  t,
  org,
  label,
}: {
  entries: FleetOrgCiCodeScanningDTO[];
  t: T;
  org: string;
  label: string;
}) {
  const shown = entries.filter((e) => e.state !== 'not_configured' && e.state !== 'unavailable');
  if (shown.length === 0) {
    return <span className="text-(--el-text-secondary)">{t('codeScanning.none', { org })}</span>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {shown.map((entry) => (
        <li
          key={entry.repo}
          className="text-(--el-text)"
          data-testid={`fleet-org-ci-code-scanning-${entry.repo}`}
          data-state={entry.state}
        >
          <span className="font-mono text-xs text-(--el-text-strong)">{entry.repo}</span> —{' '}
          {entry.state === 'fleet'
            ? t('codeScanning.fleet', { label })
            : entry.state === 'pending_fleet'
              ? t('codeScanning.pendingFleet', { label })
              : entry.state === 'github_hosted'
                ? t('codeScanning.githubHosted')
                : entry.state === 'unknown' && entry.status !== null
                  ? t('codeScanning.unknownStatus', { status: entry.status })
                  : t('codeScanning.unknownUnreachable')}
        </li>
      ))}
    </ul>
  );
}

function ReadinessCard({
  target,
  state,
  constants,
  rechecked,
  rechecking,
  onRecheck,
}: {
  target: FleetOrgCiTargetDTO;
  state: FleetOrgCiStateDTO;
  constants: FleetOrgCiConstants;
  rechecked: boolean;
  rechecking: boolean;
  onRecheck: () => void;
}) {
  const t = useTranslations('platformAdmin.fleetSettings');
  const format = useFormatter();
  const listId = useId();
  const { readiness } = state;
  const notMet = readiness.conditions.filter((c) => c.state !== 'met');
  const unmet = notMet.filter((c) => c.state === 'unmet').length;
  const unknown = notMet.filter((c) => c.state === 'unknown').length;
  const when = format.relativeTime(new Date(readiness.checkedAt));

  return (
    <Card
      data-testid="fleet-readiness"
      header={
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-3">
            <span
              aria-hidden
              className={`flex h-(--height-control-32) w-8 shrink-0 items-center justify-center rounded-(--radius-control) ${
                readiness.ready
                  ? 'bg-(--el-tint-mint) text-(--el-success)'
                  : 'bg-(--el-tint-yellow) text-(--el-warning)'
              }`}
            >
              {readiness.ready ? (
                <CircleCheck className="h-4 w-4" />
              ) : (
                <TriangleAlert className="h-4 w-4" />
              )}
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <h2 id={listId} className="font-sans text-sm font-semibold text-(--el-text)">
                {t('readiness.title')}
              </h2>
              <p className="max-w-prose font-sans text-xs text-(--el-text-secondary)">
                {t('readiness.subtitle')}
              </p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1" data-testid="fleet-readiness-verdict">
            {readiness.ready ? (
              <>
                <Pill severity="success">{t('readiness.ready')}</Pill>
                <span className="font-sans text-xs text-(--el-text-secondary)">
                  {t('readiness.readySub', { count: readiness.conditions.length })}
                </span>
              </>
            ) : (
              <>
                <Pill tone="awaiting">{t('readiness.notReady', { count: notMet.length })}</Pill>
                <span className="font-sans text-xs text-(--el-text-secondary)">
                  {[
                    unmet ? t('readiness.unmetCount', { count: unmet }) : null,
                    unknown ? t('readiness.unknownCount', { count: unknown }) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </>
            )}
          </div>
        </div>
      }
      footer={
        <p className="flex flex-wrap items-center gap-2 font-sans text-xs text-(--el-text-secondary)">
          <span>{t(rechecked ? 'readiness.checkedAgain' : 'readiness.checked', { when })}</span>
          <Button variant="ghost" size="sm" onClick={onRecheck} loading={rechecking}>
            {t('readiness.recheck')}
          </Button>
        </p>
      }
    >
      <ul aria-labelledby={listId} className="flex flex-col divide-y divide-(--el-border-soft)">
        {readiness.conditions.map((condition) => (
          <ConditionRow
            key={condition.key}
            condition={condition}
            project={target.projectKey}
            org={readiness.org}
            constants={constants}
          />
        ))}
      </ul>
    </Card>
  );
}

function ConditionRow({
  condition,
  project,
  org,
  constants,
}: {
  condition: FleetReadinessCondition;
  project: string;
  org: string;
  constants: FleetOrgCiConstants;
}) {
  const t = useTranslations('platformAdmin.fleetSettings');
  const format = useFormatter();
  const jobs = jobsOf(condition);
  return (
    <li
      data-testid={`fleet-condition-${condition.key}`}
      data-state={condition.state}
      className="flex flex-col gap-1.5 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Mark state={condition.state} t={t} />
        <span className="font-sans text-sm text-(--el-text)">
          {conditionLabel(t, condition.key, project)}
        </span>
      </div>
      {condition.state === 'met' ? null : (
        <p className="font-sans text-xs text-(--el-text-secondary)">
          {whyText(
            t as unknown as FleetTranslate,
            (iso) => format.dateTime(new Date(iso), { dateStyle: 'medium' }),
            condition,
            { project, org, constants },
          )}
        </p>
      )}
      {condition.state !== 'met' && jobs.length > 0 ? <JobList jobs={jobs} /> : null}
    </li>
  );
}

function Mark({ state, t }: { state: FleetReadinessCondition['state']; t: T }) {
  if (state === 'met') {
    return (
      <Pill severity="success" className="gap-1">
        <CircleCheck aria-hidden className="h-3.5 w-3.5" />
        {t('mark.met')}
      </Pill>
    );
  }
  if (state === 'unmet') {
    return (
      <Pill tone="awaiting" className="gap-1">
        <TriangleAlert aria-hidden className="h-3.5 w-3.5" />
        {t('mark.unmet')}
      </Pill>
    );
  }
  return (
    <Pill tone="awaiting" className="gap-1 border-dashed border-(--el-border-strong)">
      <CircleQuestionMark aria-hidden className="h-3.5 w-3.5" />
      {t('mark.unknown')}
    </Pill>
  );
}

interface UncoveredJob {
  repoRef: string;
  workflow: string;
  jobId: string;
  verdict: string;
  missing: string[];
  reason: string | null;
}

function JobList({ jobs }: { jobs: UncoveredJob[] }) {
  const t = useTranslations('platformAdmin.fleetSettings');
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? jobs : jobs.slice(0, JOBS_SHOWN);
  const hidden = jobs.length - shown.length;
  return (
    <div className="flex flex-col gap-1.5 rounded-(--radius-control) border border-(--el-border-soft) px-(--spacing-control-x) py-(--spacing-control-y)">
      <ul data-testid="fleet-uncovered-jobs" className="flex flex-col gap-1">
        {shown.map((job) => {
          const values = {
            repo: shortName(job.repoRef),
            workflow: job.workflow.split('/').pop() ?? job.workflow,
            job: job.jobId,
          };
          return (
            <li
              key={`${job.repoRef}:${job.workflow}:${job.jobId}`}
              className="font-mono text-xs text-(--el-text-secondary)"
            >
              {job.verdict === 'cannot-host'
                ? t('jobs.cannotHost', { ...values, reason: job.reason ?? '' })
                : job.verdict === 'unverified'
                  ? t('jobs.unverified', { ...values, reason: job.reason ?? '' })
                  : t('jobs.missing', { ...values, tools: job.missing.join(', ') })}
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? (
        <div>
          <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
            {t('jobs.more', { count: hidden })}
          </Button>
        </div>
      ) : null}
      <p className="font-sans text-xs text-(--el-text-secondary)">{t('jobs.scope')}</p>
    </div>
  );
}

// ── Readiness copy, from codes ─────────────────────────────────────────────

const CONDITION_KEYS = new Set([
  'kill_switch',
  'app_installed',
  'app_runner_permission',
  'app_variables_permission',
  'workflow_job_subscription',
  'app_repositories',
  'delivery_attributable',
  'runner_group',
  'image_coverage',
]);

function conditionLabel(t: T, key: string, project: string | null): string {
  if (!CONDITION_KEYS.has(key)) return key;
  const label = t as unknown as (k: string, v?: Record<string, string>) => string;
  return label(`cond.${key}.label`, { project: project ?? '' });
}

function jobsOf(condition: FleetReadinessCondition): UncoveredJob[] {
  if (condition.key !== 'image_coverage') return [];
  const raw = condition.params['jobs'];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (j): j is UncoveredJob =>
      Boolean(j) &&
      typeof j === 'object' &&
      typeof (j as UncoveredJob).repoRef === 'string' &&
      typeof (j as UncoveredJob).jobId === 'string',
  );
}

/**
 * The pair's private repositories, as the verdict read them: `app_repositories`'
 * list when met, else `image_coverage`'s. `null` when neither condition was met,
 * so the line is left out rather than guessed.
 */
function privateRepositories(conditions: FleetReadinessCondition[]): string[] | null {
  for (const [key, code] of [
    ['app_repositories', 'all_reachable'],
    ['image_coverage', 'all_runnable'],
  ] as const) {
    const c = conditions.find((x) => x.key === key);
    if (c && c.state === 'met' && c.reasonCode === code) {
      const repos = strings(c.params['repositories']);
      if (repos.length) return repos;
    }
  }
  return null;
}

/** `owner/name` → `name`. */
function shortName(fullName: string): string {
  const i = fullName.lastIndexOf('/');
  return i === -1 ? fullName : fullName.slice(i + 1);
}
