import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';
import { publicSiteOrigin } from '@/lib/publicProjects/urls';
import { publicCorsHeaders, publicCorsPreflightHeaders } from '@/lib/publicProjects/cors';
import { WELL_KNOWN_CORS_HEADERS, WELL_KNOWN_PREFIX } from '@/lib/oauth/cors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { VISITOR_COOKIE, isVisitorCookieValue, visitorCookieOptions } from '@/lib/visitor/cookie';
import { parseVisitorPath, visitorPathForMemberPath } from '@/lib/visitor/routes';
import { previewHostOf } from '@/lib/preview/gate';

// Optimistic cookie-presence check on every incoming request to a
// protected route: if no session cookie is present, bounce to /sign-in.
// This is the pattern Better-Auth recommends — full session validation
// (a DB call) is too expensive to run on every request. Each protected
// page/route still re-checks the session server-side via `getSession()`
// for actual enforcement.
//
// Next.js 16 renamed the `middleware.ts` file convention to `proxy.ts`
// (https://nextjs.org/docs/messages/middleware-to-proxy). The exported
// function is now `proxy`, and Proxy defaults to the Node.js runtime
// rather than Edge — Better-Auth's `getSessionCookie` works in both.
//
// The matcher below targets the /app/(authed)/* route group. The (authed)
// segment is a Next.js route group — it groups files but doesn't add a
// URL segment — so its children are matched by their actual URL paths.
// We list those URL paths in `config.matcher` rather than trying to match
// the route-group name.

/**
 * The request header carrying the path the visitor actually asked for
 * (MOTIR-3652). A Next.js **layout** — the only place every signed-in page
 * reliably passes through — has no supported way to learn the current URL, so
 * the edge forwards it and the layout reads it back with `headers()`.
 *
 * ⚠️ **ADVISORY, ABSENT OFF-MATCHER, AND FORGEABLE.** Three properties every
 * consumer must treat as load-bearing, stated here at the header's source
 * rather than left for each reader to rediscover:
 *
 * 1. **Advisory.** It is a hint about where the visitor was going, never an
 *    authorization input. Nothing may be granted or denied on its value.
 * 2. **Absent off-matcher.** `config.matcher` below decides where the proxy
 *    runs at all, so a request to any path it does not cover arrives with no
 *    such header. `headers().get(CURRENT_PATH_HEADER)` returning `null` is a
 *    normal state, not an error.
 * 3. **Forgeable.** A client can send `x-current-path: https://evil.example`
 *    with any request. `proxy()` OVERWRITES it on every request it handles
 *    (see below), so a covered path is safe — but a consumer that reads it
 *    must still not assume the proxy ran.
 *
 * **So a consumer using it as a REDIRECT TARGET must first validate it as a
 * same-origin relative path** — a leading `/`, no scheme, no protocol-relative
 * `//`, no `..` segment — and fall back to a fixed safe destination otherwise.
 * An unvalidated redirect target taken from a request header is an
 * open-redirect, and it is the one way this small piece of plumbing could ship
 * a vulnerability. The first (and, today, only) consumer is MOTIR-3648's
 * forced-enrolment gate, which sends a person back where they were going once
 * they have enrolled.
 */
export const CURRENT_PATH_HEADER = 'x-current-path';

/**
 * The top-level URL segments that have MOVED to the public site (MOTIR-3884).
 * The proxy 308s these to `motir.co` (the public origin) once
 * `MOTIR_PUBLIC_SITE_URL` is configured, path and query preserved.
 *
 * ⚠️ THE ROOT `/` IS NOT ONE OF THEM (MOTIR-7819). It was — as `''` — and that
 * sent every request for `app.motir.co/`, signed in or not, to the marketing
 * site, so `app/page.tsx`'s two-branch contract (session → the landing, none →
 * `/sign-in`, MOTIR-3367) never received a request in production. The landing
 * CONTENT lives on motir.co; `app.motir.co/` is the application's entry and
 * answers by session. A 308 is cached by browsers, so whoever already met the
 * old redirect may keep meeting it from cache after this ships.
 *
 * `/p/*` is included. Its move to `motir.co` is MOTIR-3877's (which renders the
 * replacement), but the redirect ships here and MOTIR-3951 deletes the page from
 * this application — so `/p/*` must 308 onto the public host, not 404.
 */
