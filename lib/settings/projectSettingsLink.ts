import { PROJECT_SETTINGS_ROOT } from '@/lib/settings/projectSettingsNav';

// A PROJECT-SETTINGS LINK MAY NAME ITS PROJECT (Bug MOTIR-12169).
//
// Every `/settings/project/*` page acts on the reader's ACTIVE project. A link
// that is ABOUT a project — a notification row whose subject is a project (a
// refused code access, a crashed production app) — may reach a reader whose
// active project is another one, and opening the active project's room then
// shows the wrong project or answers 404. So such a link carries the project's
// key as `?project=<KEY>`, and the settings area layout switches to it — the
// same switch the project switcher makes, with the same access check — before
// the room renders.
//
// This module is the one spelling of that parameter on both ends: the link side
// builds hrefs with `projectSettingsHref`, and the layout reads them back with
// `readProjectSettingsLink`. Pure: no IO, so both ends are testable without a
// request.

/** The query parameter a project-settings link names its project with. */
export const PROJECT_LINK_PARAM = 'project';

/** A path inside the project-settings area, e.g. `/settings/project/code-access`. */
export type ProjectSettingsPath =
  | typeof PROJECT_SETTINGS_ROOT
  | `${typeof PROJECT_SETTINGS_ROOT}/${string}`;

/**
 * The href of a project-settings room FOR a named project: `path`, the room's own
 * query `params` in the order given, and the project's key last. The key is
 * what lets the room open on that project whatever the reader's active one is.
 */
export function projectSettingsHref(
  path: ProjectSettingsPath,
  projectKey: string,
  params: Record<string, string> = {},
): string {
  const query = new URLSearchParams(params);
  query.set(PROJECT_LINK_PARAM, projectKey);
  return `${path}?${query.toString()}`;
}

/** A project-settings request that names a project, read back from its path. */
export interface ProjectSettingsLink {
  /** The key the link names, trimmed — matched case-insensitively and alias-aware by the resolver. */
  projectKey: string;
  /** The same room WITHOUT the project parameter: where the reader lands once switched. */
  href: string;
}

// Any origin works: it only lets `URL` parse a relative path, and a path that
// carries its own scheme or host resolves AWAY from it and is refused below.
const BASE = 'https://placeholder.invalid';

/**
 * Read the project a project-settings request names, from the request's path
 * and query as the proxy forwards it (`x-current-path`).
 *
 * Returns `null` — "this request names no project, act on the active one" — for
 * a missing path, a path outside the settings area, an absolute or
 * protocol-relative URL, or a missing or blank `project` parameter.
 *
 * ⚠️ The returned `href` becomes a navigation target, and the path it comes from
 * is client-forgeable (`proxy.ts`, `CURRENT_PATH_HEADER`). So it is rebuilt from
 * the PARSED pathname and query, never echoed, and only a same-origin path
 * inside `/settings/project` is ever answered — anything else is `null`, which
 * navigates nowhere.
 */
export function readProjectSettingsLink(currentPath: string | null): ProjectSettingsLink | null {
  if (!currentPath || !currentPath.startsWith('/') || currentPath.startsWith('//')) return null;

  let url: URL;
  try {
    url = new URL(currentPath, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  const { pathname } = url;
  if (pathname !== PROJECT_SETTINGS_ROOT && !pathname.startsWith(`${PROJECT_SETTINGS_ROOT}/`)) {
    return null;
  }

  const projectKey = url.searchParams.get(PROJECT_LINK_PARAM)?.trim();
  if (!projectKey) return null;

  url.searchParams.delete(PROJECT_LINK_PARAM);
  const query = url.searchParams.toString();
  return { projectKey, href: query ? `${pathname}?${query}` : pathname };
}
