import type { TenantHandoverAdvanceData } from '@/lib/services/tenantAccountHandoverService';
import { defineJob } from '../defineJob';

// ONE TURN OF AN AWS ACCOUNT'S TAKEOVER HANDOVER (Story MOTIR-9800 · MOTIR-12131).
// `tenantAccountHandoverService.advance` runs the next step not `done` under its
// step row's lease, records the outcome on the row, and enqueues this job again
// when the step finishes — so a handover walks itself, one step per run, and a
// run cut off anywhere is finished by the next.
//
// ⚠️ DEBOUNCED PER ACCOUNT, not keyed for idempotency: a person's answer and a
// finished step can enqueue the same account twice in a moment, and one run
// with the latest event is the right answer — the run reads the rows as they
// stand. The lease is what keeps two runs off one step.
//
// `retryPolicy: 'idempotent'`: a step's own failure is recorded on the step and
// never thrown, so what is retried is a database or transport failure around
// it, and every step looks before it acts.

export const hostingTenantHandoverAdvance = defineJob(
  {
    id: 'hosting.tenant-handover.advance',
    retryPolicy: 'idempotent',
    debounce: { key: 'event.data.tenantAccountId', period: '2s', timeout: '30s' },
  },
  async (ctx, services) => {
    const data = ctx.event.data as TenantHandoverAdvanceData;
    return ctx.step.run('advance-tenant-handover', () =>
      services.tenantAccountHandover.advance(data.tenantAccountId),
    );
  },
);
