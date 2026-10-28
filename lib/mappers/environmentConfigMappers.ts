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

export function toEnvironmentChangeDto(row: EnvironmentConfigChange): EnvironmentChangeDto {
  return {
    id: row.id,
    environment: row.environment,
    name: row.name,
    action: row.action,
    isSecret: row.isSecret,
    actorId: row.actorId,
    createdAt: row.createdAt.toISOString(),
  };
}
