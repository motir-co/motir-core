import { NextResponse } from 'next/server';

import { publicSurfaceUnavailable } from '@/lib/publicProjects/cloudGate';
import { PublicAddressesUnavailableError } from '@/lib/publicAddresses/errors';
import { isEdgeContractCaller } from '@/lib/publicAddresses/edgeContractToken';
import {
  HOST_CONTRACT_CACHE_CONTROL,
  HOST_CONTRACT_CREDENTIALED_CACHE_CONTROL,
  NOT_FOUND_CACHE_CONTROL,
} from '@/lib/publicAddresses/hostContractCache';
import {
  PublicHostNotFoundError,
  publicAddressesService,
} from '@/lib/services/publicAddressesService';

// GET /api/public/hosts/{host} — Story MOTIR-3878 · Subtask MOTIR-4217.
//
// The PRODUCER end of a two-ended integration: `motir-marketing`'s host router
// (MOTIR-4220) calls this server-side, on every request to a tenant host, before
// any page renders. Without it the consumer card has nothing to call.
//
// ── ANONYMOUS, and there is no `getSession()` in this file ────────────────
//
// Unlike its siblings under `app/api/public/`, this route does not read a
// session even to personalise. It is called by another SERVER, before a page
// exists, with no user in the picture — and a session read here would be a
// credential-shaped thing on a path that has no credential. The absence is
// asserted by `tests/api/public/anonymous-posture.test.ts`.
//
// ── NO rate-limit guard, and that is the SHIPPED read shape ──────────────
//
// The card's step list says "then the rate-limit guard". No read route under
// `app/api/public/` has one — the limiter is on the WRITE paths (`requests`,
// `follow`, `subscribe`). Adding one here would give this route a guard none of
// its eleven read siblings carry, so it follows the shipped shape instead and
// the deviation is recorded on the card. Rung 2 over rung 3.
//
// ── The cache bound: 30 seconds, and no revalidate window ────────────────
//
// A renamed or released name stops answering at once (ADR §8 Amendment 3 rule
// 2). The row goes in the rename's own transaction; what could still answer for
// it is a cached 200. So a 200 is cacheable for 30 seconds and no longer, with
// no `stale-while-revalidate` (which would serve the retired answer past the
// bound), and a 404 is `no-store`, so a name claimed moments after a refusal is
// not hidden by it. `lib/publicAddresses/hostContractCache.ts` holds the number
// and the reasoning; the consumer must not stack a longer cache on top.
//
// ── The edge's bearer (ADR MOTIR-9521 §3) ────────────────────────────────
//
// An `application` answer carries its `upstream` only for `motir-edge`'s
// `Authorization: Bearer <MOTIR_EDGE_CONTRACT_TOKEN>`. That is a comparison of
// a server-to-server secret, not a session, so the anonymous posture above
// holds. A credentialed 200 is `private` with the same 30-second bound, and
// EVERY 200 varies on `Authorization`, so a shared cache can never hand the
// edge an anonymous answer (no upstream) or a stranger the edge's.
//
// HTTP only: gate → one service call → map errors (the 4-layer rule).

export async function GET(
  req: Request,
  { params }: { params: Promise<{ host: string }> },
): Promise<Response> {
  // The capability gate FIRST — before anything else. With `MOTIR_CLOUD` unset
  // this surface does not exist (ADR §11).
  const absent = publicSurfaceUnavailable();
  if (absent) return absent;

  const { host } = await params;

  const credentialed = isEdgeContractCaller(req.headers.get('authorization'));

  try {
    const resolution = await publicAddressesService.resolveHost(decodeURIComponent(host), {
      credentialed,
    });
    return NextResponse.json(resolution, {
      headers: {
        'Cache-Control': credentialed
          ? HOST_CONTRACT_CREDENTIALED_CACHE_CONTROL
          : HOST_CONTRACT_CACHE_CONTROL,
        Vary: 'Authorization',
      },
    });
  } catch (err) {
    // ⚠️ ONE refusal shape for every reason — unknown host, un-issued
    // certificate, the base domain, a non-cloud build. A caller must not be able
    // to tell "no such tenant" from "a tenant exists but is not serving yet";
    // that difference is precisely what would make walking hostnames worthwhile.
    if (err instanceof PublicHostNotFoundError || err instanceof PublicAddressesUnavailableError) {
      return NextResponse.json(
        { code: err.code },
        { status: 404, headers: { 'Cache-Control': NOT_FOUND_CACHE_CONTROL } },
      );
    }
    throw err;
  }
}