export const PUBLIC_REDIRECT_SEGMENTS = new Set(['explore', 'docs', 'legal', 'p']);

/**
 * The paths under `/p/*` that stay IN THIS APPLICATION although their segment has
 * moved (Story MOTIR-6170):
 *
 * - the Visitor's one-time CONSENT screen, `/p/<identifier>/consent`
 *   (MOTIR-6669), which must be answered on `app.motir.co`, where the session
 *   lives;
 * - the Visitor's nine live VIEWS (MOTIR-6648) — `items`, `items/<key>`, `tree`,
 *   `board`, `roadmap`, `plans`, `plans/<id>`, `approvals` and `runs` under
 *   `/p/<identifier>/` (`lib/visitor/routes.ts` is the table);
 * - `/p/<identifier>/enter`, the route that sends a MEMBER who opened a Visitor
 *   link into their own view (MOTIR-6648).
 *
 * The bare `/p/<identifier>` and every other `/p/*` path (the changelog, the
 * requests, a sub-path under any other view) keep their 308 to motir.co.
 */
export function isAppVisitorPath(pathname: string): boolean {
  return /^\/p\/[^/]+\/(?:consent|enter)\/?$/.test(pathname) || parseVisitorPath(pathname) !== null;
}

/**
 * A Visitor path is FORWARDED, never bounced (MOTIR-6648). The proxy's session
 * bounce is not theirs: only the Visitor layout knows whether the project exists,
 * and it must answer not-found BEFORE it asks anyone to sign in — a proxy bounce to
 * `/sign-in` would tell a stranger that a private project's key is real. So the
 * layout owns the sign-in redirect, and this only forwards the path (the layout
 * builds its `next=` from it, validated) and, on a VIEW, writes the
 * `motir_visitor` cookie — the redirect hint `visitorLinkRedirect` reads
 * (`lib/visitor/cookie.ts`). The data doors do NOT read it: a Visitor tab names
 * its project on each request instead (`lib/visitor/address.ts`, MOTIR-6892).
 *
 * The cookie is written HERE because a Server Component cannot set one. Writing it
 * before the layout has decided anything is safe by construction: it is an
 * address, not a credential, and every door re-derives the reader's standing from
 * the session.
 */
function visitorSurface(request: NextRequest): NextResponse | null {
  const { pathname, search } = request.nextUrl;
  if (!isAppVisitorPath(pathname)) return null;
  const headers = new Headers(request.headers);
  headers.set(CURRENT_PATH_HEADER, `${pathname}${search}`);
  const response = NextResponse.next({ request: { headers } });
  const view = parseVisitorPath(pathname);
  if (view && isVisitorCookieValue(view.identifier)) {
    response.cookies.set(VISITOR_COOKIE, view.identifier, visitorCookieOptions());
  }
  return response;
}

/** Whether this request is Next's router PREFETCHING a link, not a reader navigating. */
function isPrefetch(request: NextRequest): boolean {
  if (request.headers.get('next-router-prefetch')) return true;
  const purpose = request.headers.get('sec-purpose') ?? request.headers.get('purpose') ?? '';
  return purpose.includes('prefetch');
}

/**
 * The Visitor view a request was followed FROM — its same-origin Referer parsed
 * as a Visitor path of the project the `motir_visitor` cookie names — else null.
 * Requiring the COOKIE as well as the referer is what ends the one loop the
 * redirect below could make: the member redirect (`/api/visitor/enter`) clears
 * the cookie, so a reader who became a member while reading lands in their own
 * view instead of being sent back to the Visitor path it came from.
 */
function followedFromVisitorView(request: NextRequest): { identifier: string } | null {
  const cookie = request.cookies.get(VISITOR_COOKIE)?.value;
  if (!cookie) return null;
  const referer = request.headers.get('referer');
  if (!referer) return null;
  let from: URL;
  try {
    from = new URL(referer);
  } catch {
    return null;
  }
  if (from.origin !== request.nextUrl.origin) return null;
  const view = parseVisitorPath(from.pathname);
  if (!view || view.identifier.toLowerCase() !== cookie.toLowerCase()) return null;
  return { identifier: view.identifier };
}

