import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import {
  environmentConfigErrorFor,
  environmentNotFoundResponse,
} from '@/lib/environmentConfig/httpErrors';
import { parseEnvironmentParam } from '@/lib/environmentConfig/requestSchema';
import { environmentConfigService } from '@/lib/services/environmentConfigService';

// The recent changes to a Motir repository's environment, newest first (Story
// MOTIR-9795 · MOTIR-9964) — name, action and the secret flag, never a value.
//
// GET → 200 EnvironmentChangeDto[]. Open to anyone who can browse the project.

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ rowId: string; environment: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { rowId, environment: raw } = await params;
  const environment = parseEnvironmentParam(raw);
  if (!environment) return environmentNotFoundResponse();

  try {
    return NextResponse.json(await environmentConfigService.listChanges(rowId, environment, ctx));
  } catch (err) {
    const mapped = environmentConfigErrorFor(err);
    if (mapped) return mapped;
    throw err;
  }
}
