'use client';

import { useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Info, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { isHandoverGithubOwner, isHandoverOwnerEmail } from '@/lib/hosting/handoverInput';
import type {
  TenantAccountHandoverDto,
  TenantHandoverRepositoryDto,
} from '@/lib/dto/tenantAccountHandover';
import { awsHandoverClient } from './awsHandoverClient';

// THE HANDOVER STEP (Story MOTIR-9800 · MOTIR-12137 —
// design/repository-set/takeover--aws-handover.mock.html, panels 5–10).
//
// A two-step dialog: who owns the account next and where the repositories go
// (step 1), then what starting it means (step 2). Both fields are checked here
// BEFORE any request, by the same rule the service refuses a malformed start
// with (`lib/hosting/handoverInput.ts`), so the two cannot disagree.
//
// ⚠️ NO FIELD TAKES A PAYMENT DETAIL OR A ROOT CREDENTIAL. The only inputs are
// the owner email and the GitHub owner; AWS's own steps are done in AWS, and the
// note under the list says so in words.
//
// ⚠️ ONLY THE LATEST START IS APPLIED. Each press stamps a sequence; an answer
// that arrives after the dialog moved on (Back, or a second press) is dropped.

export interface AwsHandoverStepProps {
  organizationId: string;
  organizationName: string;
  /** Every AWS-target repository of the organisation, handed over together. */
  repositories: readonly TenantHandoverRepositoryDto[];
  onClose: () => void;
  /** The handover started: its checklist, and who it was handed to. */
  onStarted: (
    handover: TenantAccountHandoverDto,
    owner: { ownerEmail: string; githubOwner: string },
  ) => void;
}

type Refusal = 'notReady' | 'alreadyStarted' | 'githubIdentity' | 'input' | 'failed';

/** The start route's refusals, by code, as the step words them. */
function refusalOf(code: string | null): Refusal {
  switch (code) {
    case 'TENANT_ACCOUNT_NOT_READY':
      return 'notReady';
    case 'TENANT_HANDOVER_ALREADY_STARTED':
      return 'alreadyStarted';
    case 'GITHUB_IDENTITY_REQUIRED':
      return 'githubIdentity';
    case 'TENANT_HANDOVER_INPUT_INVALID':
      return 'input';
    default:
      return 'failed';
  }
}

export function AwsHandoverStep({
  organizationId,
  organizationName,
  repositories,
  onClose,
  onStarted,
}: AwsHandoverStepProps) {
  const ta = useTranslations('repositoryTakeover.awsHandover');
  const emailId = useId();
  const ownerId = useId();
  const [step, setStep] = useState<1 | 2>(1);
  const [ownerEmail, setOwnerEmail] = useState('');
  const [githubOwner, setGithubOwner] = useState('');
  const [errors, setErrors] = useState<{ ownerEmail?: string; githubOwner?: string }>({});
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const seq = useRef(0);

  const email = ownerEmail.trim();
  const owner = githubOwner.trim();
  const empty = repositories.length === 0;

  const onContinue = () => {
    const next: typeof errors = {};
    if (!isHandoverOwnerEmail(email)) next.ownerEmail = ta('ownerEmailInvalid');
    if (!isHandoverGithubOwner(owner)) next.githubOwner = ta('githubOwnerInvalid');
    setErrors(next);
    if (next.ownerEmail || next.githubOwner) return;
    setRefusal(null);
    setStep(2);
  };

  const onBack = () => {
    seq.current += 1;
    setRefusal(null);
    setStep(1);
  };

  const onStart = async () => {
    const mine = ++seq.current;
    setBusy(true);
    setRefusal(null);
    const answer = await awsHandoverClient.start(organizationId, {
      ownerEmail: email,
      githubOwner: owner,
    });
    if (mine !== seq.current) return;
    setBusy(false);
    if (answer.ok) {
      onStarted(answer.handover, { ownerEmail: email, githubOwner: owner });
      return;
    }
    setRefusal(refusalOf(answer.code));
  };

  const eyebrow = ta('stepEyebrow', { step });

  if (step === 2) {
    const title = ta('confirmTitle');
    return (
      <Modal
        open
        onOpenChange={(open) => (open || busy ? undefined : onClose())}
        srTitle={title}
        size="lg"
        role="alertdialog"
        hideClose={busy}
      >
        <Modal.Body className="gap-4" aria-busy={busy || undefined}>
          <div className="flex flex-col gap-1">
            <SectionLabel>{eyebrow}</SectionLabel>
            <h2 className="font-serif text-xl font-semibold text-(--el-text)">{title}</h2>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-(--el-text-secondary)">{ta('confirmNewOwner')}</dt>
            <dd className="min-w-0 font-medium break-all text-(--el-text)">{email}</dd>
            <dt className="text-(--el-text-secondary)">{ta('confirmRepositoriesGoTo')}</dt>
            <dd className="min-w-0 font-mono break-all text-(--el-text)">{owner}</dd>
          </dl>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm leading-relaxed text-(--el-text-secondary)">
            <li>{ta('consequencePreviews', { count: repositories.length })}</li>
            <li>{ta('consequenceRunning')}</li>
            <li>{ta('consequenceIrreversible')}</li>
          </ul>
          {refusal ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-danger-surface) p-(--spacing-card-padding) text-sm text-(--el-danger-surface-text)"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                {ta(`startRefused.${refusal}`, { org: organizationName })}
              </span>
            </p>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" disabled={busy} onClick={onBack}>
            {ta('back')}
          </Button>
          <Button variant="primary" loading={busy} disabled={busy} onClick={() => void onStart()}>
            {busy ? ta('starting') : ta('start')}
          </Button>
        </Modal.Footer>
      </Modal>
    );
  }

  const title = ta('stepTitle', { org: organizationName });
  return (
    <Modal open onOpenChange={(open) => (open ? undefined : onClose())} srTitle={title} size="lg">
      <Modal.Body className="gap-4">
        <div className="flex flex-col gap-1">
          <SectionLabel>{eyebrow}</SectionLabel>
          <h2 className="font-serif text-xl font-semibold text-(--el-text)">{title}</h2>
          <p className="text-sm leading-relaxed text-(--el-text-secondary)">{ta('stepLead')}</p>
        </div>

        <Input
          id={emailId}
          type="email"
          autoComplete="email"
          label={ta('ownerEmailLabel')}
          placeholder={ta('ownerEmailPlaceholder')}
          helperText={ta('ownerEmailHelp')}
          error={errors.ownerEmail}
          value={ownerEmail}
          onChange={(e) => setOwnerEmail(e.target.value)}
        />
        <Input
          id={ownerId}
          label={ta('githubOwnerLabel')}
          placeholder={ta('githubOwnerPlaceholder')}
          helperText={ta('githubOwnerHelp')}
          error={errors.githubOwner}
          value={githubOwner}
          onChange={(e) => setGithubOwner(e.target.value)}
        />

        <div className="flex flex-col gap-2">
          <SectionLabel>{ta('handedOverTogether')}</SectionLabel>
          {empty ? (
            <p className="text-sm text-(--el-text-secondary)">
              {ta('noAwsRepositories', { org: organizationName })}
            </p>
          ) : (
            <ul className="flex flex-col overflow-hidden rounded-(--radius-card) border border-(--el-border)">
              {repositories.map((repo) => (
                <li
                  key={repo.id}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 border-t border-(--el-border-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) first:border-t-0"
                >
                  <span className="min-w-0 font-mono text-sm break-all text-(--el-text)">
                    {repo.repoRef ?? repo.name}
                  </span>
                  <span className="text-xs text-(--el-text-secondary)">
                    {repo.projectName} · {repo.name}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex gap-3 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) p-(--spacing-card-padding)">
          <Info className="mt-0.5 size-4 shrink-0 text-(--el-info)" aria-hidden="true" />
          <p className="min-w-0 text-sm leading-relaxed text-(--el-text-secondary)">
            {ta('awsStepsNote')}
          </p>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {ta('cancel')}
        </Button>
        <Button variant="primary" disabled={empty} onClick={onContinue}>
          {ta('continue')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