/**
 * A MEMBER route followed FROM a Visitor view, sent to the Visitor path it means
 * (MOTIR-6648; design panel 5, "every in-page link a view body emits must point at
 * the Visitor path").
 *
 * The eight page bodies are shared with the member app (MOTIR-6643). Since
 * MOTIR-6888 they build the Visitor path themselves (`readerRoutes`, held by
 * `tests/visitor/visitorReaderRoutesGuard.test.ts`), so this is the SAFETY NET,
 * not the mechanism: a member route still followed from a Visitor view — a link
 * that guard allows while its card is open, or one typed into the bar — whose
 * REFERER is a same-origin Visitor view of the project the `motir_visitor` cookie
 * names is redirected to that project's Visitor equivalent. A route with no
 * Visitor view (the account menu's settings, say) is not touched.
 */
function visitorLinkRedirect(request: NextRequest): NextResponse | null {
  const from = followedFromVisitorView(request);
  if (!from) return null;
  const target = visitorPathForMemberPath(
    from.identifier,
    request.nextUrl.pathname,
    request.nextUrl.search,
  );
  if (!target) return null;
  return NextResponse.redirect(new URL(target, request.url));
}

/**
 * Forget the Visitor's project on any other page (MOTIR-6648). The cookie is
 * sticky, and left set it would outlive the Visitor view it names and keep
 * steering member links back to it. So a real navigation to any member page clears it —
 * never a PREFETCH, which happens while the reader is still on the Visitor view.
 * (The data doors once read it too, which is why clearing it from another tab
 * broke a Visitor tab's reads; since MOTIR-6892 they read the per-tab
 * `x-motir-visitor` header instead, so this clear touches links only.)
 *
 * ⚠️ AND NEVER A REQUEST FOLLOWED FROM THE VISITOR VIEW ITSELF (MOTIR-6888).
 * `isPrefetch` cannot see a router prefetch on this Next: `next@16.2.6`'s adapter
 * deletes every flight header, `next-router-prefetch` included, from the request
 * before the proxy runs (`next/dist/server/web/adapter.js`, `FLIGHT_HEADERS`), and
 * strips the `_rsc` marker from its URL. So the Visitor page's own prefetch of a
 * member route with no Visitor view — the account menu's `/settings`, say — read
 * as a navigation, cleared the cookie while the reader was still reading, and
 * every data door and member link after it answered from the reader's OWN
 * project. A request whose Referer is a Visitor view of the cookie's project is
 * the Visitor tab talking — a prefetch, or the one click that leaves it — so it
 * keeps the cookie; the next member page, referred by a member page, clears it.
 */
function clearVisitorCookie(request: NextRequest, response: NextResponse): NextResponse {
  if (!request.cookies.has(VISITOR_COOKIE) || isPrefetch(request)) return response;
  if (followedFromVisitorView(request)) return response;
  response.cookies.set(VISITOR_COOKIE, '', { ...visitorCookieOptions(), maxAge: 0 });
  return response;
}

/**
 * Redirect a moved public surface to the public origin, or `null` when this
 * request is not one. Gated on the public origin being CONFIGURED: while
 * `MOTIR_PUBLIC_SITE_URL` is unset, `publicSiteOrigin()` falls back to THIS
 * origin and a redirect would loop — so nothing fires until the cutover card
 * points the public origin at `motir.co`.
 */
function publicSiteRedirect(request: NextRequest): NextResponse | null {
  if (publicSiteOrigin() === resolveBaseUrlTrimmed()) return null;
  if (isAppVisitorPath(request.nextUrl.pathname)) return null;
  const segment = request.nextUrl.pathname.split('/')[1] ?? '';
  if (!PUBLIC_REDIRECT_SEGMENTS.has(segment)) return null;
  const destination = new URL(
    request.nextUrl.pathname + request.nextUrl.search,
    publicSiteOrigin(),
  );
  return NextResponse.redirect(destination, 308);
}

