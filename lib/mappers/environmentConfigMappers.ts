import type { EnvironmentConfigChange, EnvironmentConfigEntry } from '@/generated/prisma/client';
import type { EnvironmentChangeDto, EnvironmentEntryDto } from '@/lib/dto/environmentConfig';

// Row → DTO for a Motir repository's environment configuration (MOTIR-9961). The
// one rule that matters: a secret's `value` is nulled HERE, whatever the row
// holds, so neither its plain value nor its ciphertext reaches a caller.

export function toEnvironmentEntryDto(row: EnvironmentConfigEntry): EnvironmentEntryDto {
  return {
    name: row.name,
    isSecret: row.isSecret,
    value: row.isSecret ? null : row.value,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** `names` maps actor ids to display names; an id it lacks reads as no name. */
export function toEnvironmentChangeDto(
  row: EnvironmentConfigChange,
  names: ReadonlyMap<string, string | null> = new Map(),
): EnvironmentChangeDto {
  return {
    id: row.id,
    environment: row.environment,
    name: row.name,
    action: row.action,
    isSecret: row.isSecret,
    actorId: row.actorId,
    actorName: row.actorId ? (names.get(row.actorId) ?? null) : null,
    createdAt: row.createdAt.toISOString(),
  };
}
