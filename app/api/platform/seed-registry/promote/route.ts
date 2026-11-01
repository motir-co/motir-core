import { requirePlatformStaff } from '@/lib/platform/auth';
import {
  parseSeedRegistryBody,
  promoteBodySchema,
  seedRegistryErrorResponse,
  seedRegistryJson,
} from '@/lib/seedRegistry/routeErrors';
import { seedRegistryPromotionService } from '@/lib/services/seedRegistryPromotionService';

// PROMOTE a Motir-created repository at a ref to a starter (Story MOTIR-704 ·
// MOTIR-710; decision MOTIR-706 v2 §3.6). Transport only. Operator and above;
// anyone else gets the console's not-found.

/** Promote, or re-promote, and answer the entry with its three serves-lists. */
export async function POST(req: Request) {
  try {
    const principal = await requirePlatformStaff('operator');
    const { reason, ...input } = await parseSeedRegistryBody(req, promoteBodySchema);
    return seedRegistryJson(await seedRegistryPromotionService.promote(principal, input, reason));
  } catch (err) {
    return seedRegistryErrorResponse(err);
  }
}
