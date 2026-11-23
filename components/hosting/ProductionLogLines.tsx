'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import type { ProductionLogLineDto } from '@/lib/dto/productionLogs';
import { LONG_LINE_CHARS, maskSegments } from '@/lib/hosting/productionRuntimeWords';

// Log lines as the Production panel draws them (Story MOTIR-9799 · MOTIR-12109;
// `design/hosting/design-notes.md` § Width, second revision): a plain list, no
// scroll box. A line over 120 characters is collapsed to one line and opened by
// its arrow; a short line has no arrow. Each message is the route's own text,
// byte for byte — the route masks secrets, and the mask is only DRAWN as a token.

function LogMessage({ message, open }: { message: string; open: boolean }) {
  return (
    <span
      className={`min-w-0 font-mono text-xs text-(--el-text) ${open ? 'break-words whitespace-pre-wrap' : 'truncate'}`}
      data-testid="production-log-message"
    >
      {maskSegments(message).map((s, i) =>
        s.mask ? (
          <span
            key={i}
            className="rounded-(--radius-control) bg-(--el-tint-yellow) px-(--spacing-chip-x-2) text-(--el-text-strong)"
            data-testid="production-log-mask"
          >
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </span>
  );
}

function LogLineRow({ line, dense }: { line: ProductionLogLineDto; dense: boolean }) {
  const t = useTranslations('settings.production.logs');
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const long = line.message.length > LONG_LINE_CHARS;
  const at = new Date(line.at);
  const label = open ? t('line.collapse') : t('line.expand');
  return (
    <li
      className={`grid grid-cols-[1.5rem_4.5rem_4.75rem_minmax(0,1fr)] items-baseline gap-2 border-b border-(--el-border-soft) px-(--spacing-control-x-8) ${dense ? 'py-(--spacing-control-y-2)' : 'py-(--spacing-control-y-4)'} last:border-b-0`}
      data-testid="production-log-line"
      data-long={long ? 'true' : undefined}
    >
      <span className="flex justify-center self-start">
        {long ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={label}
            title={label}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex size-5 items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-muted) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            {open ? (
              <ChevronDown className="size-3.5" aria-hidden />
            ) : (
              <ChevronRight className="size-3.5" aria-hidden />
            )}
          </button>
        ) : null}
      </span>
      <time
        dateTime={line.at}
        title={format.dateTime(at, { dateStyle: 'medium', timeStyle: 'medium' })}
        className="font-mono text-xs text-(--el-text-secondary)"
      >
        {format.dateTime(at, { timeStyle: 'medium' })}
      </time>
      <span>
        <Pill tone={line.stream === 'platform' ? 'awaiting' : 'neutral'}>
          {t(`stream.${line.stream}`)}
        </Pill>
      </span>
      <LogMessage message={line.message} open={open || !long} />
    </li>
  );
}

export function ProductionLogLines({
  lines,
  dense = false,
}: {
  lines: ProductionLogLineDto[];
  dense?: boolean;
}) {
  const t = useTranslations('settings.production.logs');
  return (
    <div className="rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft)">
      <ol className="flex flex-col" aria-label={t('linesLabel')}>
        {lines.map((line, i) => (
          <LogLineRow key={`${line.at}-${i}`} line={line} dense={dense} />
        ))}
      </ol>
    </div>
  );
}
