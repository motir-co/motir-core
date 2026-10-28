'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Copy, ExternalLink } from 'lucide-react';
import { useToast } from '@/components/ui/Toast';

// THE ADDRESS ROW (Story MOTIR-4528 · MOTIR-9514) — a host, an optional pill,
// Copy and open-in-a-new-tab. Shared by the workspace control and the project
// settings echo (MOTIR-9515), which the design draws as the same row without the
// pill, so the two cannot drift apart.
//
// At narrow widths the host WRAPS rather than truncating and the pill drops under
// it, while Copy and open stay on the row (`design/workspace-address` panel 12):
// on this row the host is the message, and a name a person cannot finish reading
// is one they cannot check.

export function AddressRow({
  host,
  url,
  pill,
}: {
  host: string;
  /** Where open-in-a-new-tab goes, and what Copy copies. */
  url: string;
  pill?: ReactNode;
}) {
  const t = useTranslations('settings.workspaceAddress');
  const { toast } = useToast();

  return (
    <div className="flex min-h-(--height-control) items-center gap-2 rounded-(--radius-control) border border-(--el-border) bg-(--el-surface-soft) px-(--spacing-control-x-12) py-(--spacing-control-y-8)">
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2">
        <span className="min-w-0 font-mono text-[13px] break-words text-(--el-text)">{host}</span>
        {pill}
      </div>
      <button
        type="button"
        aria-label={t('row.copy')}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(url)
            .then(() => toast({ variant: 'success', title: t('row.copied') }));
        }}
        className="inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text)"
      >
        <Copy className="h-4 w-4" aria-hidden />
      </button>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        aria-label={t('row.open')}
        className="inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text)"
      >
        <ExternalLink className="h-4 w-4" aria-hidden />
      </a>
    </div>
  );
}
