import { NextResponse } from 'next/server';
import { ReviewFindingsNotFoundError } from '@/lib/agentReview/errors';
import { normalizeWorkItemKey, projectKeyOfWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import type { ReviewFindingsRefDto } from '@/lib/dto/agentReview';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { projectsService } from '@/lib/services/projectsService';
import { reviewFindingsService } from '@/lib/services/reviewFindingsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// GET /api/work-items/[id]/review-findings?kind=record|gate&id=<id> — `[id]` is the card's
// KEY here (the segment keeps the name its siblings use, which Next requires) (MOTIR-10460;
// `design/workbench/design-notes.md` § 42). The SESSION read behind the in-place view
// *Findings and checklist* opens over the Workbench: one review of one card, its whole
// findings and its stored checklist rows.
//
// Answers 200 with the review; 404 `REVIEW_FINDINGS_NOT_FOUND` for a card the reader cannot
// see, in this workspace or another, AND for a review that is not that card's — one answer,
// so the read never tells a reader that a card or a review exists; 422 `INVALID_QUERY`.
//
// Thin HTTP layer (CLAUDE.md § 4-layer): session gate → ONE service call → map errors.

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function json(status: number, body: unknown): Response {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function refOf(url: URL): ReviewFindingsRefDto | null {
  const kind = url.searchParams.get('kind');
  const id = url.searchParams.get('id')?.trim();
  if (!id || (kind !== 'record' && kind !== 'gate')) return null;
  return { kind, id };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;

  const ref = refOf(new URL(req.url));
  if (!ref) {
    return json(422, {
      code: 'INVALID_QUERY',
      error: 'kind (record or gate) and id are required.',
    });
  }

  const { id } = await params;
  const identifier = normalizeWorkItemKey(id);
  try {
    const project = await projectsService.getByKey(projectKeyOfWorkItemKey(identifier), gate.ctx);
    return json(200, await reviewFindingsService.read(project.id, identifier, ref, gate.ctx));
  } catch (err) {
    if (
      err instanceof ProjectNotFoundError ||
      err instanceof WorkItemNotFoundError ||
      err instanceof ProjectAccessDeniedError ||
      err instanceof ReviewFindingsNotFoundError
    ) {
      return json(404, { code: 'REVIEW_FINDINGS_NOT_FOUND', error: 'Not found.' });
    }
    throw err;
  }
}
