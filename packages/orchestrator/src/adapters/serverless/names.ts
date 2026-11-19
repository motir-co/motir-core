import { HostingAppNameInvalidError } from '../../hosting/errors';
import { hostingAppNames } from '../../hosting/names';
import type { HostingEnvironment } from '../../hosting/types';

// The serverless account's names for one hosted unit (MOTIR-5769 §4), built on
// the shared `hostingAppNames` so the function is the port's `appRef`: function
// `mh-<rid>` for production and `mh-<rid>-pr<n>` per preview; ECR repositories
// `mh/<rid>/production` and `mh/<rid>/preview` (every preview of a repository
// shares one, never production's); the GitHub-OIDC push role per repository;
// the overflow secret; and the tags the adapter keeps its state in.
//
// ⚠️ EVERY ECR REPOSITORY LIVES UNDER THE FIXED `mh/` ROOT, whatever the app
// prefix. The scoped role grants ECR writes on `repository/mh/*` only (MOTIR-9970),
// and that grant is the security boundary. A prefix that extends `mh-` — the
// deploy check's `mh-deploy-check-` — carries its extension into the repository
// segment (`mh/deploy-check-<rid>/production`), never into the root, which would
// put it outside the grant (MOTIR-11829).

export type ServerlessNamespaceKind = 'preview' | 'production';

/** The tags on a release function. The adapter holds no store: the previous
 *  version and the creation time live here, on the provider. */
export const SERVERLESS_TAGS = {
  marker: 'motir:hosting',
  environment: 'motir:environment',
  createdAt: 'motir:created-at',
  previousVersion: 'motir:previous-version',
} as const;

/** The alias every request reaches; a deploy or rollback moves only it. */
export const SERVERLESS_LIVE_ALIAS = 'live';

/** The shared execution role the scoped role may pass (MOTIR-9970). */
export const SERVERLESS_EXEC_ROLE = 'mh-shared-exec';

function kindOf(environment: HostingEnvironment): ServerlessNamespaceKind {
  return environment.kind === 'production' ? 'production' : 'preview';
}

/** The ECR root every serverless repository sits under: the scoped role's
 *  `repository/mh/*` grant (MOTIR-9970). Never derived from the app prefix. */
export const SERVERLESS_ECR_ROOT = 'mh';

/** Strip `char` from both ends. Loops, not `/^-+|-+$/`, which is quadratic on a
 *  long run of dashes (CodeQL). */
function trimChar(value: string, char: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === char) start += 1;
  while (end > start && value[end - 1] === char) end -= 1;
  return value.slice(start, end);
}

/** What the prefix adds past the `mh` root, without its dashes: `mh-` → `''`,
 *  `mh-deploy-check-` → `deploy-check`. A prefix that does not start at the root
 *  is carried whole (`acme-` → `acme`), so its repositories stay under it too. */
function prefixExtension(prefix: string): string {
  const root = SERVERLESS_ECR_ROOT;
  const rest =
    prefix === root || prefix.startsWith(`${root}-`) ? prefix.slice(root.length) : prefix;
  return trimChar(rest, '-');
}

/** The ECR repository's middle segment for one repository id: the id itself
 *  under the plain `mh-` prefix, `<extension>-<rid>` under an extended one. */
function repositorySegment(prefix: string, repositoryId: string): string {
  const extension = prefixExtension(prefix);
  return extension ? `${extension}-${repositoryId}` : repositoryId;
}

export interface ServerlessAppNames {
  readonly appRef: string;
  /** The ECR repository CI pushes to. */
  readonly pushNamespace: string;
}

/** The ECR repository one push namespace kind of a repository pushes to. */
export function serverlessPushNamespace(
  prefix: string,
  repositoryId: string,
  kind: ServerlessNamespaceKind,
): string {
  return `${SERVERLESS_ECR_ROOT}/${repositorySegment(prefix, repositoryId)}/${kind}`;
}

export function serverlessAppNames(
  prefix: string,
  repositoryId: string,
  environment: HostingEnvironment,
): ServerlessAppNames {
  const { appRef } = hostingAppNames(prefix, repositoryId, environment);
  return {
    appRef,
    pushNamespace: serverlessPushNamespace(prefix, repositoryId, kindOf(environment)),
  };
}

/** The repository and namespace kind an ECR repository name was built from,
 *  under this prefix — or null for a name that is not one of its repositories. */
export function namespaceOf(
  prefix: string,
  pushNamespace: string,
): { repositoryId: string; kind: ServerlessNamespaceKind } | null {
  const match = /^([a-z0-9-]+)\/([a-z0-9-]+)\/(preview|production)$/.exec(pushNamespace);
  if (!match || match[1] !== SERVERLESS_ECR_ROOT) return null;
  const extension = prefixExtension(prefix);
  const segment = match[2]!;
  const lead = extension ? `${extension}-` : '';
  if (!segment.startsWith(lead) || segment.length === lead.length) return null;
  return { repositoryId: segment.slice(lead.length), kind: match[3] as ServerlessNamespaceKind };
}

/** The (repository, environment) a function name was built from, or null for a
 *  name that is not one of this prefix's units. */
export function unitOf(
  prefix: string,
  appRef: string,
): { repositoryId: string; environment: HostingEnvironment } | null {
  if (!appRef.startsWith(prefix)) return null;
  const rest = appRef.slice(prefix.length);
  const preview = /^(.+)-pr(\d+)$/.exec(rest);
  if (preview) {
    return {
      repositoryId: preview[1]!,
      environment: { kind: 'preview', pullRequest: Number(preview[2]) },
    };
  }
  return rest ? { repositoryId: rest, environment: { kind: 'production' } } : null;
}

/** The GitHub-OIDC role that may push to one ECR repository (MOTIR-5769 §4). */
export function pushRoleArn(accountId: string, prefix: string, pushNamespace: string): string {
  const namespace = namespaceOf(prefix, pushNamespace);
  if (!namespace) throw new HostingAppNameInvalidError(pushNamespace);
  return `arn:aws:iam::${accountId}:role/${prefix}${namespace.repositoryId}-${namespace.kind}-push`;
}

/** The secret a function's environment overflows to. The app ref already
 *  carries the `mh-` prefix the execution role may read. */
export function overflowSecretName(appRef: string): string {
  return appRef;
}

/** The log group Lambda writes a function's logs to. */
export function logGroupName(appRef: string): string {
  return `/aws/lambda/${appRef}`;
}

export function execRoleArn(accountId: string): string {
  return `arn:aws:iam::${accountId}:role/${SERVERLESS_EXEC_ROLE}`;
}

export function environmentLabel(environment: HostingEnvironment): string {
  return environment.kind === 'production' ? 'production' : `pr-${environment.pullRequest}`;
}

export function environmentOfLabel(label: string | undefined): HostingEnvironment {
  const match = /^pr-(\d+)$/.exec(label ?? '');
  return match ? { kind: 'preview', pullRequest: Number(match[1]) } : { kind: 'production' };
}
