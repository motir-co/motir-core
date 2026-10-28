// Wire validation for the environment-configuration routes (Story MOTIR-9795 ·
// MOTIR-9964): the `[environment]` path segment and the strict `PUT` body.
import { z } from 'zod';
import { isEnvironmentName, type EnvironmentName } from './vocabulary';

/** The `PUT …/entries/[name]` body. The name comes from the path, so it cannot
 *  disagree with the body; unknown keys are refused. */
export const putEnvironmentEntryBody = z
  .object({
    value: z.string(),
    isSecret: z.boolean(),
  })
  .strict();

export type PutEnvironmentEntryBody = z.infer<typeof putEnvironmentEntryBody>;

/** The `[environment]` segment, or null when it is not one of `ENVIRONMENTS`. */
export function parseEnvironmentParam(value: string): EnvironmentName | null {
  return isEnvironmentName(value) ? value : null;
}
