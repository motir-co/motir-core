import { publicHostnameReservationRepository } from '@/lib/repositories/publicHostnameReservationRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// THE EXPIRED NAME-HOLD SWEEP — Story MOTIR-4528 · Subtask MOTIR-9509.
//
// A released name is held until its `expires_at` (§8 Amendment 3), and a lapsed
// hold is already invisible to every claim. This deletes those rows so the
// table holds only digests still protecting a name. The job
// `system.public-hostname-reservation-sweep` is the caller.
//
// System-scoped: holds were written by every workspace, so the delete runs
// under `withSystemContext` (the table's `public_hostname_reservation_system`
// arm), never a tenant context, which would see none of the other workspaces'
// rows to delete.

export const publicHostnameReservationService = {
  /**
   * Delete every hold that has lapsed at `now`. Idempotent: a second run finds
   * nothing left to delete. `now` is an argument so a test can pin the boundary.
   */
  async sweepExpiredNameHolds(now: Date = new Date()): Promise<{ deleted: number }> {
    const deleted = await withSystemContext((tx) =>
      publicHostnameReservationRepository.deleteExpiredInTx(now, tx),
    );
    return { deleted };
  },
};
