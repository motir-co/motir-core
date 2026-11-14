import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';

// The Public address door in the one-workspace fold-in (Story MOTIR-4528 ·
// MOTIR-9514; `design/workspace-address/workspace-address.mock.html` panel 0).
// Below the reveal the workspace rail is not taught, so the org page carries a
// DOOR to `/settings/workspace/public-address`, which — like the Roles room —
// answers at every workspace count, so the door always lands.

export function PublicAddressDoorCard({
  hostname,
  eligible = true,
}: {
  hostname: string | null;
  /**
   * `getClaimEligibility`'s answer (MOTIR-11287). With no name and no Motir
   * repository the link names the reason page rather than inviting a claim the
   * pane would refuse.
   */
  eligible?: boolean;
}) {
  const t = useTranslations('settings.workspaceAddress');
  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-sans text-base font-semibold text-(--el-text)">{t('door.title')}</h2>
          <p className="font-sans text-xs break-words text-(--el-text-secondary)">
            {hostname ? t('door.claimed', { host: hostname }) : t('door.none')}
          </p>
        </div>
        <Link
          href="/settings/workspace/public-address"
          className="inline-flex shrink-0 items-center font-sans text-sm font-medium text-(--el-link) hover:underline"
        >
          {hostname ? t('door.manage') : eligible ? t('door.claim') : t('door.whyNone')}
        </Link>
      </div>
    </Card>
  );
}
