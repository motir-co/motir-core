import type { PlannabilityDto } from '@/lib/dto/plannability';

// Client read of the Plan button's pre-check (MOTIR-10544) from
// `GET /api/work-items/plannability?key=` — can this card be planned, and if not,
// why? The CLIENT half, beside `planningAnchorClient.ts`; a consumer calls this,
// never the route path.
//
// Unlike the anchor read, EVERY non-2xx throws, a 404 included: the button only
// exists on a card the reader can see, so a 404 here means the card went away or
// the session changed under it — and the design's answer to any check that could
// not be answered is the same one, the check-failed toast with Retry. The overlay
// never opens on a failed check (design MOTIR-10543 § "Check failed").

export async function fetchPlannability(
  key: string,
  signal?: AbortSignal,
): Promise<PlannabilityDto> {
  const res = await fetch(`/api/work-items/plannability?key=${encodeURIComponent(key)}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal,
  });
  if (!res.ok) {
    throw new Error(`Plannability check failed (${res.status})`);
  }
  const body = (await res.json()) as Partial<PlannabilityDto>;
  // An answer that cannot be acted on is a failed check, never a guess: a
  // refusal with no reason to show would open an empty alert, and reading a
  // malformed body as plannable would open the overlay the check exists to hold.
  if (typeof body.plannable !== 'boolean' || !Array.isArray(body.reasons)) {
    throw new Error('Plannability check answered an unreadable body');
  }
  if (body.reasons.length > 0) return { plannable: false, reasons: body.reasons };
  if (!body.plannable) throw new Error('Plannability check refused with no reason');
  return { plannable: true, reasons: [] };
}
