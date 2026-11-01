import { useTranslations } from 'next-intl';
import { Info } from 'lucide-react';

/**
 * Read-only notice — for support (below operator) on the Dead letters tab, in
 * place of every replay control.
 */
export function ReadOnlyNotice() {
  const t = useTranslations('platformAdmin');
  return (
    <div
      role="note"
      className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-tint-sky) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) font-sans text-sm text-(--el-text-strong)"
    >
      <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <p>{t('jobs.readOnly')}</p>
    </div>
  );
}
