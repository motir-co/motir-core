import { NextResponse } from 'next/server';
import type { PageCommentAnchorInput } from '@/lib/pages';

// The page-comment routes' INPUT parsing (Story MOTIR-10866 · MOTIR-10873):
// shape only, never a rule. A request that is not the shape a route takes is a
// route-level 400 `BAD_REQUEST`, as `PATCH /api/pages/[pageId]` refuses a
// non-string title; what is in a well-shaped field (a blank body, empty anchor
// bytes) is the package's to refuse.

/** A parsed body, or the 400 to answer instead. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; response: NextResponse };

export function badRequest(error: string): NextResponse {
  return NextResponse.json({ code: 'BAD_REQUEST', error }, { status: 400 });
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Standard base64 to bytes; `null` when it is not base64. */
export function decodeBase64(text: string): Uint8Array | null {
  if (!BASE64.test(text)) return null;
  return new Uint8Array(Buffer.from(text, 'base64'));
}

async function readObject(req: Request): Promise<Parsed<Record<string, unknown>>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { ok: false, response: badRequest('Expected JSON.') };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, response: badRequest('Expected a JSON object.') };
  }
  return { ok: true, value: body as Record<string, unknown> };
}

function bodyMdOf(body: Record<string, unknown>): Parsed<string> {
  return typeof body.bodyMd === 'string'
    ? { ok: true, value: body.bodyMd }
    : { ok: false, response: badRequest('Expected a string `bodyMd`.') };
}

/** `{ bodyMd, anchor? }` — a new thread; the anchor's bytes arrive as base64. */
export async function parseCreateBody(
  req: Request,
): Promise<Parsed<{ bodyMd: string; anchor?: PageCommentAnchorInput }>> {
  const read = await readObject(req);
  if (!read.ok) return read;
  const bodyMd = bodyMdOf(read.value);
  if (!bodyMd.ok) return bodyMd;
  const raw = read.value.anchor;
  if (raw === undefined || raw === null) return { ok: true, value: { bodyMd: bodyMd.value } };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, response: badRequest('Expected `anchor` to be `{ bytes, quote }`.') };
  }
  const { bytes, quote } = raw as Record<string, unknown>;
  if (typeof bytes !== 'string' || typeof quote !== 'string') {
    return {
      ok: false,
      response: badRequest('Expected `anchor.bytes` (base64) and `anchor.quote` to be strings.'),
    };
  }
  const decoded = decodeBase64(bytes);
  if (decoded === null) {
    return { ok: false, response: badRequest('Expected `anchor.bytes` to be base64.') };
  }
  return { ok: true, value: { bodyMd: bodyMd.value, anchor: { bytes: decoded, quote } } };
}

/** `{ bodyMd }` — a reply or an edit. A reply sits where its thread does, so `anchor` is refused. */
export async function parseBodyOnly(req: Request): Promise<Parsed<{ bodyMd: string }>> {
  const read = await readObject(req);
  if (!read.ok) return read;
  if (read.value.anchor !== undefined) {
    return { ok: false, response: badRequest('Only a new thread can carry an `anchor`.') };
  }
  const bodyMd = bodyMdOf(read.value);
  if (!bodyMd.ok) return bodyMd;
  return { ok: true, value: { bodyMd: bodyMd.value } };
}

export function noActiveProject(): NextResponse {
  return NextResponse.json(
    { code: 'NO_ACTIVE_PROJECT', error: 'No active project.' },
    { status: 400 },
  );
}
