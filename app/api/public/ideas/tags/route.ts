import { NextResponse } from 'next/server';
import type { PublicIdeaTagListDto } from '@/lib/dto/ideas';
import { IdeasUnavailableError } from '@/lib/ideas/errors';
import {
  PUBLIC_IDEAS_CACHE_CONTROL,
  PUBLIC_IDEAS_RETRY_AFTER_SECONDS,
} from '@/lib/ideas/publicCache';
import { publicIdeaLocaleCode, resolvePublicIdeaLocale } from '@/lib/ideas/publicLocale';
import { publicSurfaceUnavailable } from '@/lib/publicProjects/cloudGate';
import { ideasPublicService } from '@/lib/services/ideasPublicService';

// GET /api/public/ideas/tags (Story MOTIR-7662 · MOTIR-7676) — every tag carried
// by at least one ACTIVE idea, with that count: the facet behind motir.co's tag
// filter. Anonymous (no session call), cacheable, pure transport. `?locale=`
// from the query only (MOTIR-7775); an unsupported value is answered in English.
// A lost database connection is a handled 503 with `Retry-After` (MOTIR-8350).

export async function GET(req: Request): Promise<NextResponse> {
  const absent = publicSurfaceUnavailable();
  if (absent) return absent;

  const locale = resolvePublicIdeaLocale(new URL(req.url).searchParams.get('locale'));
  try {
    const tags = await ideasPublicService.listTags(locale);
    const body: PublicIdeaTagListDto = { tags, locale: publicIdeaLocaleCode(locale) };
    return NextResponse.json(body, { headers: { 'Cache-Control': PUBLIC_IDEAS_CACHE_CONTROL } });
  } catch (err) {
    if (err instanceof IdeasUnavailableError) {
      return NextResponse.json(
        { code: err.code },
        { status: 503, headers: { 'Retry-After': String(PUBLIC_IDEAS_RETRY_AFTER_SECONDS) } },
      );
    }
    throw err;
  }
}
