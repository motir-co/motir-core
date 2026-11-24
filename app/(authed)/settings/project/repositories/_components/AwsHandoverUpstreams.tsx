'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/ErrorState';
import { Spinner } from '@/components/ui/Spinner';
import type { TenantHandoverApplicationDto } from '@/lib/dto/tenantAccountHandover';

// THE UPSTREAM ADDRESSES LIST (Story MOTIR-9800 · MOTIR-12137 —
// design/repository-set/takeover--aws-handover.mock.html, panels 22–25).
//
// Where each app answers without Motir, and for each customer domain the address
// it must be pointed at — read from the handover's status, which carries them
// as `listCustomerDomainUpstreams` returns them. Nothing is computed here: an
// app whose upstream is not open yet says so rather than guessing one.
//
// The list sits below the checklist from `Apps reachable without Motir` on. Its
// error state is its own: a failed re-read leaves the checklist above as it was.

export interface AwsHandoverUpstreamsProps {
  applications: readonly TenantHandoverApplicationDto[];
  loading?: boolean;
  failed?: boolean;
  onRetry: () => void;
}

export function AwsHandoverUpstreams({
  applications,
  loading = false,
  failed = false,
  onRetry,
}: AwsHandoverUpstreamsProps) {
  const ta = useTranslations('repositoryTakeover.awsHandover');

  return (
    <section
      aria-labelledby="aws-handover-upstreams"
      className="flex flex-col gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-card) p-(--spacing-card-padding)"
    >
      <div className="flex flex-col gap-1">
        <h3 id="aws-handover-upstreams" className="text-base font-semibold text-(--el-text)">
          {ta('upstreamsTitle')}
        </h3>
        <p className="text-sm text-(--el-text-secondary)">{ta('upstreamsLead')}</p>
      </div>

      {failed ? (
        <ErrorState
          title={ta('upstreamsError')}
          description={ta('upstreamsErrorBody')}
          retry={onRetry}
          retryLabel={ta('tryAgain')}
        />
      ) : loading ? (
        <div role="status" className="flex items-center gap-2 text-sm text-(--el-text-secondary)">
          <Spinner size="sm" aria-hidden />
          {ta('upstreamsLoading')}
        </div>
      ) : applications.length === 0 ? (
        <p className="text-sm text-(--el-text-secondary)">{ta('upstreamsEmpty')}</p>
      ) : (
        <ul className="flex flex-col overflow-hidden rounded-(--radius-card) border border-(--el-border)">
          {applications.map((app) => (
            <li
              key={app.applicationId}
              className="flex flex-col gap-2 border-t border-(--el-border-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-12) first:border-t-0"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-semibold text-(--el-text)">{app.slug}</span>
                  <span className="text-xs text-(--el-text-secondary)">{ta('ownAddress')}</span>
                  {app.upstreamAddress ? (
                    <span className="font-mono text-sm break-all text-(--el-text-identifier)">
                      {app.upstreamAddress}
                    </span>
                  ) : (
                    <span className="text-sm text-(--el-text-secondary)">
                      {ta('upstreamNotOpen')}
                    </span>
                  )}
                </div>
                {app.upstreamAddress ? (
                  <CopyButton
                    value={app.upstreamAddress}
                    label={ta('copyOwnLabel', { app: app.slug })}
                  />
                ) : null}
              </div>

              {app.customerDomains.length === 0 ? (
                <p className="text-sm text-(--el-text-secondary)">{ta('noDomains')}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {app.customerDomains.map((domain) => {
                    const target = domain.upstreamAddress ?? app.upstreamAddress;
                    return (
                      <li
                        key={domain.host}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-(--radius-control) bg-(--el-surface-soft) px-(--spacing-control-x-8) py-(--spacing-control-y-4)"
                      >
                        <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                          <span className="font-mono break-all text-(--el-text)">
                            {domain.host}
                          </span>
                          <ArrowRight
                            className="size-3.5 shrink-0 text-(--el-icon-muted)"
                            role="img"
                            aria-label={ta('pointAt')}
                          />
                          <span className="font-mono break-all text-(--el-text-identifier)">
                            {target ?? ta('upstreamNotOpen')}
                          </span>
                        </span>
                        {target ? (
                          <CopyButton
                            value={target}
                            label={ta('copyDomainLabel', { host: domain.host })}
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Copy one address, and say so for a moment. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const ta = useTranslations('repositoryTakeover.awsHandover');
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2_000);
    } catch {
      // A browser that refuses the clipboard leaves the address on screen to
      // select by hand; nothing to report.
    }
  };
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={label}
      onClick={() => void onCopy()}
      leftIcon={
        copied ? (
          <Check className="size-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5 shrink-0" aria-hidden="true" />
        )
      }
    >
      {copied ? ta('copied') : ta('copy')}
    </Button>
  );
}
