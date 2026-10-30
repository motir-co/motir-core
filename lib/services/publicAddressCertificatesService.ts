import type {
  PublicAddress,
  PublicAddressFailureKind,
  PublicAddressStatus,
} from '@/generated/prisma/client';

import type { CertificateState } from '@/lib/publicAddresses/certificateProvider';
import { pointingRecordsFor } from '@/lib/publicAddresses/pointingRecords';
import {
  certificateProvider,
  certificatesConfigured,
  dnsResolver,
} from '@/lib/publicAddresses/providers';
import { publicAddressRepository } from '@/lib/repositories/publicAddressRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// THE CERTIFICATE SWEEP — Story MOTIR-3878 · Subtask MOTIR-4219.
// Reads the platform, writes what it said. Requests nothing: the lifecycle
// (MOTIR-4216) is what asks for a certificate; this only carries the answer home.
//
// ── It also RE-PROVES the customer's side of a live domain (MOTIR-9526) ─────
//
// A certificate that still exists says nothing about whether its hostname's
// owner can still prove it. So on an `issued` row (and on a row this sweep
// failed for a lost proof, so it can recover) it re-reads the ownership TXT and
// Fly's `configured` reading. A lost TXT or a lost pointing record drives the
// row to `failed` with a KIND the pane branches on and a reason naming the
// record to restore — and since the host contract serves only `issued` rows, a
// domain whose owner can no longer prove it stops answering. That is the
// intended direction of failure for a name Motir does not own.

/** The label the ownership TXT lives at — the lifecycle's own. */
const VERIFY_PREFIX = '_motir-verify';

/** How many rows one status may contribute to a single run. */
const PAGE_SIZE = 50;

/**
 * How stale a row must be before it is re-checked, per status.
 *
 * ⚠️ THIS IS WHERE THE CARD'S TWO CADENCES LIVE. It asked for a fast schedule
 * for the in-flight states and an hourly one for `issued`; the schedule
 * clustering (`lib/jobs/schedules.ts`) allows one cadence, so the distinction
 * moves here — one wake, two staleness windows — which costs a query rather
 * than a cold start.
 */
const STALE_AFTER_MS: Partial<Record<PublicAddressStatus, number>> = {
  // In flight: re-check on every sweep.
  verifying: 0,
  pending_certificate: 0,
  // Live: hourly is plenty. A renewal is Fly's and an expiry is weeks away;
  // checking a healthy certificate every half hour spends API calls to learn
  // nothing.
  issued: 60 * 60 * 1000,
  // Broken: hourly. A customer who fixes their DNS uses the pane's own
  // *Check again*, so this is the backstop for the one who does not come back.
  failed: 60 * 60 * 1000,
  expired: 60 * 60 * 1000,
  // `active` and `alias` are SUBDOMAIN states covered by the wildcard, and
  // `revoked` is terminal until a customer acts. Absent from this map on
  // purpose — see `SWEEPS`, which is what makes the omission total rather than
  // forgotten.
};

/**
 * ⚠️ TOTAL OVER THE ENUM, and that is the point of writing it as a `Record`
 * rather than a list of the interesting values: when `PublicAddressStatus`
 * grows, this fails to compile and somebody decides what the new value does on
 * a check. A list would simply not mention it, and the new state would be
 * swept or not by accident.
 */
const SWEEPS: Record<PublicAddressStatus, boolean> = {
  active: false, // a subdomain — the wildcard covers it, there is nothing to check
  alias: false, // a redirect; it serves no certificate of its own
  unverified: false, // waiting on the CUSTOMER, not on the platform
  verifying: true,
  pending_certificate: true,
  issued: true, // renewals and expiries arrive here
  failed: true,
  expired: true,
  revoked: false, // terminal until a customer asks again
};

export interface CertificateSweepSummary {
  scanned: number;
  changed: number;
  failed: number;
  skipped: 'not-configured' | null;
}

