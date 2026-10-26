// THE AGENT-RUN CAPACITY REASONS (MOTIR-9627) — why a model reads `no_capacity`.
//
// The picker read, the launch refusal and the picker's copy all key on these
// two values, so they live in one place.

/**
 * The agent lane has used its share of a limit. ⚠️ This is the exact value of
 * motir-gateway's exported `ReasonAgentShareExhausted` (`motir/capacity/refusal.go`,
 * MOTIR-9598). The gateway is reached over HTTP only, so core cannot import the
 * Go constant; `tests/hostedRuns/agentCapacityVerdict.test.ts` pins the value.
 */
export const AGENT_SHARE_EXHAUSTED = 'agent_share_exhausted';

/**
 * The provider is answering this model with 429s now. Core's own code: the
 * gateway exports no reason for provider rate limits.
 */
export const PROVIDER_RATE_LIMITED = 'provider_rate_limited';

export const AGENT_CAPACITY_REASONS = [AGENT_SHARE_EXHAUSTED, PROVIDER_RATE_LIMITED] as const;

export type AgentCapacityReason = (typeof AGENT_CAPACITY_REASONS)[number];
