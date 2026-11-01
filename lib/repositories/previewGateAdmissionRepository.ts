import type { Prisma } from '@/generated/prisma/client';

// Single-op data access for `preview_gate_admission` — the ids of the preview
// gate's admissions that have been used (Story MOTIR-5766 · Subtask MOTIR-5779).
// System-only RLS: every call runs inside withSystemContext and takes its `tx`.

export const previewGateAdmissionRepository = {
  /**
   * Record an admission as consumed. `true` when this call consumed it, `false`
   * when its id was already recorded — the replay the gate refuses. One
   * `INSERT … ON CONFLICT DO NOTHING`, so two racing uses of one admission have
   * exactly one winner.
   */
  async consume(
    input: { jti: string; host: string; expiresAt: Date },
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const { count } = await tx.previewGateAdmission.createMany({
      data: [input],
      skipDuplicates: true,
    });
    return count === 1;
  },

  /** Delete the rows whose admission expired before `now`: an expired admission
   *  is refused by its signature, so its record protects nothing. */
  async deleteExpired(now: Date, tx: Prisma.TransactionClient): Promise<number> {
    const { count } = await tx.previewGateAdmission.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return count;
  },
};
