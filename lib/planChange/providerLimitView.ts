import type { PlanSessionFailureDto } from '@/lib/dto/planChange';
import type { PlanStepProviderWaitDto } from '@/lib/dto/plans';

// THE PROVIDER LIMIT, AS THE OVERLAY SHOWS IT (Story MOTIR-9540 · MOTIR-9622; design
// `design/ai-chat/design-notes.md` § _The overlay when the model provider is at its limit_).
//
// Two moments, one precedence: a session WAITING to retry a provider 429 shows the retrying
// banner; a session whose retries were all refused carries the stored `rate_limited` failure,
// worded inside the failed face it already gets. Where both are present the FAILURE WINS — the
// banner is never drawn beside a failed face (MOTIR-9619's rule, kept here in one place).

export type ProviderLimitView = 'none' | 'retrying' | 'stopped';

export function providerLimitView(
  failure: Pick<PlanSessionFailureDto, 'reason'> | null | undefined,
  providerWait: PlanStepProviderWaitDto | null | undefined,
): ProviderLimitView {
  if (failure) return failure.reason === 'rate_limited' ? 'stopped' : 'none';
  return providerWait ? 'retrying' : 'none';
}
