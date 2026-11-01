import { describe, expect, it } from 'vitest';
import { JOBS_SYSTEM_READ_ROLE, JOBS_SYSTEM_REPLAY_ROLE } from '@/lib/jobs/platformStanding';

// MOTIR-8197 — the two platform-staff levels the job ledger asks for, named in
// ONE place. The request-scoped resolver this suite also covered served only
// the tenant dashboard's System tab and replay, and was deleted with them
// (Story MOTIR-9982 · MOTIR-10044); its retired-env-var case moved to
// `tests/platform/platformStaffGate.test.ts`, against the gate /admin/jobs uses.

describe('the two levels', () => {
  it('reads the ledger at support and replays at operator', () => {
    expect(JOBS_SYSTEM_READ_ROLE).toBe('support');
    expect(JOBS_SYSTEM_REPLAY_ROLE).toBe('operator');
  });
});
