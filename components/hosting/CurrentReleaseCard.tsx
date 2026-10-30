'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Copy, ExternalLink, Info, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import type { HostedReleaseDto } from '@/lib/dto/hostedApplications';
import { PUBLIC_ADDRESS_HREF } from '@/lib/hosting/productionRoom';
import {
  CommitLabel,
  CommitSubject,
  ReleaseStatePill,
  ReleaseTime,
  ReleaseTriggerLine,
} from '@/components/hosting/releaseParts';

// The CURRENT RELEASE CARD (Story MOTIR-9797 · MOTIR-10037, design MOTIR-10024
// panels 3–7, 11, 17, 18): the release serving production, its address with a
// Copy control (or the no-address note), and — for an administrator only — the
// Roll back control. A member gets no control at all (absent, not disabled); an
// administrator with no earlier release gets it disabled with its reason.

/** How long Copy reads Copied (the design's two seconds). */
export const COPIED_MS = 2000;

export function CurrentReleaseCard({
  release,
  address,
  isAdministrator,
  canRollback,
  onRollback,
}: {
  release: HostedReleaseDto;
  /** The production host without scheme, or null before a label is claimed. */
  address: string | null;
  isAdministrator: boolean;
  canRollback: boolean;
  onRollback: () => void;
}) {
  const t = useTranslations('settings.production');
  return (
    <Card data-testid="production-current-release">
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="font-sans text-xs font-medium tracking-wide text-(--el-text-secondary) uppercase">
              {t('current.eyebrow')}
            </p>
            <span className="flex min-w-0 items-baseline gap-2">
              <CommitLabel sha={release.commitSha} />
              <CommitSubject subject={release.commitSubject} />
            </span>
          </div>
          <ReleaseStatePill release={release} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <ReleaseTime release={release} />
          <ReleaseTriggerLine release={release} />
          {address ? <ProductionAddress address={address} /> : null}
        </div>
        {address ? null : (
          <p
            className="flex items-center gap-1.5 font-sans text-sm text-(--el-text-secondary)"
            data-testid="production-no-address-note"
          >
            <Info className="size-4 shrink-0" aria-hidden />
            <span>
              {t.rich('address.none', {
                link: (chunks) => (
                  <Link href={PUBLIC_ADDRESS_HREF} className="text-(--el-link) underline">
                    {chunks}
                  </Link>
                ),
              })}
            </span>
          </p>
        )}
        {isAdministrator ? (
          <div className="flex flex-col gap-1 border-t border-(--el-border-soft) pt-3">
            <div className="flex items-center gap-3">
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<RotateCcw className="size-3.5" aria-hidden />}
                disabled={!canRollback}
                aria-describedby="production-rollback-helper"
                onClick={onRollback}
                data-testid="production-rollback"
              >
                {t('rollback.action')}
              </Button>
              <span
                id="production-rollback-helper"
                className="font-sans text-xs text-(--el-text-secondary)"
                data-testid="production-rollback-helper"
              >
                {canRollback ? t('rollback.helper') : t('rollback.unavailable')}
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/** The production address: a new-tab link, then Copy, which reads Copied for two
 *  seconds and says so through a polite live region (panel 18). */
function ProductionAddress({ address }: { address: string }) {
  const t = useTranslations('settings.production');
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      // The browser refused the clipboard; the address stays readable and
      // selectable beside the control, so there is nothing to announce.
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <span className="flex items-center gap-1">
      <a
        href={`https://${address}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 font-mono text-sm text-(--el-link) underline"
        data-testid="production-address"
      >
        {address}
        <ExternalLink className="size-3.5" aria-hidden />
        <span className="sr-only">{t('address.newTab')}</span>
      </a>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={<Copy className="size-3.5" aria-hidden />}
        aria-label={t('address.copyAria', { address })}
        onClick={copy}
        data-testid="production-copy-address"
      >
        {copied ? t('address.copied') : t('address.copy')}
      </Button>
      <span className="sr-only" aria-live="polite">
        {copied ? t('address.copied') : ''}
      </span>
    </span>
  );
}
