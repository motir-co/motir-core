import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { assertTwoFactorCompliance } from '@/lib/auth/twoFactorGate';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { storedAssetUrl } from '@/lib/blob/referencedUrls';
import { enforcePublicReadRateLimit } from '@/lib/rateLimit/publicReadGuard';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { visitorPageContext, type ProjectPageContext } from '@/lib/pages/projectPageContext';
import { CURRENT_PATH_HEADER } from '@/proxy';
import { visitorConsentNext, visitorConsentPath, visitorSignInPath } from './consentPath';
import type { VisitorReadContext } from './context';

// THE VISITOR ROUTE TREE's gate (Story MOTIR-6170 · MOTIR-6648;
// `docs/decisions/visitor-sign-in-and-records.md`, design MOTIR-6641 panels 1, 2
// and 9). The Visitor layout and every Visitor page ask it the same question —
// "who is this reader on this project?" — and it answers through the ONE
// resolution, `resolveVisitor`, in its order, which is a privacy boundary:
//
// 1. `not_found` — `notFound()`, before anything else. A project that is not
//    public, an unknown key and a cloud-off build are one answer, signed in or
//    not: sending a stranger to sign in would tell them the key is real.
// 2. `sign_in` — the shipped sign-in page, whose `next` is the consent screen,
//    whose own `next` is this view (the two-hop hand-off, design panel 1).
// 3. `enter` — the reader belongs in their own view: `/p/<id>/enter` makes the
//    project active and sends them to the member route (a Server Component
//    cannot set the active-workspace cookie, so a route handler does).
// 4. `consent` — the one-time consent screen, carrying this view as `next`.
//    Nothing of the project is read first.
// 5. `visitor` — served.

/** The resolution, once per request however many layouts and pages ask. */
const resolveRequest = cache(async (identifier: string) => {
  const session = await getSession();
  const verdict = await projectAccessService.resolveVisitor(identifier, session);
  return { session, verdict };
});

/**
 * The Visitor view this request is for, as a same-site path inside `identifier`'s
 * Visitor views — read from the path `proxy.ts` forwards, and VALIDATED
 * (`visitorConsentNext`): anything else, a forged header included, is the
 * project's default view.
 */
async function currentVisitorPath(identifier: string): Promise<string> {
  const forwarded = (await headers()).get(CURRENT_PATH_HEADER);
  return visitorConsentNext(identifier, forwarded ?? undefined);
}

/** `/p/<id>/enter?next=<view>` — the member redirect's route handler. */
export function visitorEnterPath(identifier: string, next: string): string {
  return `/p/${encodeURIComponent(identifier)}/enter?next=${encodeURIComponent(next)}`;
}

/**
 * Settle who this reader is on `identifier`: every verdict but `visitor` ends the
 * request here (a not-found, or a redirect), in the order above. Returns the
 * Visitor's read context, and their own name, email and photo for their account menu.
 */
export async function settleVisitor(identifier: string): Promise<{
  ctx: VisitorReadContext;
  actorName: string | null;
  actorEmail: string;
  actorImage: string | null;
}> {
  const { session, verdict } = await resolveRequest(identifier);
  if (verdict.kind === 'not_found') notFound();
  const here = await currentVisitorPath(identifier);
  if (verdict.kind === 'sign_in' || !session) {
    redirect(visitorSignInPath(identifier, visitorConsentNext(identifier, here)));
  }
  // A reader held by the two-factor rule is no more a Visitor than a member
  // (the data doors require a COMPLIANT session, `lib/visitor/readActor.ts`).
  await assertTwoFactorCompliance(session.user.id);
  if (verdict.kind === 'enter') redirect(visitorEnterPath(identifier, here));
  if (verdict.kind === 'consent') redirect(visitorConsentPath(identifier, here));
  return {
    ctx: verdict.ctx,
    actorName: session.user.name ?? null,
    actorEmail: session.user.email,
    // The RESOLVED profile-photo URL for the account menu (MOTIR-10182) — the
    // stored value is an object key and never reaches `src` as one.
    actorImage: storedAssetUrl(session.user.image),
  };
}

/** What a Visitor page renders: its view, or the rate-limited state (panel 9b). */
export type VisitorPageGate =
  | { kind: 'view'; ctx: ProjectPageContext }
  | { kind: 'limited'; retryAfterSeconds: number };

/**
 * A Visitor PAGE's gate: {@link settleVisitor}, then the reader's `public-read`
 * budget — spent once per page render, per reader (MOTIR-6647's scope). The
 * budget is spent by the PAGE rather than the layout because a layout does not
 * re-render when the reader moves between views, and each move is a read.
 */
export async function visitorPage(identifier: string): Promise<VisitorPageGate> {
  const { ctx, actorName } = await settleVisitor(identifier);
  const here = await currentVisitorPath(identifier);
  const limited = await enforcePublicReadRateLimit(
    new Request(`${resolveBaseUrlTrimmed()}${here}`, { headers: await forwardedHeaders() }),
    ctx.actorUserId,
  );
  if (limited) {
    const seconds = Number(limited.headers.get('Retry-After'));
    return { kind: 'limited', retryAfterSeconds: Number.isFinite(seconds) ? seconds : 60 };
  }
  return { kind: 'view', ctx: visitorPageContext(ctx, actorName) };
}

/** The request headers the limiter may consult (it keys on the user, not these). */
async function forwardedHeaders(): Promise<Record<string, string>> {
  const incoming = await headers();
  const out: Record<string, string> = {};
  for (const name of ['x-forwarded-for', 'x-real-ip']) {
    const value = incoming.get(name);
    if (value) out[name] = value;
  }
  return out;
}
