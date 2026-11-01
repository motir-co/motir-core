import type { ProjectRepoDto } from '@/lib/dto/projectRepos';
import { isOrganizationSeedSource } from '@/lib/projectRepos/vocabulary';

// Which of a project's repositories the Environment room offers (Story MOTIR-9795 ·
// MOTIR-9966). Motir keeps an environment only for a repository it hosts; a
// customer repository (the organisation's own) is never offered, and a project
// holding only customer repositories has no Environment room at all.

/** The project's repositories Motir hosts, in set order. */
export function motirRepositories<T extends Pick<ProjectRepoDto, 'seedSource'>>(rows: T[]): T[] {
  return rows.filter((row) => !isOrganizationSeedSource(row.seedSource));
}

/** Whether the project holds at least one repository Motir hosts. */
export function hasMotirRepository(rows: Pick<ProjectRepoDto, 'seedSource'>[]): boolean {
  return motirRepositories(rows).length > 0;
}
