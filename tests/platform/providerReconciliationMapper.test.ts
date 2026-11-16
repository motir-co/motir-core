import { describe, expect, it } from 'vitest';
import { toProviderReconciliationDTO } from '@/lib/mappers/platformMappers';
import { PROVIDER_RECONCILIATION } from '../fixtures/motirAiContract/platformReads';

// motir-ai's provider-bill reconciliation → Usage & cost's DTO (MOTIR-11376). The
// page shows the route's figures, statuses and verdicts as given, so the mapper's
// whole contract is that nothing changes on the way through.

describe('toProviderReconciliationDTO', () => {
  it('carries every documented field through unchanged, field for field', () => {
    expect(toProviderReconciliationDTO(PROVIDER_RECONCILIATION)).toStrictEqual(
      PROVIDER_RECONCILIATION,
    );
  });

  it('keeps a missing bill null — never a zero — and leaves no field defaulted', () => {
    const dto = toProviderReconciliationDTO(PROVIDER_RECONCILIATION);
    const noRecord = dto.providers[0]!.days[1]!;
    expect(noRecord).toStrictEqual({
      day: '2026-09-02',
      recordedMicroUsd: null,
      billedMicroUsd: null,
      source: 'none',
      status: 'failed',
      readAt: null,
      gapMicroUsd: null,
      pastTolerance: false,
      perModel: [],
      estimatedRowCount: null,
    });
    expect(dto.providers[2]).toMatchObject({
      relativeTolerance: null,
      absoluteToleranceMicroUsd: null,
    });
    expect(dto.findings[1]).toMatchObject({ differingSide: null, estimatedRowCount: null });
  });

  it('copies rather than aliases, so the DTO cannot write back into the read', () => {
    const dto = toProviderReconciliationDTO(PROVIDER_RECONCILIATION);
    expect(dto.unreconciledProviders).not.toBe(PROVIDER_RECONCILIATION.unreconciledProviders);
    expect(dto.providers[0]!.days[0]!.perModel).not.toBe(
      PROVIDER_RECONCILIATION.providers[0]!.days[0]!.perModel,
    );
    expect(dto.findings[0]!.models).not.toBe(PROVIDER_RECONCILIATION.findings[0]!.models);
  });
});
