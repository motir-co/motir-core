import { NextResponse } from 'next/server';
import { requirePlatformStaff } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { platformCapacityService } from '@/lib/services/platformCapacityService';

// The CAPACITY screen's poll (Story MOTIR-9539 · MOTIR-9613). Transport only.
//
// ⚠️ THE SESSION GATE, NEVER `ideasGate`: a bearer token alone does not reach
// this route. A caller who is not staff gets the console's not-found
// (`docs/decisions/platform-staff-auth.md` §2) and no capacity data.

const NO_STORE = { 'Cache-Control': 'no-store' };

/** The screen's view model, fresh on every poll. Any staff role. */
export async function GET() {
  try {
    const principal = await requirePlatformStaff('support');
    return NextResponse.json(await platformCapacityService.getView(principal), {
      headers: NO_STORE,
    });
  } catch (err) {
    if (err instanceof NotPlatformStaffError) {
      return NextResponse.json({ code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE });
    }
    throw err;
  }
}
