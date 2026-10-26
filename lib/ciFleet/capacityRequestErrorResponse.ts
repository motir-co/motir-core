import { NextResponse } from 'next/server';
import {
  FleetCapacityRequestNotFoundError,
  FleetCapacityRequestNotOwnedError,
  FleetCapacityRequestOpenError,
  FleetPoolValueInvalidError,
} from '@/lib/ciFleet/errors';

// Typed-error → HTTP-status mapper for the org admin's Request more capacity
// route (Story MOTIR-9368 · MOTIR-9662). The dialog switches on `code` (and
// `field` / `requestId`). ⚠️ NEVER `err.message`: these errors are built with the
// AWS account id and the shard id, neither of which a tenant may see — so each
// body is `{ code }` plus only the fields named here. Returns null for anything
// else, so the route rethrows a real 500.
export function mapFleetCapacityRequestError(err: unknown): NextResponse | null {
  if (err instanceof FleetPoolValueInvalidError) {
    return NextResponse.json({ code: err.code, field: err.field }, { status: 400 });
  }
  if (err instanceof FleetCapacityRequestNotOwnedError) {
    return NextResponse.json({ code: err.code }, { status: 404 });
  }
  if (err instanceof FleetCapacityRequestOpenError) {
    return NextResponse.json({ code: err.code, requestId: err.activeRequestId }, { status: 409 });
  }
  if (err instanceof FleetCapacityRequestNotFoundError) {
    return NextResponse.json({ code: err.code }, { status: 404 });
  }
  return null;
}
