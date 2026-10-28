import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import {
  environmentConfigErrorFor,
  environmentConfigErrorResponse,
  environmentNotFoundResponse,
} from '@/lib/environmentConfig/httpErrors';
import {
  parseEnvironmentParam,
  putEnvironmentEntryBody,
} from '@/lib/environmentConfig/requestSchema';
import { environmentConfigService } from '@/lib/services/environmentConfigService';

// One entry of a Motir repository's environment (Story MOTIR-9795 · MOTIR-9964).
//
// PUT    { value, isSecret } → 200 { outcome: 'created' | 'replaced', entry }
// DELETE                     → 204
//
// Writes need `repository:manage`; the service owns that gate and the
// customer-repository refusal, and this route only translates its typed errors.
// The response is the service's secret-free DTO, never the request body, and
// nothing from the body is logged or echoed into an error.

type Params = { params: Promise<{ rowId: string; environment: string; name: string }> };

export async function PUT(req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { rowId, environment: raw, name } = await params;
  const environment = parseEnvironmentParam(raw);
  if (!environment) return environmentNotFoundResponse();

  const parsed = putEnvironmentEntryBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return environmentConfigErrorResponse(
      400,
      'invalid_body',
      'The body must be { value: string, isSecret: boolean } and nothing else.',
    );
  }

  try {
    return NextResponse.json(
      await environmentConfigService.set(rowId, environment, { name, ...parsed.data }, ctx),
    );
  } catch (err) {
    const mapped = environmentConfigErrorFor(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function DELETE(_req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { rowId, environment: raw, name } = await params;
  const environment = parseEnvironmentParam(raw);
  if (!environment) return environmentNotFoundResponse();

  try {
    await environmentConfigService.delete(rowId, environment, name, ctx);
    return new Response(null, { status: 204 });
  } catch (err) {
    const mapped = environmentConfigErrorFor(err);
    if (mapped) return mapped;
    throw err;
  }
}
