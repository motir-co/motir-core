import type {
  EnvironmentConfigActionName,
  EnvironmentName,
} from '@/lib/environmentConfig/vocabulary';

// The environment-configuration DTOs (Story MOTIR-9795 · MOTIR-9961). Built so a
// SECRET value cannot be expressed: an entry's `value` is null whenever
// `isSecret` is true, and a change carries no value field at all.

/** One entry as every reader sees it. A secret shows only that it is set. */
export interface EnvironmentEntryDto {
  name: string;
  isSecret: boolean;
  /** The plain value; ALWAYS null for a secret. */
  value: string | null;
  updatedAt: string;
}

/** What `environmentConfigService.set` did: added the name, or replaced it. */
export interface SetEnvironmentEntryResultDto {
  outcome: 'created' | 'replaced';
  entry: EnvironmentEntryDto;
}

/** One recorded change — who did what to which name, never the value. */
export interface EnvironmentChangeDto {
  id: string;
  environment: EnvironmentName;
  name: string;
  action: EnvironmentConfigActionName;
  isSecret: boolean;
  actorId: string | null;
  createdAt: string;
}
