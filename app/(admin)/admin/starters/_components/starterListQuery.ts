import type {
  SeedRegistryConsoleFilter,
  SeedRegistryConsoleStatus,
  SeedRegistryConsoleTarget,
} from '@/lib/dto/seedRegistry';
import type { ProjectRepoRoleDto } from '@/lib/dto/projectRepos';
import { HOSTING_TARGETS } from '@/lib/hosting/vocabulary';
import { PROJECT_REPO_ROLES } from '@/lib/projectRepos/vocabulary';

/**
 * The starter library's URL ↔ filter model (MOTIR-712, design `starter-library`
 * §2.3). A plain module, not a client file, for the same reason as the Ideas
 * list's: the server page reads it to build the service filter, and the client
 * filter bar reads it to build the next URL.
 *
 * `?role=&status=active|retired|all&target=serverless|fly|aws|none&page=&promoted=`
 *  - `status` ABSENT is Active, the default, and the default is never written;
 *  - an unknown `role` / `target` / `status` / `page` is dropped, so a hand-edited
 *    URL reads as "no such filter" rather than an error state;
 *  - any filter change drops `page` (and `promoted`, the one-visit highlight).
 */

export type StarterSearchParams = Record<string, string | string[] | undefined>;

export interface StarterListView {
  role?: ProjectRepoRoleDto;
  status: SeedRegistryConsoleStatus;
  target?: SeedRegistryConsoleTarget;
  page: number;
  /** The key of the entry promoted just now — tinted for this visit (§3.5). */
  promoted?: string;
}

export const STARTER_FILTER_KEYS = ['role', 'status', 'target'] as const;
export type StarterFilterKey = (typeof STARTER_FILTER_KEYS)[number];

export const STARTER_TARGET_NONE = 'none' as const;

function one(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = v?.trim();
  return trimmed ? trimmed : undefined;
}

function isRole(value: string): value is ProjectRepoRoleDto {
  return (PROJECT_REPO_ROLES as readonly string[]).includes(value);
}

function isTarget(value: string): value is SeedRegistryConsoleTarget {
  return value === STARTER_TARGET_NONE || (HOSTING_TARGETS as readonly string[]).includes(value);
}

/** Read the view from a page's `searchParams`, dropping every value the library does not know. */
export function readStarterListView(params: StarterSearchParams): StarterListView {
  const role = one(params['role']);
  const status = one(params['status']);
  const target = one(params['target']);
  const page = Number(one(params['page']));
  const promoted = one(params['promoted']);
  return {
    status: status === 'retired' || status === 'all' ? status : 'active',
    page: Number.isInteger(page) && page > 1 ? page : 1,
    ...(role && isRole(role) ? { role } : {}),
    ...(target && isTarget(target) ? { target } : {}),
    ...(promoted ? { promoted } : {}),
  };
}

/** The service filter a view asks for. */
export function toStarterConsoleFilter(view: StarterListView): SeedRegistryConsoleFilter {
  return {
    status: view.status,
    ...(view.role ? { role: view.role } : {}),
    ...(view.target ? { target: view.target } : {}),
  };
}

/** Whether the view narrows the default (Active, every role, every target). */
export function isFilteredStarterView(view: StarterListView): boolean {
  return view.status !== 'active' || view.role !== undefined || view.target !== undefined;
}

/** The library URL for a view; the defaults are left out. */
export function starterListHref(view: Partial<StarterListView>): string {
  const params = new URLSearchParams();
  if (view.role) params.set('role', view.role);
  if (view.status && view.status !== 'active') params.set('status', view.status);
  if (view.target) params.set('target', view.target);
  if (view.page && view.page > 1) params.set('page', String(view.page));
  if (view.promoted) params.set('promoted', view.promoted);
  const query = params.toString();
  return query ? `/admin/starters?${query}` : '/admin/starters';
}

/** The view with one filter changed; the page and the highlight start over. */
export function withStarterFilter<K extends StarterFilterKey>(
  view: StarterListView,
  key: K,
  value: StarterListView[K] | undefined,
): StarterListView {
  const { page: _page, promoted: _promoted, ...rest } = view;
  const next: StarterListView = { ...rest, page: 1 };
  if (value === undefined) {
    if (key === 'status') next.status = 'active';
    else delete next[key];
  } else {
    (next as unknown as Record<string, unknown>)[key] = value;
  }
  return next;
}