export const publicAddressCertificatesService = {
  /**
   * Re-read every address whose status this job owns and that is due a check.
   *
   * The platform call is a side effect OUTSIDE any transaction (`CLAUDE.md`):
   * read the platform, then one short write per row. A failure on one hostname
   * marks nothing and moves on, so a single unreachable call never wedges the
   * sweep — the run reports it and the engine's retry budget carries the run.
   */
  async refreshDueAddresses(): Promise<CertificateSweepSummary> {
    // ⚠️ BEFORE ANY REPOSITORY READ. A self-hosted build schedules this job like
    // every other and must do nothing at all — not read, not log per row, not
    // touch the database it may not even have addresses in.
    if (!(await certificatesConfigured())) {
      return { scanned: 0, changed: 0, failed: 0, skipped: 'not-configured' };
    }

    const provider = await certificateProvider();
    const now = Date.now();
    let scanned = 0;
    let changed = 0;
    let failed = 0;

    for (const status of Object.keys(SWEEPS) as PublicAddressStatus[]) {
      if (!SWEEPS[status]) continue;
      const staleAfter = STALE_AFTER_MS[status] ?? 0;
      const before = new Date(now - staleAfter);

      // Cross-tenant: the sweep spans every workspace, so it binds the system
      // context rather than reading unbound (where the public arm would narrow
      // it to public projects and return a plausible, wrong subset).
      const due = await withSystemContext((tx) =>
        publicAddressRepository.listByStatusOlderThan(status, before, PAGE_SIZE, tx),
      );

      for (const address of due) {
        scanned += 1;
        try {
          // OUTSIDE the transaction — both reads. A resolver ERROR throws into
          // the catch below: an unreachable resolver is not evidence the TXT is
          // gone, and treating it as such would take live sites down on a blip.
          const state = await provider.check(address.hostname);
          const ownership = reprovesOwnership(address) ? await txtProven(address) : null;
          const next = nextStatus(address, state, ownership);
          if (next === null) {
            // No transition, but the check HAPPENED — recording that is what
            // stops the row being re-checked every sweep for ever, and what
            // lets the pane say when it last looked.
            await write(address, {
              status: address.status,
              failureReason: address.failureReason,
              failureKind: address.failureKind,
              lastCheckedAt: state.checkedAt,
              ...expiryOf(state),
            });
            continue;
          }
          await write(address, next);
          changed += 1;
        } catch (err) {
          // One hostname's failure is not the sweep's. Counted, LOGGED with the
          // hostname, and left for the next run — the engine's retry budget and
          // the DLQ carry the RUN, not the row.
          //
          // ⚠️ LOGGED, not swallowed. A bare `catch {}` here makes an
          // unreachable platform and a bug in this file's own mapping look
          // identical from the summary — which is exactly what it did while this
          // was being written, and cost a debugging round trip to notice.
          console.warn(
            `[public-addresses] certificate check failed for ${address.hostname}:`,
            err instanceof Error ? err.message : err,
          );
          failed += 1;
        }
      }
    }

    return { scanned, changed, failed, skipped: null };
  },
};

/** Whether this row's ownership is re-proved on a sweep. */
function reprovesOwnership(address: PublicAddress): boolean {
  if (address.kind !== 'custom_domain') return false;
  if (address.status === 'issued' || address.status === 'expired') return true;
  // A failure THIS sweep wrote for a lost proof, so the row can recover. A
  // `failed` with no kind is an issuance failure, the lifecycle's to retry.
  return (
    address.status === 'failed' &&
    (address.failureKind === 'txt_lost' || address.failureKind === 'pointing_lost')
  );
}

/** Whether the `_motir-verify` TXT still carries the row's token. Throws on a resolver error. */
async function txtProven(address: PublicAddress): Promise<boolean> {
  if (!address.verificationToken) return false;
  const records = await dnsResolver().resolveTxt(`${VERIFY_PREFIX}.${address.hostname}`);
  return records.includes(address.verificationToken);
}

type NextRow = {
  status: PublicAddressStatus;
  failureReason: string | null;
  failureKind?: PublicAddressFailureKind | null;
  lastCheckedAt: Date;
  issuedAt?: Date;
  certificateExpiresAt?: Date;
};

