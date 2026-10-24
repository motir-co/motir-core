import type { AgentInstance } from '@/generated/prisma/client';
import { profileDisplayName } from '@/lib/agentInstances/profiles';
import type {
  AgentForCardDto,
  AgentRunAgentRefusal,
  AgentRunningRunDto,
} from '@/lib/dto/agentInstanceRuns';

// Prisma rows → the card's AGENT PICKER row (Story MOTIR-6864 · MOTIR-7026).
// Pure. Drops what no client is owed, as `agentInstanceMappers.ts` does: the
// tenancy columns, the owner, the Fly handle and the probe digests.

export function toAgentForCardDto(
  row: AgentInstance,
  runningRun: AgentRunningRunDto | null,
  refusal: AgentRunAgentRefusal | null,
  waitingForRoom = false,
): AgentForCardDto {
  return {
    id: row.id,
    name: row.name,
    profileId: row.profileId,
    profileName: profileDisplayName(row.profileId),
    state: row.state,
    // A probe for another digest says nothing about this image (§4).
    runLauncher: row.runLauncherDigest === row.imageDigest ? row.runLauncher : 'unknown',
    signInState: row.signInState,
    signInCheckedAt: row.signInCheckedAt?.toISOString() ?? null,
    runningRun,
    refusal,
    waitingForRoom,
  };
}
