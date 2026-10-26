import { getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui/Card';

/**
 * The capacity page's LOADING frame (MOTIR-9614, design `platform-admin`
 * AMENDMENT 2026-10-25, Panel 10): the header is already painted above it, so
 * only the entries wait, as skeleton cards on a busy list. No number is drawn
 * until the first read answers.
 */
export async function CapacitySkeleton() {
  const t = await getTranslations('platformAdmin.capacity');
  return (
    <div aria-busy="true" aria-label={t('loading')} className="flex flex-col gap-4">
      {[0, 1].map((card) => (
        <Card key={card}>
          <div className="flex flex-col gap-3">
            {['w-[30%]', 'w-[55%]', 'w-full', 'w-full', 'w-[80%]'].map((width, i) => (
              <div key={i} className={`h-3 rounded-(--radius-control) bg-(--el-muted) ${width}`} />
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
