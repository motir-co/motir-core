'use client';

import { useTranslations } from 'next-intl';
import { CommandChip } from '@/components/ui/CommandChip';

// THE COMMAND CHIP for `motir review <KEY>` (Story MOTIR-10327 · MOTIR-10341;
// `design/github/design-notes.md` § 32.2, mock M9) — the shared `CommandChip`, with the
// review path's words: *Copy motir review {key}*, the in-place *Copied*, and the shipped
// success toast naming the command. Never on a board card (the card is one button).

export function ReviewCommand({ command, identifier }: { command: string; identifier: string }) {
  const t = useTranslations('approvalGate.reviewPath.command');
  return (
    <CommandChip
      command={command}
      copyLabel={t('copy', { key: identifier })}
      copiedLabel={t('copied')}
      toastTitle={t('toastTitle')}
      toastBody={t('toastBody', { command })}
      testId={`review-command-copy-${identifier}`}
    />
  );
}