/**
 * What the platform's answer — and, on a live domain, the customer's proof —
 * means for this row, or `null` for no transition.
 *
 * `ownership` is `null` when the row is not re-proved (an in-flight state), else
 * whether the TXT still carries the token.
 *
 * Reads `issued` off the presence of a certificate rather than off a status
 * string, for the reason the adapter gives: `status` is a vocabulary nobody has
 * closed, and mapping an open string set is how a state machine acquires a
 * silent tenth value.
 */
export function nextStatus(
  address: PublicAddress,
  state: CertificateState,
  ownership: boolean | null,
): NextRow | null {
  if (state.issued) {
    // OWNERSHIP FIRST: it is the security property. A domain whose owner can no
    // longer prove it must not keep serving, however healthy its certificate.
    if (ownership === false) {
      return failedFor(address, 'txt_lost', txtLostReason(address), state);
    }
    if (ownership === true && !state.configured) {
      return failedFor(address, 'pointing_lost', pointingLostReason(address), state);
    }
    if (address.status === 'issued') return null;
    return {
      status: 'issued',
      failureReason: null,
      lastCheckedAt: state.checkedAt,
      ...expiryOf(state),
      // Exactly once: the FIRST time this row becomes issued. A renewal is not a
      // new issuance from the customer's point of view, and overwriting the date
      // on every renewal would lose when the address actually went live.
      ...(address.issuedAt ? {} : { issuedAt: new Date() }),
    };
  }

  // Previously live and no longer: the platform has stopped serving it. This is
  // the transition nobody is watching for, and the whole reason a backstop
  // sweep exists.
  if (address.status === 'issued') {
    return {
      status: 'expired',
      failureReason: 'The certificate is no longer active. Check that the DNS records still exist.',
      failureKind: 'certificate_lost',
      lastCheckedAt: state.checkedAt,
    };
  }

  // Still in flight and still not configured — the customer has not finished
  // their DNS. Not a failure: it is the ordinary state on the way in. Pointed
  // correctly but still no certificate: keep waiting; Fly validates
  // asynchronously and a minute or two here is normal.
  return null;
}

/** A failure of `kind`, or no transition when the row already reads exactly that. */
function failedFor(
  address: PublicAddress,
  kind: PublicAddressFailureKind,
  reason: string,
  state: CertificateState,
): NextRow | null {
  if (address.status === 'failed' && address.failureKind === kind) return null;
  return {
    status: 'failed',
    failureReason: reason,
    failureKind: kind,
    lastCheckedAt: state.checkedAt,
    ...expiryOf(state),
  };
}

/**
 * The reading's certificate expiry as a write, or nothing (MOTIR-9526).
 *
 * ⚠️ DO NOT CLEAR WHAT YOU COULD NOT READ. A reading with no date — or with no
 * certificate — writes nothing, so the stored date survives and the row keeps
 * saying what was last known; only a reading that carries a date overwrites it.
 */
function expiryOf(state: CertificateState): { certificateExpiresAt?: Date } {
  return state.issued && state.expiresAt ? { certificateExpiresAt: state.expiresAt } : {};
}

function txtLostReason(address: PublicAddress): string {
  return (
    `The ownership record is gone. Add the TXT record ${VERIFY_PREFIX}.${address.hostname} ` +
    `with the value ${address.verificationToken ?? ''} again.`
  );
}

function pointingLostReason(address: PublicAddress): string {
  const records = pointingRecordsFor(address.hostname);
  if (records.length === 0) {
    return `${address.hostname} no longer points at Motir. Restore its DNS record.`;
  }
  const wanted = records.map((r) => `${r.type} ${r.value}`).join(', ');
  return `${address.hostname} no longer points at Motir. Restore its ${wanted} record.`;
}

function write(address: PublicAddress, data: NextRow) {
  return withSystemContext((tx) => publicAddressRepository.updateStatus(address.id, data, tx));
}
