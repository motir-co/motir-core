import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  RepoProvisioningApiError,
  RepoProvisioningNotConfiguredError,
} from '@/lib/github/repoProvisioning';
import { MissingAuditReasonError, NotPlatformStaffError } from '@/lib/platform/errors';
import {
  SeedEntryIsDefaultError,
  SeedPromotionManifestRefusedError,
  SeedPromotionRefNotFoundError,
  SeedPromotionSourceRefusedError,
  SeedPromotionTemplateNameTakenError,
  SeedRegistryEntryNotFoundError,
  SeedRegistryInvalidFieldError,
  SeedRegistryKeyTakenError,
} from './errors';

/**
 * The operator SEED REGISTRY routes' transport (Story MOTIR-704 · MOTIR-710):
 * the two bodies they parse and one error map, total over what the gate and
 * `seedRegistryPromotionService` throw. An error it does not know is re-thrown,
 * so Next answers 500 and the defect stays visible.
 *
 * A caller without operator standing gets the console's NOT-FOUND, never a 403
 * (`docs/decisions/platform-staff-auth.md` §2): the routes do not tell a tenant
 * user that a staff surface exists.
 */

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function seedRegistryJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

const reason = z.string().trim().min(1, 'a reason is required').max(1000);

export const promoteBodySchema = z
  .object({
    sourceRowId: z.string().min(1),
    ref: z.string().trim().min(1).max(255),
    key: z.string(),
    role: z.string(),
    stack: z.string(),
    label: z.string(),
    useCases: z.array(z.string()),
    sizes: z.array(z.string()),
    hostingTargets: z.array(z.string()),
    reason,
  })
  .strict();

export const retireBodySchema = z.object({ reason }).strict();

/** A malformed request, before any service is called. */
class BadSeedRegistryRequest extends Error {
  constructor(readonly issues: { path: string; message: string }[]) {
    super('Invalid request');
  }
}

/** Parse a JSON body against `schema`, or throw the 400 the map renders. */
export async function parseSeedRegistryBody<S extends z.ZodType>(
  req: Request,
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new BadSeedRegistryRequest([{ path: '', message: 'body must be JSON' }]);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new BadSeedRegistryRequest(
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return parsed.data;
}

/** Map a thrown error to its response, or re-throw it. */
export function seedRegistryErrorResponse(err: unknown): NextResponse {
  if (err instanceof NotPlatformStaffError) return seedRegistryJson({ code: 'NOT_FOUND' }, 404);
  if (err instanceof BadSeedRegistryRequest) {
    return seedRegistryJson({ code: 'INVALID_REQUEST', issues: err.issues }, 400);
  }
  if (err instanceof MissingAuditReasonError) {
    return seedRegistryJson({ code: 'REASON_REQUIRED', error: err.message }, 422);
  }
  if (err instanceof SeedRegistryEntryNotFoundError) {
    return seedRegistryJson({ code: err.code, error: err.message }, 404);
  }
  if (err instanceof SeedPromotionSourceRefusedError) {
    return seedRegistryJson(
      { code: err.code, refusal: err.refusal, error: err.message },
      err.refusal === 'not_found' ? 404 : 422,
    );
  }
  if (err instanceof SeedPromotionManifestRefusedError) {
    return seedRegistryJson(
      {
        code: err.code,
        refusal: err.refusal,
        file: err.file,
        field: err.field,
        target: err.target,
        reason: err.reason,
        declared: err.declared,
        error: err.message,
      },
      422,
    );
  }
  if (err instanceof SeedRegistryInvalidFieldError) {
    return seedRegistryJson(
      { code: err.code, field: err.field, value: err.value, error: err.message },
      422,
    );
  }
  if (err instanceof SeedPromotionRefNotFoundError) {
    return seedRegistryJson({ code: err.code, error: err.message }, 422);
  }
  if (
    err instanceof SeedRegistryKeyTakenError ||
    err instanceof SeedPromotionTemplateNameTakenError ||
    err instanceof SeedEntryIsDefaultError
  ) {
    return seedRegistryJson({ code: err.code, error: err.message }, 409);
  }
  if (err instanceof RepoProvisioningNotConfiguredError) {
    return seedRegistryJson({ code: err.code, error: err.message }, 503);
  }
  if (err instanceof RepoProvisioningApiError) {
    return seedRegistryJson({ code: err.code, error: err.message }, 502);
  }
  throw err;
}
