import type { EmailSuppressionReason } from '@/generated/prisma/client';
import { emailSuppressionRepository } from '@/lib/repositories/emailSuppressionRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// The email suppression list's business logic (MOTIR-10565): which addresses
// Motir no longer sends to, and the one place they are added.
//
// SYSTEM-ADMIN CONTEXT: both callers run outside any request — the `email.send`
// job reads, the SES notification webhook writes — and the table is platform
// bookkeeping whose policy admits `app.system_admin` only. Every transaction
// here opens through `withSystemContext` for that reason; a read off the
// singleton would return no row and let every suppressed address through.

/**
 * The form an address is compared in. Domains are case-insensitive by RFC
 * 5321; local parts are case-sensitive in theory and in no mail system Motir
 * sends to, and SES's own suppression list compares them case-insensitively too.
 */
export function normalizeEmailAddress(address: string): string {
  return address.trim().toLowerCase();
}

export interface SuppressAddressInput {
  address: string;
  reason: EmailSuppressionReason;
  provider: string;
  detail?: string | null;
  providerMessageId?: string | null;
}

export const emailSuppressionService = {
  /** True when sends to this address are suppressed. */
  async isSuppressed(address: string): Promise<boolean> {
    const normalized = normalizeEmailAddress(address);
    if (normalized === '') return false;
    const row = await withSystemContext((tx) =>
      emailSuppressionRepository.findByAddress(normalized, tx),
    );
    return row !== null;
  },

  /**
   * Suppress every address in one transaction — one SES event can name several
   * recipients — and answer the normalised addresses written. A blank address
   * is dropped rather than stored as a row that matches nothing.
   */
  async suppress(entries: readonly SuppressAddressInput[]): Promise<string[]> {
    const rows = entries
      .map((entry) => ({ ...entry, address: normalizeEmailAddress(entry.address) }))
      .filter((entry) => entry.address !== '');
    if (rows.length === 0) return [];
    return withSystemContext(async (tx) => {
      const written: string[] = [];
      for (const row of rows) {
        await emailSuppressionRepository.upsert(
          {
            address: row.address,
            reason: row.reason,
            provider: row.provider,
            detail: row.detail ?? null,
            providerMessageId: row.providerMessageId ?? null,
          },
          tx,
        );
        written.push(row.address);
      }
      return written;
    });
  },
};
