'use client';

import { useId } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { FolderGit2 } from 'lucide-react';
import { Combobox } from '@/components/ui/Combobox';
import type { ProjectRepoRoleDto } from '@/lib/dto/projectRepos';
import { PRODUCTION_ROOM_HREF } from '@/lib/hosting/productionRoom';

// The Production room's REPOSITORY PICKER (Story MOTIR-9797 · MOTIR-10037, design
// MOTIR-10024 panel 1) — the Environment room's single-select, listing only the
// project's Motir repositories (the page never hands it a customer one). Choosing
// one NAVIGATES to `?repository=<rowId>`, so the server reads and gates that
// repository's panel and a link reopens the same view.

export interface ProductionRepositoryOption {
  id: string;
  name: string;
  role: ProjectRepoRoleDto;
  label: string | null;
}

export function ProductionRepositoryPicker({
  repositories,
  selectedId,
}: {
  repositories: ProductionRepositoryOption[];
  selectedId: string;
}) {
  const t = useTranslations('settings.production');
  const router = useRouter();
  const labelId = useId();
  const options = repositories.map((repo) => ({
    value: repo.id,
    label: repo.name,
    secondary: repo.label ?? t(`role.${repo.role}`),
  }));
  return (
    <div className="flex flex-col gap-1" data-testid="production-repository-picker">
      <span id={labelId} className="font-sans text-sm font-medium text-(--el-text)">
        {t('repositoryLabel')}
      </span>
      <div className="w-72" aria-labelledby={labelId}>
        <Combobox
          options={options}
          value={selectedId}
          onChange={(next) => {
            if (next === selectedId) return;
            router.push(`${PRODUCTION_ROOM_HREF}?repository=${encodeURIComponent(next)}`);
          }}
          label={t('repositoryLabel')}
          triggerIcon={<FolderGit2 className="size-4" aria-hidden />}
        />
      </div>
    </div>
  );
}
