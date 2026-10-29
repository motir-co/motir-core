import { requirePlatformStaff } from '@/lib/platform/auth';
import {
  parseSeedRegistryBody,
  retireBodySchema,
  seedRegistryErrorResponse,
  seedRegistryJson,
} from '@/lib/seedRegistry/routeErrors';
import { seedRegistryPromotionService } from '@/lib/services/seedRegistryPromotionService';

// RETIRE a starter (Story MOTIR-704 · MOTIR-710; decision MOTIR-706 v2 §3.6).
// Transport only. Operator and above; anyone else gets the console's not-found.

/** Retire the entry and answer it. */
export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    const principal = await requirePlatformStaff('operator');
    const { key } = await params;
    const { reason } = await parseSeedRegistryBody(req, retireBodySchema);
    return seedRegistryJson(await seedRegistryPromotionService.retire(principal, key, reason));
  } catch (err) {
    return seedRegistryErrorResponse(err);
  }
}