/**
 * The PUBLIC READ SURFACE's cross-origin answer (MOTIR-4114 ·
 * `public-surface-hosts.md` AMENDMENT 4 §D).
 *
 * `motir.co` renders `/p/*` server-side, and a server-side fetch needs no CORS.
 * What needs it is every fetch the RENDERED PAGE then makes from the browser —
 * paging an items list, expanding a tree level, loading the next roadmap column,
 * subscribing by email. Handled here rather than in nine route files for one
 * reason: a route added later inherits it. A per-route header is a rule in a
 * comment, and `tests/api/public/cloud-gate-totality.test.ts` exists because
 * that is what happens to those.
 *
 * ⚠️ NO `Access-Control-Allow-Credentials`, EVER. Nothing reachable this way
 * requires a session, so the header set below is a convenience for the browser
 * rather than a trust boundary: such a request carries no cookie (`sameSite:
 * 'lax'` already guarantees that) and would be answered identically from
 * `curl`. `lib/publicProjects/cors.ts` carries the reasoning.
 *
 * An origin that is not the public site gets NO cors headers and an ordinary
 * response — the browser refuses it, which is where CORS is enforced. A caller
 * that sends no `Origin` at all (a crawler, a feed reader, `curl`) is untouched.
 */
async function publicSurfaceCors(request: NextRequest): Promise<NextResponse | null> {
  if (!request.nextUrl.pathname.startsWith('/api/public/')) return null;

  const allow = await publicCorsHeaders(request.headers.get('origin'));

  // A PREFLIGHT is answered here and goes no further: it is a question about
  // the NEXT request, so running it through a route handler would execute a
  // read nobody asked for.
  if (request.method === 'OPTIONS') {
    const headers = { ...(allow ?? {}), ...(allow ? publicCorsPreflightHeaders() : {}) };
    return new NextResponse(null, { status: 204, headers });
  }

  // ⚠️ AND IT ALWAYS TERMINATES, EVEN WITH NOTHING TO ALLOW. Returning `null`
  // here — "no cors headers needed, carry on" — drops the request into the
  // session bounce below, which 307s an ANONYMOUS API call to `/sign-in`. That
  // is every caller with no `Origin` header: `curl`, a crawler, a feed reader,
  // and `motir-marketing`'s own server-side fetches, which are how `motir.co`
  // renders in the first place. The matcher entry is for CORS and for nothing
  // else, so this branch owns every path under it.
  const response = NextResponse.next();
  for (const [name, value] of Object.entries(allow ?? {})) response.headers.set(name, value);
  return response;
}

/**
 * The OAuth discovery documents' answer (MOTIR-6982): `/.well-known/*` is public
 * metadata an MCP client reads before anyone has signed in, from any origin. So a
 * preflight is answered here, every other request is forwarded with the CORS
 * headers, and — like the public API above — it always TERMINATES: falling
 * through would bounce an anonymous discovery request to `/sign-in`.
 */
