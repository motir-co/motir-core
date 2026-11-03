import { NextResponse } from 'next/server';
import {
  seedFakeTxt,
  setFakePointing,
  usingFakePublicAddressProviders,
} from '@/lib/publicAddresses/providers';
import { publicAddressCertificatesService } from '@/lib/services/publicAddressCertificatesService';
import { productionGate, requireContext } from '../../_helpers';

// `_test` door for the customer-domain acceptance walk (Story MOTIR-4533 ·
// Subtask MOTIR-9533). See ../../_helpers.ts for the three invariants every
// `_test` handler keeps (the production gate, a session, service-only).
//
//   POST body={ txt?: { name, values }, pointing?: { hostname, pointed }, sweep? }
//     → 200 { sweep: CertificateSweepSummary | null }
//
// The fake resolver and the fake certificate provider live in the SERVER
// process (`lib/publicAddresses/providers.ts`), so a spec reaches them only
// through a door like this one. `txt` replaces what the resolver answers for one
// name (`values: []` is "the customer deleted the record"), `pointing` makes the
// provider report a hostname as no longer pointed at Motir, and `sweep` runs the
// certificate sweep ONCE, synchronously, after both — so a failure leg is shown
// in a browser without waiting for the five-minute schedule. The organization
// erasure door (`../../organizations/erasure-sweep`) is the precedent.
//
// Refused with the same 404 when the fakes are not armed: flipping a binding the
// server is not using would let a walk believe it changed something it did not.

interface FakesBody {
  txt?: { name?: unknown; values?: unknown };
  pointing?: { hostname?: unknown; pointed?: unknown };
  sweep?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  const gated = productionGate();
  if (gated) return gated;
  const auth = await requireContext();
  if (auth.response) return auth.response;
  if (!usingFakePublicAddressProviders()) {
    return NextResponse.json({ code: 'NOT_FOUND' }, { status: 404 });
  }

  const body = ((await req.json().catch(() => null)) ?? {}) as FakesBody;
  if (body.txt && typeof body.txt.name === 'string' && Array.isArray(body.txt.values)) {
    seedFakeTxt(body.txt.name, body.txt.values.map(String));
  }
  if (
    body.pointing &&
    typeof body.pointing.hostname === 'string' &&
    typeof body.pointing.pointed === 'boolean'
  ) {
    setFakePointing(body.pointing.hostname, body.pointing.pointed);
  }
  const sweep =
    body.sweep === true ? await publicAddressCertificatesService.refreshDueAddresses() : null;
  return NextResponse.json({ sweep });
}
