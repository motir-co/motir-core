import { useTranslations } from 'next-intl';
import { Pill } from '@/components/ui/Pill';

/**
 * The Workspace cell. A run or dead letter with no workspace shows the neutral
 * **No workspace** Pill and is never dropped. The read carries only the
 * workspace id, so the id shows in mono, as the design allows.
 */
export function WorkspaceCell({ workspaceId }: { workspaceId: string | null }) {
  const t = useTranslations('platformAdmin');
  if (workspaceId === null) return <Pill tone="neutral">{t('jobs.noWorkspace')}</Pill>;
  return (
    <span title={workspaceId} className="block max-w-[12rem] truncate font-mono text-xs">
      {workspaceId}
    </span>
  );
}
