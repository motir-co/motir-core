import { NextResponse, type NextRequest } from 'next/server';
import { signFunctionUrlRequest } from '@motir/orchestrator';
import {
  GATE_COOKIE,
  PREVIEW_AUTH_PATH,
  PREVIEW_GATE_PAGE_PATH,
  PREVIEW_UNSUPPORTED_PATH,
  UNFORWARDED_REQUEST_HEADERS,
  UNSUPPORTED_STATUS,
  gateCookieOptions,
  gateSigningKey,
  isNavigation,
  isUnsupportedKind,
  safeReturnPath,
  stripMotirCookies,
  unsupportedRequest,
  verifyGatePass,
  type GateUnsupported,
} from '@/lib/preview/gate';
import { PreviewHostingNotConfiguredError } from '@/lib/preview/errors';
import {
  previewAccessUrl,
  previewGateService,
  type PreviewUpstream,
} from '@/lib/services/previewGateService';

// THE PREVIEW HOST's answer (Story MOTIR-5766 · Subtask MOTIR-5779), reached from
// `proxy.ts` for every request whose host is a preview's. Loaded lazily, so a
// request to app.motir.co never imports the database client through it.
//
//   /__motir/preview-auth?token=…   consume the admission, set the gate cookie
//   no valid gate cookie            → app.motir.co/preview-access (303)
//   ready, with an address          → forwarded to the release (§5)
//   anything else                   → rewritten to the preview-gate page, which
//                                     re-derives the state from Host + cookie
//
// ⚠️ THE FORWARD IS NEXT'S OWN EXTERNAL REWRITE for an origin-secret (Fly) or
// credential-less release: `NextResponse.rewrite(<upstream URL>, { request:
// { headers } })`. That path streams both bodies, keeps the router's flight
// headers (which the adapter strips from what this function sees and re-applies
// only to an overridden header set — `next/dist/server/web/adapter.js`), and
// forwards the `_rsc` marker, so a Next app under preview keeps its client
// navigation. A SigV4 release (a Lambda function URL) cannot take that path: its
// signature covers the payload, so the body is buffered (≤ 6 MB, §5), signed and
// fetched here, and the response is relayed.

/** The sentence a script reads for each refusal — `messages/en.json`'s
 *  `previewGate.unsupported.*`, pinned by `tests/preview/gateProxy.test.ts`. */
export const UNSUPPORTED_SENTENCE: Record<GateUnsupported, string> = {
  websocket:
    "Live connections (websockets) don't pass through the preview gate. The rest of the preview works as usual.",
  tooLarge: "Requests larger than 10 MB can't be sent to a preview.",
  noLength: "This request didn't say how large it is, so the preview gate can't accept it.",
};

