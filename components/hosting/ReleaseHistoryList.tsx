'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import type { HostedReleaseDto } from '@/lib/dto/hostedApplications';
import { releaseStateLabel } from '@/lib/hosting/releaseStateLabel';
import {
  CommitLabel,
  CommitSubject,
  ReleaseFailureReason,
  ReleaseStatePill,
  ReleaseTime,
  ReleaseTriggerLine,
} from '@/components/hosting/releaseParts';

// The RELEASE HISTORY LIST (Story MOTIR-9797 · MOTIR-10037, design MOTIR-10024
// panels 3–7): newest first, one row per release — commit, time, trigger, state
// pill; the address only on the live row, because nothing else is serving; a
// failed row's one-line reason. A page at a time behind Show more releases, never
// an unbounded list: the panel owns the pages, this draws what it is handed.

export function ReleaseHistoryList({
  releases,
  address,
  hasMore,
  loadingMore,
  moreFailed,
  onShowMore,
}: {
  releases: HostedReleaseDto[];
  address: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  moreFailed: boolean;
  onShowMore: () => void;
}) {
  const t = useTranslations('settings.production');
  const headingId = useId();
  return (
    <Card data-testid="production-release-history">
      <section aria-labelledby={headingId} className="flex flex-col gap-2">
        <h2 id={headingId} className="font-serif text-lg font-semibold text-(--el-text)">
          {t('history.heading')}
        </h2>
        <ol className="flex flex-col">
          {releases.map((release) => (
            <ReleaseRow key={release.id} release={release} address={address} />
          ))}
        </ol>
        {moreFailed ? (
          <p role="alert" className="font-sans text-sm text-(--el-text-secondary)">
            {t('history.moreError')}
          </p>
        ) : null}
        {hasMore ? (
          <div className="pt-1">
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<ChevronDown className="size-3.5" aria-hidden />}
              loading={loadingMore}
              onClick={onShowMore}
              data-testid="production-show-more"
            >
              {t('history.more')}
            </Button>
          </div>
        ) : null}
      </section>
    </Card>
  );
}

function ReleaseRow({ release, address }: { release: HostedReleaseDto; address: string | null }) {
  const word = releaseStateLabel(release.state).word;
  return (
    <li
      className="flex flex-col gap-1 border-b border-(--el-border-soft) py-(--spacing-control-y-8)"
      data-testid="production-release-row"
      data-state={word}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-baseline gap-2">
          <CommitLabel sha={release.commitSha} />
          <CommitSubject subject={release.commitSubject} />
        </span>
        <ReleaseStatePill release={release} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <ReleaseTime release={release} />
        <ReleaseTriggerLine release={release} />
        {word === 'live' && address ? (
          <span className="font-mono text-xs text-(--el-text-secondary)">{address}</span>
        ) : null}
      </div>
      <ReleaseFailureReason release={release} />
    </li>
  );
}
