'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Circle, CircleCheckBig, ExternalLink, Hand, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/ErrorState';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Spinner';
import type {
  TenantHandoverStep,
  TenantHandoverStepStatus,
} from '@/lib/ciFleet/hostingTenantAccounts';
import type {
  TenantAccountHandoverDto,
  TenantHandoverStepDto,
} from '@/lib/dto/tenantAccountHandover';
import { AwsHandoverUpstreams } from './AwsHandoverUpstreams';
import { awsHandoverClient, formatAwsAccountId, type HandoverAnswer } from './awsHandoverClient';

// THE HANDOVER CHECKLIST (Story MOTIR-9800 · MOTIR-12137 —
// design/repository-set/takeover--aws-handover.mock.html, panels 11–21).
//
// A durable card at the top of the Repositories room, not a dialog: the
// handover runs for days (AWS's own steps wait on the new owner), so it must
// outlive the dialog that started it and survive a reload (§14.5's reason).
//
// ⚠️ THE PAGE-STATE CONTRACT. This island is seeded from props, so
// `router.refresh()` cannot reach it. Every mutation's answer IS the new
// checklist and is applied in place; only the LATEST call's answer is applied
// (`seq`), so a slow poll can never overwrite what a click just returned.
//
// ⚠️ THE POLL. While a step is `running`, or the next step is `pending` and so
// queued for the job, the status is re-read every few seconds; it stops once
// every remaining step waits on a person (`waiting_on_you`), failed, or is done.
//
// ⚠️ NO FIELD TAKES A PAYMENT DETAIL OR A ROOT CREDENTIAL. The one input here is
// the one-time code AWS mails the new owner, passed to AWS and never stored.

/** How often a handover in motion re-reads its checklist. */
export const HANDOVER_POLL_MS = 5_000;

/** AWS's own sign-in page, where the new owner does AWS's steps. */
const AWS_SIGN_IN_URL = 'https://signin.aws.amazon.com/';

/** AWS's steps the new owner does, in the order the design lists them. */
const STANDALONE_STEPS = ['rootSignIn', 'payment', 'contact', 'agreement'] as const;

/** The unmet requirements the recheck reads back, worded. */
const MISSING_KEYS = new Set([
  'wait_period',
  'delegated_administrator',
  'payment_method',
  'support_plan',
  'contact_information',
]);

/** The steps whose `waiting_on_you` the recheck route answers. */
const RECHECKED = new Set<TenantHandoverStep>([
  'await_standalone',
  'remove_access',
  'leave_organization',
]);

type Overall = 'inProgress' | 'waiting' | 'failed' | 'done';

function overallOf(steps: readonly TenantHandoverStepDto[]): Overall {
  if (steps.length > 0 && steps.every((s) => s.status === 'done')) return 'done';
  if (steps.some((s) => s.status === 'failed')) return 'failed';
  if (steps.some((s) => s.status === 'waiting_on_you')) return 'waiting';
  return 'inProgress';
}

/** Whether the handover is moving without a person: a step runs, or the next
 *  step is queued for the job. */
export function handoverInMotion(handover: TenantAccountHandoverDto | null): boolean {
  if (!handover) return false;
  if (handover.steps.some((s) => s.status === 'running')) return true;
  const next = handover.steps.find((s) => s.status !== 'done');
  return next?.status === 'pending';
}

export interface AwsHandoverChecklistProps {
  organizationId: string;
  organizationName: string;
  tenantAccountId: string;
  /** How many repositories are handed over together. */
  repositoryCount: number;
  /** The checklist the start returned, when this session started it. */
  initial?: TenantAccountHandoverDto | null;
  /** Who it was handed to, when this session started it — the DTO never
   *  carries the owner's address, so later sessions word the rows without it. */
  owner?: { ownerEmail: string; githubOwner: string } | null;
}

type Load = { status: 'loading' } | { status: 'failed' } | { status: 'loaded' };