function plain(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(`${body}\n`, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

/** The page the gate's own answers (the five states, Panel 6b) render through. */
function pageRewrite(request: NextRequest, search: Record<string, string> = {}): NextResponse {
  const url = new URL(PREVIEW_GATE_PAGE_PATH, request.url);
  for (const [name, value] of Object.entries(search)) url.searchParams.set(name, value);
  return NextResponse.rewrite(url, { headers: { 'cache-control': 'no-store' } });
}

/**
 * §5's refusal. A browser navigating gets the status AND the Panel 6b page:
 * an App Router page cannot answer 413, so the body is a document that sends
 * the browser on to the page. Anything else gets the status with the sentence.
 */
export function unsupportedResponse(request: Request, kind: GateUnsupported): Response {
  const status = UNSUPPORTED_STATUS[kind];
  if (!isNavigation(request.headers)) return plain(status, UNSUPPORTED_SENTENCE[kind]);
  const page = `${PREVIEW_UNSUPPORTED_PATH}?kind=${kind}`;
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${page}">` +
      `<title>${UNSUPPORTED_SENTENCE[kind]}</title><p>${UNSUPPORTED_SENTENCE[kind]} ` +
      `<a href="${page}">Continue</a></p>\n`,
    {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    },
  );
}

/** The request headers the release receives: the viewer's, minus hop-by-hop
 *  headers and Motir's cookies, plus the release's origin credential. */
export function forwardedHeaders(
  request: Request,
  host: string,
  upstream: PreviewUpstream,
): Headers {
  const headers = new Headers(request.headers);
  for (const name of UNFORWARDED_REQUEST_HEADERS) headers.delete(name);
  const cookie = stripMotirCookies(request.headers.get('cookie'));
  if (cookie) headers.set('cookie', cookie);
  else headers.delete('cookie');
  headers.set('x-forwarded-host', host);
  headers.set('x-forwarded-proto', 'https');
  for (const [name, value] of Object.entries(upstream.headers)) headers.set(name, value);
  return headers;
}

/** Response headers a relayed (fetched) answer may not carry: hop-by-hop, and
 *  the framing `fetch` has already undone (it decodes the body). */
const UNRELAYED_RESPONSE_HEADERS = [
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
];

/** Relay a fetched answer, rewriting a redirect onto the release's own address
 *  back onto the preview host. */
export function relay(response: Response, host: string, upstreamOrigin: string): Response {
  const headers = new Headers();
  response.headers.forEach((value, name) => {
    if (name === 'set-cookie' || UNRELAYED_RESPONSE_HEADERS.includes(name)) return;
    headers.set(name, value);
  });
  for (const cookie of response.headers.getSetCookie()) headers.append('set-cookie', cookie);
  const location = headers.get('location');
  if (location?.startsWith(upstreamOrigin)) {
    headers.set('location', `https://${host}${location.slice(upstreamOrigin.length) || '/'}`);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function forward(
  request: NextRequest,
  host: string,
  upstream: PreviewUpstream,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const target = new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, upstream.origin);
  const headers = forwardedHeaders(request, host, upstream);
  if (upstream.credential !== 'aws_sigv4') {
    return NextResponse.rewrite(target, { request: { headers } });
  }
  const method = request.method.toUpperCase();
  const body =
    method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(await request.arrayBuffer());
  const signed = await signFunctionUrlRequest(target.toString(), {
    method,
    ...(body ? { body } : {}),
  });
  for (const [name, value] of Object.entries(signed.headers)) headers.set(name, value);
  headers.delete('host');
  const response = await fetchImpl(target, {
    method,
    headers,
    ...(body ? { body } : {}),
    redirect: 'manual',
  });
  return relay(response, host, upstream.origin);
}

async function consume(request: NextRequest, host: string): Promise<Response> {
  const params = request.nextUrl.searchParams;
  const result = await previewGateService.consumeAdmission(params.get('token'), host);
  // A refused admission — replayed, for another host, expired or tampered —
  // gets the page with NO cookie: it renders as Not found, because the viewer
  // holds no pass for this host and the page says nothing it cannot know.
  if (!result.ok) return pageRewrite(request);
  const response = NextResponse.redirect(
    new URL(safeReturnPath(params.get('return')), `https://${host}`),
    303,
  );
  response.cookies.set(GATE_COOKIE, result.cookie, gateCookieOptions());
  response.headers.set('cache-control', 'no-store');
  return response;
}

/** The preview host's answer to one request. */
export async function previewHostResponse(
  request: NextRequest,
  host: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  try {
    return await answer(request, host, fetchImpl);
  } catch (error) {
    if (error instanceof PreviewHostingNotConfiguredError) {
      return plain(503, 'Previews are not available on this deployment.');
    }
    throw error;
  }
}

async function answer(request: NextRequest, host: string, fetchImpl: typeof fetch) {
  const { pathname, search } = request.nextUrl;
  if (pathname === PREVIEW_AUTH_PATH) return consume(request, host);

  const pass = verifyGatePass(request.cookies.get(GATE_COOKIE)?.value, host, gateSigningKey());
  if (!pass) {
    // ALWAYS, whatever the host holds — a live row, a closed one or none — so
    // the preview host never says whether a preview exists before the gate
    // knows who is asking. 303 so a refused POST is not replayed at the gate.
    return NextResponse.redirect(previewAccessUrl(host, `${pathname}${search}`), 303);
  }

  if (pathname === PREVIEW_UNSUPPORTED_PATH) {
    const kind = request.nextUrl.searchParams.get('kind');
    return pageRewrite(request, isUnsupportedKind(kind) ? { unsupported: kind } : {});
  }

  const route = await previewGateService.route(host);
  if (!route || route.state !== 'ready' || !route.upstream || !route.target) {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return plain(503, 'This preview is not running.', { 'retry-after': '10' });
    }
    return pageRewrite(request);
  }

  const unsupported = unsupportedRequest(request.method, request.headers, route.target);
  if (unsupported) return unsupportedResponse(request, unsupported);
  return forward(request, host, route.upstream, fetchImpl);
}
