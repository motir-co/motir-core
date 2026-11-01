// The deterministic names of a hosted application's units (MOTIR-5769 §4): the
// app `<prefix><rid>` for production and `<prefix><rid>-pr<n>` per preview, and
// the push namespaces `<prefix><rid>` / `<prefix><rid>-pv`. Every target uses the
// same names, so they live beside the port rather than in one adapter.

import { HostingAppNameInvalidError } from './errors';
import type { HostingApp, HostingEnvironment, PushNamespaceKind } from './types';

const DNS_LABEL = /^[a-z0-9][a-z0-9-]{0,62}$/;

function checked(name: string): string {
  if (!DNS_LABEL.test(name) || name.endsWith('-')) throw new HostingAppNameInvalidError(name);
  return name;
}

/** The push namespace of a repository's previews (shared by every pull request)
 *  or of its production: `<prefix><rid>-pv` / `<prefix><rid>`. */
export function pushNamespaceName(
  prefix: string,
  repositoryId: string,
  kind: PushNamespaceKind,
): string {
  const base = `${prefix}${repositoryId}`;
  return checked(kind === 'production' ? base : `${base}-pv`);
}

/** The app and push namespace for one (repository, environment). */
export function hostingAppNames(
  prefix: string,
  repositoryId: string,
  environment: HostingEnvironment,
): HostingApp {
  const base = `${prefix}${repositoryId}`;
  if (environment.kind === 'production') {
    const name = checked(base);
    return { appRef: name, pushNamespace: name };
  }
  if (!Number.isInteger(environment.pullRequest) || environment.pullRequest < 1) {
    throw new HostingAppNameInvalidError(`${base}-pr${environment.pullRequest}`);
  }
  return {
    appRef: checked(`${base}-pr${environment.pullRequest}`),
    pushNamespace: pushNamespaceName(prefix, repositoryId, 'preview'),
  };
}

/** Whether two environments are the same one. */
export function sameEnvironment(a: HostingEnvironment, b: HostingEnvironment): boolean {
  if (a.kind === 'production' || b.kind === 'production') return a.kind === b.kind;
  return a.pullRequest === b.pullRequest;
}
