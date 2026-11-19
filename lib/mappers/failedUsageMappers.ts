import type { RawFailedUsageGroup, RawFailedUsageReplay } from '@/lib/ai/motirAiClient';
import type { FailedUsageGroupDTO, FailedUsageReplayDTO } from '@/lib/dto/failedUsage';

/** motir-ai's failed-usage group → the section's DTO (MOTIR-11794). */
export function toFailedUsageGroupDTO(raw: RawFailedUsageGroup): FailedUsageGroupDTO {
  return {
    error: raw.error,
    rows: raw.rows,
    organizations: raw.organizations,
    oldestReceivedAt: raw.oldestReceivedAt,
    newestReceivedAt: raw.newestReceivedAt,
  };
}

/** motir-ai's replay answer → the DTO the Replay action hands the island. */
export function toFailedUsageReplayDTO(raw: RawFailedUsageReplay): FailedUsageReplayDTO {
  return {
    error: raw.error,
    reset: raw.reset,
    applied: raw.applied,
    failedAgain: raw.failedAgain,
    pending: raw.pending,
  };
}
