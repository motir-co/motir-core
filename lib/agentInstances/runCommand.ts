import type { DispatchCommand } from '@/generated/prisma/client';

// THE COMMANDS A PERSON'S OWN AGENT CAN BE ASKED FOR (Story MOTIR-8981 ·
// MOTIR-9045). A run in an agent records the `DispatchCommand` it opened as; the
// caller's vocabulary is the narrow extraction of the four a person (or the
// auto-fix path) can ask for. `run_scope` stays chosen server-side for a parent
// card, and `next` / `batch` / `auto` are not opened in an agent.
//
// `review` (Story MOTIR-11941 · MOTIR-11945) is opened ONLY through the Review in
// my agent door, which supplies what is reviewed — the gate and the version. A
// `review` asked for anywhere else has no review target and is refused
// (`AgentRunReviewTargetRequiredError`).
//
// ONE AUTHORITY for the type and the guard: the type is taken from the generated
// enum, and the tuple the guard iterates is checked against it, so a member
// added to the tuple cannot disagree with the type.

export type AgentRunCommand = Extract<DispatchCommand, 'run' | 'fix' | 'continue' | 'review'>;

export const AGENT_RUN_COMMANDS = [
  'run',
  'fix',
  'continue',
  'review',
] as const satisfies readonly AgentRunCommand[];

/** What a start without a `command` opens (a parent card opens `run_scope` instead). */
export const DEFAULT_AGENT_RUN_COMMAND: AgentRunCommand = 'run';

export function isAgentRunCommand(value: unknown): value is AgentRunCommand {
  return typeof value === 'string' && (AGENT_RUN_COMMANDS as readonly string[]).includes(value);
}
