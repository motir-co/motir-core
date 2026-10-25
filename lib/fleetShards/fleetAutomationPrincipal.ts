import { FleetShardProvisioningRefusedError } from '@/lib/ciFleet/errors';
import { MOTIR_SYSTEM_USER_EMAIL } from '@/lib/ai/systemPrincipal';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { userRepository } from '@/lib/repositories/userRepository';

// WHO THE POOL'S OWN GROWTH IS AUDITED AS (Story MOTIR-9362 · MOTIR-9460). The
// unattended add-shard and the growth pass run with no person behind them, so
// their `fleet.shard.add` / growth audit rows name Motir's reserved system
// account (`system@motir.internal`, which cannot sign in) — never a staff
// operator they are not. The audit row's actor is a real user, so the account
// must exist: a deployment without it refuses before any external call.

/** The platform role an automated row records — the operator tier the person-run
 *  command's actions sit in. */
const AUTOMATION_ROLE = 'operator' as const;

export async function fleetAutomationPrincipal(): Promise<PlatformPrincipal> {
  const user = await userRepository.findByEmail(MOTIR_SYSTEM_USER_EMAIL);
  if (!user) {
    throw new FleetShardProvisioningRefusedError([
      `the Motir system account ${MOTIR_SYSTEM_USER_EMAIL} is not provisioned; ` +
        'automated fleet actions are audited as it',
    ]);
  }
  return { userId: user.id, email: user.email, role: AUTOMATION_ROLE };
}
