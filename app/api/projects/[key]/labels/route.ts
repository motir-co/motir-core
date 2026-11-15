import { NextResponse } from 'next/server';
import { labelsService } from '@/lib/services/labelsService';
import { mapLabelError } from '@/lib/labels/errorResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// GET /api/projects/[key]/labels?q=<prefix> (Story 5.4 · Subtask 5.4.2) —
// the label-picker autocomplete: a case-insensitive prefix match over the
// project's labels, bounded (LABEL_SEARCH_LIMIT — finding #57). An empty /
// absent `q` lists the first window (opening the picker before typing, the
// Jira field's behaviour). `[key]` is the project identifier ("PROD"),
// resolved within the actor's workspace — a cross-tenant key reads as 404
// (no existence leak), as does a non-browsable project.
//
// `?ids=<id>,<id>` (Story MOTIR-10560 · Subtask MOTIR-11333) instead RESOLVES
// those label ids (`labelsService.resolveByIds`, the read `/boards` and `/items`
// make for a URL filter) — how the create-board dialog names the labels a copied
// saved filter references. An id that is not a label of the project is simply
// absent from the answer (the caller shows it as deleted). At most
// `LABEL_IDS_LIMIT` distinct ids; more is a 400. When `ids` is present, `q` is
// ignored.
//
// GET → 200 { labels: LabelDto[] }

/** The most label ids one `?ids=` read resolves (a filter holds at most 20
 * conditions; this bounds the read, finding #57). */
const LABEL_IDS_LIMIT = 100;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { key } = await params;
  const search = new URL(req.url).searchParams;
  const idsParam = search.get('ids');
  const ids =
    idsParam === null
      ? null
      : [...new Set(idsParam.split(',').map((id) => id.trim()))].filter(Boolean);
  if (ids && ids.length > LABEL_IDS_LIMIT) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: `At most ${LABEL_IDS_LIMIT} label ids per request.` },
      { status: 400 },
    );
  }
  const q = search.get('q') ?? '';

  try {
    const labels = ids
      ? await labelsService.resolveByIds(key, ids, ctx)
      : await labelsService.searchLabels(key, q, ctx);
    return NextResponse.json({ labels });
  } catch (err) {
    const mapped = mapLabelError(err);
    if (mapped) return mapped;
    throw err;
  }
}
