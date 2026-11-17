'use client';

import { useTranslations } from 'next-intl';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';

/**
 * The COMMAND — design MOTIR-11470 § Elements: the copyable
 * `motir check planner finding <id>` line, mono on the soft surface at control
 * radius, with a Copy button beside it. The page draws it on an OPEN record only.
 * Copying writes nothing; the verdict is given from the coding agent.
 */
export function RecordCommand({ recordId }: { recordId: string }) {
  const t = useTranslations('platformAdmin.plannerFindings.record.command');
  const { toast } = useToast();
  const command = t('line', { id: recordId });

  async function copy() {
    await navigator.clipboard.writeText(command);
    toast({ variant: 'success', title: t('copied') });
  }

  return (
    <div data-testid="record-command" className="flex flex-col gap-2 font-sans">
      <p className="text-xs text-(--el-text-secondary)">{t('intro')}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 rounded-(--radius-control) border border-(--el-border) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y) font-mono text-xs break-all text-(--el-text)">
          {command}
        </code>
        <Button
          size="sm"
          variant="secondary"
          aria-label={t('copyLabel')}
          leftIcon={<Copy aria-hidden className="h-3.5 w-3.5" />}
          onClick={copy}
        >
          {t('copy')}
        </Button>
      </div>
    </div>
  );
}
