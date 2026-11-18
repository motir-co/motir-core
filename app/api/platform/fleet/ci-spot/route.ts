import { NextResponse } from 'next/server';
import { z } from 'zod';
import { InvalidCiSpotInstanceTypesError } from '@/lib/ciFleet/errors';
import { requirePlatformStaff } from '@/lib/platform/auth';
import { MissingAuditReasonError, NotPlatformStaffError } from '@/lib/platform/errors';
import { ciSpotSettingService } from '@/lib/services/ciSpotSettingService';

// THE CI SPOT SETTING (MOTIR-11725) — whether CI runners on an AWS pool account
// launch as Spot, and the ordered instance types a launch may walk. Transport
// only. There is no console screen: this route is the only door, called from a
// signed-in console session.
//
// ⚠️ THE SESSION GATE, NEVER A TOKEN GATE: a bearer token alone does not reach
// this route. A caller who is not a `superadmin` gets the console's not-found
// (`docs/decisions/platform-staff-auth.md` §2) and nothing about the setting.
//
//   GET → 200 the stored state
//   PUT { enabled, instanceTypes, reason } → 200 { outcome, state }
//   400 { code: 'INVALID_BODY' } — not JSON, or a field of the wrong shape
//   400 { code: 'MISSING_AUDIT_REASON' } — a blank reason
//   400 { code: 'INVALID_CI_SPOT_INSTANCE_TYPES', rule, instanceType } — an
//       empty list, a duplicate, or a type outside the allowlist
//   404 { code: 'NOT_FOUND' } — not a `superadmin`

const NO_STORE = { 'Cache-Control': 'no-store' };

const putBodySchema = z.object({
  enabled: z.boolean(),
  instanceTypes: z.array(z.string()),
  reason: z.string(),
});

function notFound() {
  return NextResponse.json({ code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE });
}

/** The stored setting. `superadmin` only. */
export async function GET() {
  try {
    const principal = await requirePlatformStaff('superadmin');
    return NextResponse.json(await ciSpotSettingService.getState(principal), {
      headers: NO_STORE,
    });
  } catch (err) {
    if (err instanceof NotPlatformStaffError) return notFound();
    throw err;
  }
}

/** Save the setting, with a reason. `superadmin` only. */
export async function PUT(req: Request) {
  try {
    const principal = await requirePlatformStaff('superadmin');
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ code: 'INVALID_BODY' }, { status: 400, headers: NO_STORE });
    }
    const parsed = putBodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ code: 'INVALID_BODY' }, { status: 400, headers: NO_STORE });
    }
    const { enabled, instanceTypes, reason } = parsed.data;
    return NextResponse.json(
      await ciSpotSettingService.save(principal, { enabled, instanceTypes }, reason),
      { headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof NotPlatformStaffError) return notFound();
    if (err instanceof MissingAuditReasonError) {
      return NextResponse.json({ code: err.code }, { status: 400, headers: NO_STORE });
    }
    if (err instanceof InvalidCiSpotInstanceTypesError) {
      return NextResponse.json(
        { code: err.code, rule: err.rule, instanceType: err.instanceType },
        { status: 400, headers: NO_STORE },
      );
    }
    throw err;
  }
}
