import { NextResponse } from 'next/server';
import { projectsService } from '@/lib/services/projectsService';
import { approvalGateSettingsService } from '@/lib/services/approvalGateSettingsService';
import {
  InvalidReviewAgentSourceError,
  PermissionDeniedError,
  ProjectNotFoundError,
  ReviewAgentNeedsManualMergeError,
} from '@/lib/projects/errors';
import {
  REVIEW_AGENT_SOURCES,
  type ReviewAgentSourceValue,
  type UpdateApprovalGateSettingsInput,
} from '@/lib/dto/approvalGateSettings';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// GET / PATCH /api/projects/[key]/approval-gates (Story MOTIR-4925 · Subtask
// MOTIR-5170) — read or admin-update which APPROVAL GATES this project raises.
//
// The project is addressed by its workspace-unique `key` (the `MOTIR`-style
// identifier), the convention every other project route uses, resolved through
// `projectsService.getByKey` which tenant- and access-gates it (a missing or
// unbrowsable project is a 404, never a 403 — no existence leak). Thin HTTP
// transport per CLAUDE.md: resolve, one service call, map typed errors.
//
// The authority is `workflow:manage` on BOTH verbs, because the room is MANAGE-ONLY
// (`docs/decisions/permission-inventory.md` R65; MOTIR-5394 reverted MOTIR-5278's
// browse-level read). It is asserted in the service rather than here: this route
// is reachable by URL whether or not the rail offers its row, which is the whole
// reason the destination guard exists one layer up.
//
// Typed errors → status codes:
//   ProjectNotFoundError    → 404  (no such project, or not a browser)
//   PermissionDeniedError   → 403  (either verb — lacks `workflow:manage`)
//   ReviewAgentNeedsManualMergeError → 409  (PATCH — review agent ON in an `auto` project, ADR §12.2a)

interface RouteParams {
  params: Promise<{ key: string }>;
}

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;
  const { key } = await params;

  try {
    const project = await projectsService.getByKey(key, ctx);
    const settings = await approvalGateSettingsService.getSettings(project.id, ctx);
    return NextResponse.json(settings);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof PermissionDeniedError) {
      return NextResponse.json(
        { code: err.code, error: err.message, permission: err.permission },
        { status: 403 },
      );
    }
    throw err;
  }
}

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;
  const { key } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  // Forward only the keys the body actually carried, so an absent switch is
  // "unchanged" rather than "false". A boolean is validated here because it is a
  // SHAPE question the transport can answer; anything about authority or meaning
  // belongs to the service.
  const raw = (body ?? {}) as Record<string, unknown>;
  const patch: UpdateApprovalGateSettingsInput = {};
  if ('acceptanceVideoEnabled' in raw) {
    if (typeof raw.acceptanceVideoEnabled !== 'boolean') {
      return NextResponse.json(
        { code: 'BAD_REQUEST', error: '`acceptanceVideoEnabled` must be a boolean.' },
        { status: 400 },
      );
    }
    patch.acceptanceVideoEnabled = raw.acceptanceVideoEnabled;
  }
  if ('reviewAgentEnabled' in raw) {
    if (typeof raw.reviewAgentEnabled !== 'boolean') {
      return NextResponse.json(
        { code: 'BAD_REQUEST', error: '`reviewAgentEnabled` must be a boolean.' },
        { status: 400 },
      );
    }
    patch.reviewAgentEnabled = raw.reviewAgentEnabled;
  }
  if ('designApprovalGate' in raw) {
    if (typeof raw.designApprovalGate !== 'boolean') {
      return NextResponse.json(
        { code: 'BAD_REQUEST', error: '`designApprovalGate` must be a boolean.' },
        { status: 400 },
      );
    }
    patch.designApprovalGate = raw.designApprovalGate;
  }
  if ('reviewAgentSource' in raw) {
    const source = raw.reviewAgentSource;
    if (
      typeof source !== 'string' ||
      !(REVIEW_AGENT_SOURCES as readonly string[]).includes(source)
    ) {
      return NextResponse.json(
        { code: 'BAD_REQUEST', error: '`reviewAgentSource` must be "hosted" or "own".' },
        { status: 400 },
      );
    }
    patch.reviewAgentSource = source as ReviewAgentSourceValue;
  }
  if ('reviewBotPostsEnabled' in raw) {
    if (typeof raw.reviewBotPostsEnabled !== 'boolean') {
      return NextResponse.json(
        { code: 'BAD_REQUEST', error: '`reviewBotPostsEnabled` must be a boolean.' },
        { status: 400 },
      );
    }
    patch.reviewBotPostsEnabled = raw.reviewBotPostsEnabled;
  }

  try {
    const project = await projectsService.getByKey(key, ctx);
    const settings = await approvalGateSettingsService.updateSettings(project.id, patch, ctx);
    return NextResponse.json(settings);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof ReviewAgentNeedsManualMergeError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    /* v8 ignore next 3 -- the transport refuses a bad source first; this is the service's own guard */
    if (err instanceof InvalidReviewAgentSourceError) {
      return NextResponse.json({ code: 'BAD_REQUEST', error: err.message }, { status: 400 });
    }
    if (err instanceof PermissionDeniedError) {
      return NextResponse.json(
        { code: err.code, error: err.message, permission: err.permission },
        { status: 403 },
      );
    }
    throw err;
  }
}
