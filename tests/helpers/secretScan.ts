// THE NO-SECRET SCAN (Story MOTIR-9362 · MOTIR-9464) — one helper the pool-growth
// integration gate and the story's E2E walk share. A test gathers every sink it
// can reach (stored rows, audit rows, alerts, captured log lines, printed
// command output) and asks what, if anything, carries a seeded secret or a
// field named for a credential.

const CREDENTIAL_KEY = /secret|token|password|accesskey|privatekey|credentials?$/i;

/** Every object key, at any depth, named for a credential. */
export function credentialKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) credentialKeys(item, found);
  } else if (value && typeof value === 'object' && !(value instanceof Date)) {
    for (const [key, inner] of Object.entries(value)) {
      if (CREDENTIAL_KEY.test(key)) found.push(key);
      credentialKeys(inner, found);
    }
  }
  return found;
}

/** One line per leak: a sink carrying a seeded secret or a credential-named
 *  field. Empty when every sink is clean. */
export function findSecrets(
  sinks: ReadonlyArray<readonly [string, unknown]>,
  secrets: readonly string[],
): string[] {
  const leaks: string[] = [];
  for (const [sink, value] of sinks) {
    const text = JSON.stringify(value);
    for (const secret of secrets) {
      if (text.includes(secret)) leaks.push(`${sink} carries ${secret}`);
    }
    for (const key of credentialKeys(value)) leaks.push(`${sink} has a field named ${key}`);
  }
  return leaks;
}