function wellKnownCors(request: NextRequest): NextResponse | null {
  if (!request.nextUrl.pathname.startsWith(WELL_KNOWN_PREFIX)) return null;
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: WELL_KNOWN_CORS_HEADERS });
  }
  const response = NextResponse.next();
  for (const [name, value] of Object.entries(WELL_KNOWN_CORS_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

export async function proxy(request: NextRequest) {
  // A PREVIEW HOST (MOTIR-5779) is not app.motir.co, and none of what follows
  // applies to it: it carries no Motir session, and its paths are the
  // preview's application's, not Motir's. So it is answered first, by the
  // member gate (`lib/preview/gateProxy.ts`, loaded only here so a request to
  // app.motir.co never imports the database client through it). The host is
  // checked against the CONFIGURED preview domain at call time, so a
  // deployment without previews never enters the branch.
  const previewHost = previewHostOf(request.headers.get('host'));
  if (previewHost) {
    const { previewHostResponse } = await import('@/lib/preview/gateProxy');
    return previewHostResponse(request, previewHost);
  }

  // OAuth discovery (MOTIR-6982) — before anything that could bounce it.
  const wellKnown = wellKnownCors(request);
  if (wellKnown) return wellKnown;

  // The public READ API's cross-origin answer (MOTIR-4114) — first, because a
  // preflight is answered here and never reaches a handler, and because these
  // paths are an API rather than a page: none of the page logic below applies
  // to them.
  const cors = await publicSurfaceCors(request);
  if (cors) return cors;

  // The moved public surfaces leave this application first (MOTIR-3884): they
  // are answered on motir.co now, so the session bounce below is not theirs.
  const moved = publicSiteRedirect(request);
  if (moved) return moved;

  // The Visitor's consent screen and live views are served HERE and are not
  // bounced (MOTIR-6648): their layout owns the not-found / sign-in order.
  const visitor = visitorSurface(request);
  if (visitor) return visitor;

  // The root `/` runs its own session handling in `app/page.tsx` (no session →
  // `/sign-in`, session → the landing) on every deployment (MOTIR-7819), and
  // while MOTIR_PUBLIC_SITE_URL is unset the moved surfaces are still served
  // HERE, where their deleted pages 404. None of them is a protected route, so
  // forward them untouched rather than bouncing a cookie-less request to
  // `/sign-in?next=…` (which would shadow the root's own contract and turn a
  // deleted page's 404 into a sign-in redirect).
  const segment = request.nextUrl.pathname.split('/')[1] ?? '';
  if (request.nextUrl.pathname === '/' || PUBLIC_REDIRECT_SEGMENTS.has(segment)) {
    return NextResponse.next();
  }

  // A member route followed from a Visitor view means that view's own path.
  const followed = visitorLinkRedirect(request);
  if (followed) return followed;

  const sessionCookie = getSessionCookie(request);
  if (!sessionCookie) {
    const signInUrl = new URL('/sign-in', request.url);
    // ⚠️ THE SEARCH STRING IS PART OF THE DESTINATION (MOTIR-4725). This used to
    // set the PATHNAME alone, which cost a filtered list its filter and — since
    // the planning workspace became an OVERLAY whose whole open state lives in
    // the query — costs a shared planner link the planner itself: a signed-out
    // reader following `/backlog?plan=project&planFrom=project` arrived at a bare
    // backlog with nothing to say what they had been sent to see. The value is
    // the same one the `x-current-path` header below carries for the signed-in
    // half of this function, and it stays a same-origin PATH, which is what
    // `sanitizeNextPath` (`lib/navigation/nextDestination.ts`) admits — a query
    // has always been legal in it (`/device?user_code=…` is the older instance).
    signInUrl.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`);
    return clearVisitorCookie(request, NextResponse.redirect(signInUrl));
  }

  // Forward the requested path to the layouts underneath (MOTIR-3652).
  //
  // `NextResponse.next({ request: { headers } })` is the version-sensitive API:
  // Next 16's `MiddlewareResponseInit.request.headers` overrides the headers the
  // downstream render sees, and it is still the only supported way to hand a
  // Server Component a per-request value the framework does not already expose.
  // Verified against the pinned `next@16.2.6`
  // (`next/dist/server/web/spec-extension/response.d.ts`), which offers no
  // first-class pathname accessor for a layout. If a future version ships one,
  // use it and delete this.
  //
  // The header is copied from the incoming request and then SET, so a
  // client-supplied `x-current-path` is overwritten rather than honoured.
  //
  // Search string included: a filtered list URL (`/items?status=open`) must
  // survive the round trip, or a visitor stopped on the way there is returned to
  // an unfiltered page.
  //
  // Set on the forwarded REQUEST only, never on the response — nothing about a
  // route's caching or revalidation behaviour changes.
  const headers = new Headers(request.headers);
  headers.set(CURRENT_PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return clearVisitorCookie(request, NextResponse.next({ request: { headers } }));
}

export const config = {
  // Every URL that maps to a page under `app/(authed)/`, plus the one other
  // signed-in route group, `(onboarding)`.
  //
  // ⚠️ `/planning` STAYS ON THIS LIST although its route group is gone
  // (MOTIR-4732). The workspace is an overlay now and `app/(authed)/planning`
  // holds only a FORWARD for old links — and that forward is exactly why the
  // entry matters: without it a cookie-less request to a bookmarked
  // `/planning?…` gets the segment's own gate instead of the
  // `/sign-in?next=/planning…` bounce this matcher exists to give it.
  //
  // ⚠️ THIS LIST IS GUARDED, NOT REMEMBERED (MOTIR-3652). It used to carry a
  // comment asking future authors to append each new authed route, and thirteen
  // of the sixteen `(authed)` segments were never added — which is what happens
  // to every rule that lives in a comment. `tests/navigation/proxy-matcher.test.ts`
  // now enumerates the segments from the filesystem and fails when one has no
  // entry here, so adding an authed segment without a matcher entry turns the
  // suite red.
  //
  // What the missing entries cost was never a security hole — the real gate is
  // `app/(authed)/layout.tsx`'s `getSession()` redirect, and it has always run
  // for all sixteen. They cost the cheap optimistic bounce, and (since this
  // card) the `x-current-path` header above, which is absent for any path the
  // matcher does not cover.
  //
  // ⚠️ `/admin` IS DELIBERATELY NOT HERE, and adding it would break a security
  // posture rather than tighten one (`docs/decisions/platform-staff-auth.md`
  // §2, MOTIR-2896). The redirect above is VISIBLY DIFFERENT from an unknown
  // path's 404, so a cookie-less request bounced to `/sign-in?next=/admin`
  // proves the route is real — which is exactly what the admin area's
  // 404-not-403 posture exists to prevent. An anonymous request must instead
  // reach `app/(admin)/layout.tsx` and be answered there by
  // `requirePlatformStaff()` with the ordinary 404. It costs nothing: that
  // layout makes the same session read every authed page already makes.
  matcher: [
    // The application root (MOTIR-7819) — forwarded untouched, so
    // `app/page.tsx` answers it by session. Then the MOVED public surfaces
    // (MOTIR-3884) — the proxy runs on them to 308 them onto motir.co. `/p/*` IS here: its move to motir.co was folded into
    // this redirect set (MOTIR-3877 renders the replacement; MOTIR-3951 deletes
    // the page here), so it must 308, not 404 — except the Visitor's consent
    // screen and views (MOTIR-6648), which the same entry reaches so that they
    // can be forwarded with their cookie instead.
    // The public READ API — matched for CORS only (MOTIR-4114). Everything
    // below this line is a PAGE and takes the session bounce; this one is an
    // API path and takes only the cross-origin answer, which `proxy()` handles
    // before any of it.
    '/api/public/:path*',
    // OAuth discovery (MOTIR-6982) — matched for CORS only, like the line above.
    '/.well-known/:path*',
    '/',
    '/explore/:path*',
    '/docs/:path*',
    '/legal/:path*',
    '/p/:path*',
    // The Approval records room (MOTIR-5302).
    '/approvals/:path*',
    '/backlog/:path*',
    '/boards/:path*',
    // The Codebase room (MOTIR-1768), and the address it absorbed — which still
    // needs the proxy, because a permanent redirect is served BY the route and
    // the route is behind this matcher.
    '/code/:path*',
    '/code-health/:path*',
    '/dashboard/:path*',
    '/direction/:path*',
    '/filters/:path*',
    '/invite/:path*',
    '/items/:path*',
    // My agents (MOTIR-6874).
    '/my-agents/:path*',
    // The no-project landing (MOTIR-6548).
    '/no-project/:path*',
    '/onboarding/:path*',
    // The page at its own address (MOTIR-7280).
    '/pages/:path*',
    '/planning/:path*',
    '/plans/:path*',
    '/ready/:path*',
    '/reports/:path*',
    '/roadmap/:path*',
    '/runs/:path*',
    '/settings/:path*',
    '/sprints/:path*',
    // The members' inbox (MOTIR-7043). `/requested-features` has no entry: it is
    // a `next.config` redirect onto this address, answered before the proxy.
    '/triage/:path*',
    '/workbench/:path*',
    // EVERY path on a PREVIEW HOST (MOTIR-5779) — `pr-<n>--<slug>.<domain>`,
    // `lib/preview/hostName.ts`. Conditioned on the host, so it adds no path on
    // app.motir.co: no Motir host's first label is `pr-<n>--…`. The pattern is a
    // literal because Next reads this object statically; `proxy()` still checks
    // the host against the configured domain before acting on it, and
    // `tests/preview/gateProxy.test.ts` pins this pattern to the host rule.
    {
      source: '/:path*',
      has: [{ type: 'host', value: 'pr-[1-9][0-9]*--[a-z0-9-]+\\..+' }],
    },
  ],
};
