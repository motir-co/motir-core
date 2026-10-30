import { useTranslations } from 'next-intl';
import { Rocket } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';

// The Production panel's EMPTY STATE (Story MOTIR-9797 · MOTIR-10037, design
// MOTIR-10024 panel 13): a Motir repository with nothing serving production yet.
// No address, no Roll back; the sentence names what starts the first release.

export function ProductionEmptyState() {
  const t = useTranslations('settings.production');
  return (
    <Card data-testid="production-empty-state">
      <EmptyState
        icon={<Rocket aria-hidden />}
        title={t('empty.title')}
        description={t('empty.body')}
      />
    </Card>
  );
}
