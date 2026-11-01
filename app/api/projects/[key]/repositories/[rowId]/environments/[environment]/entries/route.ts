import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import {
  environmentConfigErrorFor,
  environmentNotFoundResponse,
} from '@/lib/environmentConfig/httpErrors';
import { parseEnvironmentParam } from '@/lib/environmentConfig/requestSchema';
import { environmentConfigService } from '@/lib/services/environmentConfigService';

// A Motir repository's entries for one environment (Story MOTIR-9795 · MOTIR-9964).
//
// GET → 200 EnvironmentEntryDto[] — a secret carries its name, `isSecret: true`
// and a null value. Open to anyone who can browse the project.

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
    return NextResponse.json(await environmentConfigService.list(rowId, environment, ctx));
  } catch (err) {
    const mapped = environmentConfigErrorFor(err);
    if (mapped) return mapped;
    throw err;
  }
}
