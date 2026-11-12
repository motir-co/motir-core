import type { components } from '../api/index.js';
import type { AgentRepositoryRole } from '../agentRun.js';

// THE ROLE LIST AGAINST THE WIRE (MOTIR-11055). `agentRun.ts` holds the roles as a
// domain list; this adapter is where the generated body schema may be seen (ADR
// cli-v1-client.md Q4), so the two are held equal here, both ways, at type-check time.

type WireRepositoryRole = components['schemas']['DispatchRunRepository']['repository']['role'];

type Unlisted = Exclude<WireRepositoryRole, AgentRepositoryRole>;
type Unknown = Exclude<AgentRepositoryRole, WireRepositoryRole>;

/** `true` only while the CLI's role list and the server's body schema agree exactly. */
export const ROLE_LIST_MATCHES_WIRE: [Unlisted | Unknown] extends [never]
  ? true
  : Unlisted | Unknown = true;
