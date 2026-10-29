'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Segmented } from '@/components/ui/Segmented';
import type { ProjectRepoRoleDto } from '@/lib/dto/projectRepos';
import type { SeedRegistryConsoleStatus, SeedRegistryConsoleTarget } from '@/lib/dto/seedRegistry';
import { HOSTING_TARGETS } from '@/lib/hosting/vocabulary';
import { PROJECT_REPO_ROLES } from '@/lib/projectRepos/vocabulary';
import {
  STARTER_TARGET_NONE,
  starterListHref,
  withStarterFilter,
  type StarterFilterKey,
  type StarterListView,
} from './starterListQuery';

/**
 * The library's FILTER BAR — design `starter-library` §2.3. Every filter lives in
 * the URL, because the server answers a filter change with a different page of
 * the registry, so each change is a `router.push` that starts the pager over.
 * Role and hosting target are `Combobox` triggers; status is a `Segmented`
 * (Active · Retired · All, default Active).
 */

const ANY = '';

export function StarterFilters({ view }: { view: StarterListView }) {
  const t = useTranslations('platformAdmin.starters');
  const ts = useTranslations('repositorySet.seed');
  const router = useRouter();

  function go<K extends StarterFilterKey>(key: K, value: StarterListView[K] | undefined) {
    router.push(starterListHref(withStarterFilter(view, key, value)));
  }

  const roleOptions: ComboboxOption<string>[] = [
    { value: ANY, label: t('filter.anyRole') },
    ...PROJECT_REPO_ROLES.map((role) => ({ value: role, label: role })),
  ];
  const targetOptions: ComboboxOption<string>[] = [
    { value: ANY, label: t('filter.anyTarget') },
    ...HOSTING_TARGETS.map((target) => ({ value: target, label: ts(`target.${target}`) })),
    { value: STARTER_TARGET_NONE, label: t('notDeployed') },
  ];

  return (
    <div
      role="search"
      aria-label={t('filter.label')}
      data-testid="starter-filters"
      className="flex flex-wrap items-end gap-2"
    >
      <Filter
        label={t('filter.role')}
        options={roleOptions}
        value={view.role}
        onPick={(v) => go('role', (v || undefined) as ProjectRepoRoleDto | undefined)}
      />
      <div className="flex flex-col gap-1">
        <span className="font-sans text-xs font-medium text-(--el-text-secondary)">
          {t('filter.status')}
        </span>
        <Segmented<SeedRegistryConsoleStatus>
          label={t('filter.status')}
          value={view.status}
          onChange={(value) => go('status', value)}
          options={[
            { value: 'active', label: t('status.active') },
            { value: 'retired', label: t('status.retired') },
            { value: 'all', label: t('filter.all') },
          ]}
        />
      </div>
      <Filter
        label={t('filter.target')}
        options={targetOptions}
        value={view.target}
        onPick={(v) => go('target', (v || undefined) as SeedRegistryConsoleTarget | undefined)}
        wide
      />
    </div>
  );
}

function Filter({
  label,
  options,
  value,
  onPick,
  wide,
}: {
  label: string;
  options: ComboboxOption<string>[];
  value: string | undefined;
  onPick: (value: string) => void;
  wide?: boolean;
}) {
  return (
    <div className={`flex flex-col gap-1 ${wide ? 'w-64' : 'w-44'}`}>
      <span className="font-sans text-xs font-medium text-(--el-text-secondary)">{label}</span>
      <Combobox label={label} options={options} value={value ?? ANY} onChange={onPick} />
    </div>
  );
}
