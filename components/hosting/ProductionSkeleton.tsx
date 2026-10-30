import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/Spinner';

// The Production panel's LOADING state (Story MOTIR-9797 · MOTIR-10037, design
// MOTIR-10024 panel 14) — the in-page `<Suspense>` fallback, streamed only AFTER
// the page's own gate settled the status (no `loading.tsx` above the segment): a
// spinner line, a skeleton of the current release card and three history bars.

const BAR = 'rounded-(--radius-control) bg-(--el-muted)';

export function ProductionSkeleton() {
  const t = useTranslations('settings.production');
  return (
    <div aria-busy="true" className="flex flex-col gap-4" data-testid="production-loading">
      <span className="flex items-center gap-2 font-sans text-sm text-(--el-text-secondary)">
        <Spinner size="sm" aria-label={t('loading')} />
        {t('loading')}
      </span>
      <Card>
        <div className="flex flex-col gap-3" aria-hidden>
          <span className={`h-5 w-2/3 ${BAR}`} />
          <span className={`h-4 w-1/3 ${BAR}`} />
          <span className={`h-4 w-1/2 ${BAR}`} />
        </div>
      </Card>
      <Card>
        <div className="flex flex-col gap-3" aria-hidden>
          <span className={`h-6 w-full ${BAR}`} />
          <span className={`h-6 w-full ${BAR}`} />
          <span className={`h-6 w-full ${BAR}`} />
        </div>
      </Card>
    </div>
  );
}
