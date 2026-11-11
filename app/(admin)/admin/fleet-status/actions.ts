'use server';

import { revalidatePath } from 'next/cache';
import { FLEET_IMAGE_KEYS, type FleetImageKey } from '@/lib/dto/fleetStatusImages';
import type { FleetImagePublishOutcomeDTO } from '@/lib/dto/fleetStatusImages';
import { requirePlatformStaff } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { fleetStatusImagesService } from '@/lib/services/fleetStatusImagesService';

/**
 * PUBLISH LATEST on /admin/fleet-status (MOTIR-10886; design MOTIR-10885).
 *
 * Transport only, the `fleet-settings/actions.ts` shape: resolve the platform
 * principal, call ONE service method, answer a discriminated result the island
 * maps to what it draws. The rules — superadmin only, the row read again on the
 * server, refused when not behind or already running, the audited dispatch —
 * are `fleetStatusImagesService.publish`'s.
 *
 * ⚠️ A RESULT, NOT A THROW: a thrown error reaches the browser as a stripped
 * digest in production.
 */

const PAGE = '/admin/fleet-status';

export type FleetImagePublishActionResult =
  | FleetImagePublishOutcomeDTO
  | { outcome: 'not_permitted' };

const isImage = (value: unknown): value is FleetImageKey =>
  typeof value === 'string' && (FLEET_IMAGE_KEYS as readonly string[]).includes(value);

export async function publishFleetImageAction(
  image: FleetImageKey,
): Promise<FleetImagePublishActionResult> {
  try {
    const principal = await requirePlatformStaff('superadmin');
    if (!isImage(image)) return { outcome: 'refused', reason: 'not_read' };
    const result = await fleetStatusImagesService.publish(principal, image);
    if (result.outcome === 'dispatched') revalidatePath(PAGE);
    return result;
  } catch (err) {
    if (err instanceof NotPlatformStaffError) return { outcome: 'not_permitted' };
    console.error('[admin] fleet image publish failed', { image });
    return { outcome: 'failed', detail: 'the publish could not be started' };
  }
}

/** Whether the run a press started has ended for the page (the island polls it). */
export async function fleetImagePublishEndedAction(
  image: FleetImageKey,
  runId: number,
  target: string,
): Promise<{ ended: boolean }> {
  try {
    if (!isImage(image) || !Number.isInteger(runId)) return { ended: true };
    return { ended: await fleetStatusImagesService.publishEnded(image, runId, target) };
  } catch (err) {
    if (err instanceof NotPlatformStaffError) return { ended: true };
    return { ended: false };
  }
}