export function AwsHandoverChecklist({
  organizationId,
  organizationName,
  tenantAccountId,
  repositoryCount,
  initial = null,
  owner = null,
}: AwsHandoverChecklistProps) {
  const ta = useTranslations('repositoryTakeover.awsHandover');
  const titleId = useId();
  const [handover, setHandover] = useState<TenantAccountHandoverDto | null>(initial);
  const [load, setLoad] = useState<Load>(initial ? { status: 'loaded' } : { status: 'loading' });
  // The step a person is acting on, and what their last act answered.
  const [busyStep, setBusyStep] = useState<TenantHandoverStep | null>(null);
  const [actionFailed, setActionFailed] = useState<TenantHandoverStep | null>(null);
  const [codeError, setCodeError] = useState<'refused' | 'empty' | null>(null);
  const [code, setCode] = useState('');
  const seq = useRef(0);
  const busyRef = useRef(false);

  /** Apply an answer only when it is the latest call's. */
  const apply = useCallback((mine: number, answer: HandoverAnswer): HandoverAnswer => {
    if (mine !== seq.current) return answer;
    if (answer.ok) {
      setHandover(answer.handover);
      setLoad({ status: 'loaded' });
    }
    return answer;
  }, []);

  const read = useCallback(
    async (quiet: boolean) => {
      const mine = ++seq.current;
      if (!quiet) setLoad({ status: 'loading' });
      const answer = apply(mine, await awsHandoverClient.status(organizationId, tenantAccountId));
      // A quiet re-read that fails leaves the last checklist standing.
      if (!answer.ok && !quiet && mine === seq.current) setLoad({ status: 'failed' });
    },
    [apply, organizationId, tenantAccountId],
  );

  // With no seed, the first read happens on mount. `load` already starts at
  // loading, so nothing is set until the answer arrives.
  useEffect(() => {
    if (initial) return;
    const mine = ++seq.current;
    void awsHandoverClient.status(organizationId, tenantAccountId).then((answer) => {
      apply(mine, answer);
      if (!answer.ok && mine === seq.current) setLoad({ status: 'failed' });
    });
    // Mount only: the checklist is seeded once, then owned here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const moving = handoverInMotion(handover);
  useEffect(() => {
    if (!moving) return;
    const id = setInterval(() => {
      if (busyRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void read(true);
    }, HANDOVER_POLL_MS);
    return () => clearInterval(id);
  }, [moving, read]);

  /** One person's act on one step; its answer is applied in place. */
  const act = async (
    step: TenantHandoverStep,
    run: () => Promise<HandoverAnswer>,
  ): Promise<HandoverAnswer> => {
    const mine = ++seq.current;
    busyRef.current = true;
    setBusyStep(step);
    setActionFailed(null);
    const answer = apply(mine, await run());
    busyRef.current = false;
    setBusyStep(null);
    if (!answer.ok && mine === seq.current && answer.code !== 'HANDOVER_EMAIL_CODE_REFUSED') {
      setActionFailed(step);
      // The step may have moved under the click (409): read what is true now.
      void read(true);
    }
    return answer;
  };

  const onRetry = (step: TenantHandoverStep) =>
    void act(step, () => awsHandoverClient.retry(organizationId, tenantAccountId));

  const onRecheck = (step: TenantHandoverStep) =>
    void act(step, () => awsHandoverClient.recheck(organizationId, tenantAccountId));

  const onConfirmCode = async () => {
    const trimmed = code.trim();
    if (!trimmed) {
      setCodeError('empty');
      return;
    }
    setCodeError(null);
    const answer = await act('move_email', () =>
      awsHandoverClient.emailCode(organizationId, tenantAccountId, trimmed),
    );
    if (answer.ok) setCode('');
    else if (answer.code === 'HANDOVER_EMAIL_CODE_REFUSED') setCodeError('refused');
  };

  const overall = handover ? overallOf(handover.steps) : null;
  const awsAccountId = handover?.awsAccountId ?? null;
  const showUpstreams =
    handover?.steps.some((s) => s.step === 'open_upstream' && s.status === 'done') ?? false;

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-labelledby={titleId}
        data-surface="card"
        className="flex flex-col gap-4 rounded-(--radius-card) border border-(--el-border) bg-(--el-card) p-(--spacing-card-padding)"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="font-mono text-[11px] font-semibold tracking-[0.06em] text-(--el-text-eyebrow) uppercase">
              {ta('checklistEyebrow')}
            </p>
            <h2 id={titleId} className="font-serif text-xl font-semibold text-(--el-text)">
              {ta('checklistTitle', { org: organizationName })}
            </h2>
            <p className="text-sm text-(--el-text-secondary)">
              {awsAccountId ? (
                <>
                  {ta('accountLabel')}{' '}
                  <span className="font-mono text-(--el-text-identifier)">
                    {formatAwsAccountId(awsAccountId)}
                  </span>
                  {' · '}
                </>
              ) : null}
              {ta('repositoryCount', { count: repositoryCount })}
            </p>
          </div>
          {overall ? <OverallPill overall={overall} /> : null}
        </div>

        {load.status === 'loading' && !handover ? (
          <div role="status" className="flex items-center gap-2 text-sm text-(--el-text-secondary)">
            <Spinner size="sm" aria-hidden />
            {ta('checklistLoading')}
          </div>
        ) : null}

        {load.status === 'failed' && !handover ? (
          <ErrorState
            title={ta('checklistError')}
            description={ta('checklistErrorBody')}
            retry={() => void read(false)}
            retryLabel={ta('tryAgain')}
          />
        ) : null}

        {handover ? (
          <ol
            aria-label={ta('stepsLabel')}
            className="flex flex-col overflow-hidden rounded-(--radius-card) border border-(--el-border)"
          >
            {handover.steps.map((row, index) => (
              <StepRow
                key={row.step}
                row={row}
                index={index}
                repositoryCount={repositoryCount}
                githubOwner={owner?.githubOwner ?? null}
              >
                {row.status === 'failed' ? (
                  <div className="flex flex-col gap-2">
                    <p role="alert" className="text-sm text-(--el-danger-surface-text)">
                      {row.lastError ?? ta('stepFailedUnknown')}
                    </p>
                    <ActionLine failed={actionFailed === row.step}>
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={busyStep === row.step}
                        disabled={busyStep !== null}
                        onClick={() => onRetry(row.step)}
                        leftIcon={<RefreshCw className="size-3.5 shrink-0" />}
                      >
                        {ta('retry')}
                      </Button>
                    </ActionLine>
                  </div>
                ) : null}

                {row.status === 'waiting_on_you' && row.step === 'move_email' ? (
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="w-48">
                        <Input
                          label={ta('codeLabel')}
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          value={code}
                          error={
                            codeError === 'refused'
                              ? ta('codeRefused')
                              : codeError === 'empty'
                                ? ta('codeEmpty')
                                : undefined
                          }
                          onChange={(e) => setCode(e.target.value)}
                        />
                      </div>
                      <Button
                        variant="primary"
                        loading={busyStep === 'move_email'}
                        disabled={busyStep !== null}
                        onClick={() => void onConfirmCode()}
                      >
                        {ta('confirmCode')}
                      </Button>
                    </div>
                    <p className="text-sm text-(--el-text-secondary)">
                      {codeError === 'refused'
                        ? owner
                          ? ta('codeRefusedHelp', { email: owner.ownerEmail })
                          : ta('codeRefusedHelpUnknown')
                        : owner
                          ? ta('codeHelp', { email: owner.ownerEmail })
                          : ta('codeHelpUnknown')}
                    </p>
                    {actionFailed === 'move_email' ? <ActionFailed /> : null}
                  </div>
                ) : null}

                {row.status === 'waiting_on_you' && row.step === 'await_standalone' ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-sm text-(--el-text)">
                      {owner
                        ? ta('standaloneIntro', { email: owner.ownerEmail })
                        : ta('standaloneIntroUnknown')}
                    </p>
                    <ul className="flex list-disc flex-col gap-0.5 pl-5 text-sm text-(--el-text-secondary)">
                      {STANDALONE_STEPS.map((key) => (
                        <li key={key}>{ta(`standalone.${key}`)}</li>
                      ))}
                    </ul>
                    <p className="text-sm text-(--el-text-secondary)">{ta('standaloneNote')}</p>
                    <MissingList missing={row.missing} />
                    <ActionLine failed={actionFailed === row.step}>
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={busyStep === row.step}
                        disabled={busyStep !== null}
                        onClick={() => onRecheck(row.step)}
                        leftIcon={<RefreshCw className="size-3.5 shrink-0" />}
                      >
                        {ta('checkAgain')}
                      </Button>
                      <a
                        href={AWS_SIGN_IN_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-sm font-medium text-(--el-link) hover:text-(--el-link-pressed)"
                      >
                        {ta('signIn')}
                        <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
                      </a>
                    </ActionLine>
                  </div>
                ) : null}

                {row.status === 'waiting_on_you' &&
                row.step !== 'await_standalone' &&
                RECHECKED.has(row.step) ? (
                  <div className="flex flex-col gap-2">
                    <MissingList missing={row.missing} />
                    <ActionLine failed={actionFailed === row.step}>
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={busyStep === row.step}
                        disabled={busyStep !== null}
                        onClick={() => onRecheck(row.step)}
                        leftIcon={<RefreshCw className="size-3.5 shrink-0" />}
                      >
                        {ta('checkAgain')}
                      </Button>
                    </ActionLine>
                  </div>
                ) : null}
              </StepRow>
            ))}
          </ol>
        ) : null}
      </section>

      {showUpstreams && handover ? (
        <AwsHandoverUpstreams
          applications={handover.applications}
          loading={load.status === 'loading'}
          failed={load.status === 'failed'}
          onRetry={() => void read(false)}
        />
      ) : null}
    </div>
  );
}

const STATUS_ICON: Record<TenantHandoverStepStatus, ReactNode> = {
  pending: <Circle className="size-5 shrink-0 text-(--el-icon-muted)" aria-hidden="true" />,
  running: <Spinner size="sm" aria-hidden />,
  waiting_on_you: <Hand className="size-5 shrink-0 text-(--el-warning)" aria-hidden="true" />,
  done: <CircleCheckBig className="size-5 shrink-0 text-(--el-success)" aria-hidden="true" />,
  failed: <TriangleAlert className="size-5 shrink-0 text-(--el-danger)" aria-hidden="true" />,
};

const ROW_FILL: Record<TenantHandoverStepStatus, string> = {
  pending: 'bg-(--el-card)',
  running: 'bg-(--el-notice-info-bg)',
  waiting_on_you: 'bg-(--el-warning-surface)',
  done: 'bg-(--el-card)',
  failed: 'bg-(--el-danger-surface)',
};

const STATUS_KEY: Record<TenantHandoverStepStatus, string> = {
  pending: 'pending',
  running: 'running',
  waiting_on_you: 'waitingOnYou',
  done: 'done',
  failed: 'failed',
};

/** One checklist row: the one shape, five treatments (panel 21). */
function StepRow({
  row,
  index,
  repositoryCount,
  githubOwner,
  children,
}: {
  row: TenantHandoverStepDto;
  index: number;
  repositoryCount: number;
  githubOwner: string | null;
  children: ReactNode;
}) {
  const ta = useTranslations('repositoryTakeover.awsHandover');
  const current = row.status === 'running' || row.status === 'waiting_on_you';
  const body =
    row.step === 'transfer_repositories'
      ? githubOwner
        ? ta('step.transfer_repositories.bodyOwner', { owner: githubOwner })
        : ta('step.transfer_repositories.body')
      : ta(`step.${row.step}.body`, { count: repositoryCount });
  return (
    <li
      data-step={row.step}
      data-step-status={row.status}
      aria-current={current ? 'step' : undefined}
      className={`flex gap-3 border-t border-(--el-border-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-12) first:border-t-0 ${ROW_FILL[row.status]}`}
    >
      <span className="inline-flex size-5 items-center justify-center pt-0.5">
        {STATUS_ICON[row.status]}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-sm font-semibold text-(--el-text)">
            <span className="font-mono text-xs text-(--el-text-secondary)">{index + 1}. </span>
            {ta(`step.${row.step}.label`)}
          </p>
          <span
            role={row.status === 'running' ? 'status' : undefined}
            className={`text-xs font-semibold ${
              row.status === 'failed'
                ? 'text-(--el-danger-surface-text)'
                : 'text-(--el-text-strong)'
            }`}
          >
            {ta(`status.${STATUS_KEY[row.status]}`)}
          </span>
        </div>
        <p className="text-sm text-(--el-text-secondary)">{body}</p>
        {children}
      </div>
    </li>
  );
}

function OverallPill({ overall }: { overall: Overall }) {
  const ta = useTranslations('repositoryTakeover.awsHandover');
  const tone = {
    inProgress: 'bg-(--el-tint-sky)',
    waiting: 'bg-(--el-tint-peach)',
    failed: 'bg-(--el-tint-rose)',
    done: 'bg-(--el-tint-mint)',
  }[overall];
  const icon = {
    inProgress: <Spinner size="sm" aria-hidden />,
    waiting: <Hand className="h-3 w-3" aria-hidden="true" />,
    failed: <TriangleAlert className="h-3 w-3" aria-hidden="true" />,
    done: <CircleCheckBig className="h-3 w-3" aria-hidden="true" />,
  }[overall];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) border border-transparent px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs font-medium whitespace-nowrap text-(--el-text-strong) ${tone}`}
    >
      {icon}
      {ta(`overall.${overall}`)}
    </span>
  );
}

/** AWS's unmet requirements, from the step's `missing`, in plain words. */
function MissingList({ missing }: { missing: readonly string[] }) {
  const ta = useTranslations('repositoryTakeover.awsHandover');
  const known = missing.filter((m) => MISSING_KEYS.has(m));
  if (known.length === 0) return null;
  return (
    <div
      role="status"
      className="flex flex-col gap-1 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-card) p-(--spacing-card-padding-12) text-sm text-(--el-text)"
    >
      <p className="font-semibold">{ta('notReady')}</p>
      <ul className="flex list-disc flex-col gap-0.5 pl-5 text-(--el-text-secondary)">
        {known.map((m) => (
          <li key={m}>{ta(`missing.${m}`)}</li>
        ))}
      </ul>
    </div>
  );
}

function ActionLine({ failed, children }: { failed: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-3">{children}</div>
      {failed ? <ActionFailed /> : null}
    </div>
  );
}

function ActionFailed() {
  const ta = useTranslations('repositoryTakeover.awsHandover');
  return (
    <p role="alert" className="text-sm text-(--el-danger-on-surface)">
      {ta('actionFailed')}
    </p>
  );
}
