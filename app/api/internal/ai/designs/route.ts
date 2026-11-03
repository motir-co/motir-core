import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { designAccessService } from '@/lib/services/designAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// GET /api/internal/ai/designs[?pathPrefix=…&query=…&cursor=…&limit=N]
// GET /api/internal/ai/designs?key=<design card key>
// (MOTIR-10239) — the planner's read of the project's APPROVED designs: a page of
// them, newest first, or one design card's verdict with short-lived links to its
// files. The same `designAccessService` calls `list_designs` and `get_design`
// (MCP) make, so nothing here decides which version of a design counts.
//
// The project is the TOKEN's (`auth.projectId`); no caller-supplied project
// exists. A `key` that resolves to a card of any OTHER project — the same
// workspace's or another tenant's — is answered as not found, never read.
//
// ⚠️ IT ANSWERS 200 WITH A NAMED OUTCOME, `repo-file`'s convention: the consumer
// is a model, so "that card does not exist / you cannot see it" is an ANSWER
// (`not_found`), and an empty page is `ok` with no designs. Only a malformed
// parameter (400 `validation_error`) and a failed credential (401) keep a 4xx.
//
// ⚠️ LINKS ARE MINTED ONLY ON THE SINGLE-CARD READ. A presign lives 300 seconds,
// so a list that minted one per asset would hand back links that lapse before the
// caller decides to fetch — `lib/mcp/tools/listDesigns.ts`'s reason.

const MAX_LIMIT = 100;
/** The largest card key number: the service compares its cursor against an Int column. */
const MAX_CURSOR = 2_147_483_647;
const NOT_FOUND = { result: { outcome: 'not_found' } } as const;

function invalid(error: string): Response {
  return NextResponse.json({ code: 'validation_error', error }, { status: 400 });
}

/** The absences the design service raises, which this route answers as `not_found`. */
function isAbsence(err: unknown): boolean {
  return (
    err instanceof WorkItemNotFoundError ||
    err instanceof ProjectNotFoundError ||
    (err instanceof ProjectAccessDeniedError && err.kind === 'browse')
  );
}

/** The project a design card key names, or null when the key resolves to none the actor sees. */
async function projectIdOfKey(
  key: string,
  ctx: Parameters<typeof projectsService.getByKey>[1],
): Promise<string | null> {
  const dash = key.lastIndexOf('-');
  if (dash <= 0) return null;
  const project = await projectsService.getByKey(key.slice(0, dash), ctx).catch((err: unknown) => {
    if (isAbsence(err)) return null;
    throw err;
  });
  return project?.id ?? null;
}

export async function GET(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await authenticateAndLimitJobRequest(req);
  } catch (err) {
    const failure = mapJobRequestError(err);
    if (failure) return failure;
    throw err;
  }

  const params = new URL(req.url).searchParams;
  const key = params.get('key');
  const rawLimit = params.get('limit');
  if (key !== null && !key.trim()) return invalid('key must not be blank');
  const cursor = params.get('cursor');
  // The service's cursor is the last key NUMBER it read; anything else is the caller's to fix.
  if (cursor !== null && (!/^[0-9]+$/.test(cursor) || Number(cursor) > MAX_CURSOR))
    return invalid('cursor is not one this route issued');
  let limit: number | undefined;
  if (rawLimit !== null) {
    limit = /^[0-9]+$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return invalid(`limit must be an integer from 1 to ${MAX_LIMIT}`);
    }
  }

  try {
    if (key !== null) {
      const designCardKey = key.trim().toUpperCase();
      // The token's project only — another project's card is not found, not read.
      if ((await projectIdOfKey(designCardKey, auth.ctx)) !== auth.projectId) {
        return NextResponse.json(NOT_FOUND);
      }
      const verdict = await designAccessService.getApprovedDesign(designCardKey, auth.ctx);
      if (verdict.verdict !== 'approved') {
        return NextResponse.json({ result: { outcome: 'ok', ...verdict } });
      }
      const links = await designAccessService.downloadLinks(verdict.design.evidenceId, auth.ctx);
      const bySourcePath = new Map(links.map((link) => [link.sourcePath, link]));
      const design = {
        ...verdict.design,
        assets: verdict.design.assets.map((asset) => {
          const link = asset.state === 'available' ? bySourcePath.get(asset.sourcePath) : undefined;
          return link ? { ...asset, url: link.url, expiresAt: link.expiresAt } : asset;
        }),
      };
      return NextResponse.json({ result: { outcome: 'ok', ...verdict, design } });
    }

    const project = await projectsService.assertProjectInWorkspace(
      auth.projectId,
      auth.ctx.workspaceId,
    );
    const page = await designAccessService.listApprovedDesigns(
      project.identifier,
      {
        ...(params.get('pathPrefix') ? { pathPrefix: params.get('pathPrefix')! } : {}),
        ...(params.get('query') ? { query: params.get('query')! } : {}),
        ...(cursor ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
      },
      auth.ctx,
    );
    return NextResponse.json({ result: { outcome: 'ok', ...page } });
  } catch (err) {
    if (isAbsence(err)) return NextResponse.json(NOT_FOUND);
    throw err;
  }
}
