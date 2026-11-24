'use client';

import { useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Info, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Segmented } from '@/components/ui/Segmented';
import { Spinner } from '@/components/ui/Spinner';
import type { IdlePolicyDto } from '@/lib/dto/idlePolicy';
import type { HostedIdleMode } from '@/lib/hosting/idlePolicy';
import {
  productionPanelClient,
  type IdlePolicyRefusalKey,
} from '@/lib/hosting/productionPanelClient';

// The IDLE POLICY CONTROL — "When idle" (Story MOTIR-9799 · MOTIR-12110;
// `design/hosting/design-notes.md` panels 13–18, 20, 22): Suspend when idle or
// Always on, read from the idle-policy route. The route decides who may change it
// (`editable`) and which mode the target refuses (`refusal`); this control
// computes neither, and derives no default of its own.
//
// PAGE STATE AFTER THE MUTATION: busy until the route answers, no optimistic
// flip. The answer is the confirmation — the control replaces its state from it.
// One sequence counter, so a late answer never lands over a newer switch.

const OPTION_KEY: Record<HostedIdleMode, 'idle.option.suspend' | 'idle.option.alwaysOn'> = {
  suspend: 'idle.option.suspend',
  always_on: 'idle.option.alwaysOn',
};
const HELP_KEY: Record<HostedIdleMode, 'idle.help.suspend' | 'idle.help.alwaysOn'> = {
  suspend: 'idle.help.suspend',
  always_on: 'idle.help.alwaysOn',
};
const MODES: HostedIdleMode[] = ['suspend', 'always_on'];

export type IdlePolicyView =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; idle: IdlePolicyDto };

function Note({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) font-sans text-sm text-(--el-text)"
      data-testid={testId}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

export function IdlePolicyControl({
  projectKey,
  repositoryId,
  view,
  onView,
  onRetry,
  hasRelease,
  creditsExhausted,
}: {
  projectKey: string;
  repositoryId: string;
  view: IdlePolicyView;
  /** The panel holds the read; a switch's answer replaces it. */
  onView: (view: IdlePolicyView) => void;
  onRetry: () => void;
  hasRelease: boolean;
  /** The organisation's balance is below zero (the usage read says so). */
  creditsExhausted: boolean;
}) {
  const t = useTranslations('settings.production');
  const tTarget = useTranslations('repositorySet.seed.target');
  const [pending, setPending] = useState<HostedIdleMode | null>(null);
  const [refusalKey, setRefusalKey] = useState<IdlePolicyRefusalKey | null>(null);
  const seq = useRef(0);

  const idle = view.kind === 'ready' ? view.idle : null;
  const stored: HostedIdleMode = idle?.policy?.mode ?? 'suspend';
  const shown = pending ?? stored;

  const choose = async (mode: HostedIdleMode) => {
    if (!idle?.editable || mode === stored || pending) return;
    const mine = ++seq.current;
    setPending(mode);
    setRefusalKey(null);
    const result = await productionPanelClient.setIdlePolicy(projectKey, repositoryId, { mode });
    if (mine !== seq.current) return;
    setPending(null);
    if (!result.ok) {
      setRefusalKey(result.refusalKey);
      return;
    }
    onView({ kind: 'ready', idle: result.data });
  };

  const unsupported = idle?.refusal ?? null;
  // Always on is refused while the balance is below zero (Decision MOTIR-12100
  // §9); a policy already always on stays as it is.
  const alwaysOnRefused = creditsExhausted && stored === 'suspend';
  const options = MODES.map((mode) => ({
    value: mode,
    label: t(OPTION_KEY[mode]),
    disabled:
      (unsupported !== null && unsupported.mode === mode) ||
      (mode === 'always_on' && alwaysOnRefused),
  }));

  return (
    <Card data-testid="production-idle-policy">
      <section className="flex flex-col gap-3" aria-labelledby="production-idle-heading">
        <h2
          id="production-idle-heading"
          className="font-serif text-lg font-semibold text-(--el-text)"
        >
          {t('idle.heading')}
        </h2>

        {view.kind === 'loading' ? (
          <span
            aria-busy="true"
            className="flex items-center gap-2 font-sans text-sm text-(--el-text-secondary)"
          >
            <Spinner size="sm" aria-hidden />
            {t('idle.loading')}
          </span>
        ) : null}

        {view.kind === 'failed' ? (
          <div role="alert" className="flex flex-col items-start gap-2">
            <p className="font-sans text-sm text-(--el-text)">{t('idle.loadError')}</p>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<RotateCcw className="size-3.5" aria-hidden />}
              onClick={onRetry}
            >
              {t('retry')}
            </Button>
          </div>
        ) : null}

        {idle && !idle.editable ? (
          <div className="flex flex-col gap-1" data-testid="production-idle-read-only">
            <p className="font-sans text-sm font-medium text-(--el-text)">
              {t(OPTION_KEY[stored])}
            </p>
            <p className="font-sans text-sm text-(--el-text-secondary)">{t(HELP_KEY[stored])}</p>
            {idle.policy ? (
              <p className="font-sans text-xs text-(--el-text-secondary)">{t('idle.readOnly')}</p>
            ) : null}
          </div>
        ) : null}

        {idle?.editable ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Segmented
                label={t('idle.heading')}
                options={options}
                value={shown}
                onChange={(mode) => void choose(mode)}
                disabled={pending !== null}
              />
              {pending ? (
                <span
                  role="status"
                  className="flex items-center gap-2 font-sans text-sm text-(--el-text-secondary)"
                >
                  <Spinner size="sm" aria-hidden />
                  {t('idle.switching')}
                </span>
              ) : null}
            </div>
            <p className="font-sans text-sm text-(--el-text-secondary)">{t(HELP_KEY[shown])}</p>
            {pending ? (
              <p className="font-sans text-xs text-(--el-text-secondary)">
                {t('idle.switchingNote')}
              </p>
            ) : null}
          </>
        ) : null}

        {idle && !hasRelease ? (
          <p className="flex items-center gap-1.5 font-sans text-xs text-(--el-text-secondary)">
            <Info className="size-3.5 shrink-0" aria-hidden />
            {t('idle.default')}
          </p>
        ) : null}

        {unsupported ? (
          <Note testId="production-idle-unsupported">
            {`${t('idle.refusal.unsupported', {
              target: tTarget(unsupported.target),
              shape: t(`idle.shape.${unsupported.shape ?? 'container'}`),
            })} ${t('idle.refusal.unsupportedKeeps')}`}
          </Note>
        ) : null}

        {idle?.editable && alwaysOnRefused && refusalKey !== 'idle.refusal.credits' ? (
          <Note testId="production-idle-credits">{t('idle.refusal.credits')}</Note>
        ) : null}

        {refusalKey ? <Note testId="production-idle-refused">{t(refusalKey)}</Note> : null}
      </section>
    </Card>
  );
}
