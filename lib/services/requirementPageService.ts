import { motirSystemContext } from '@/lib/ai/serviceAuth';
import {
  renderRequirementMarkdown,
  requirementFallbackTitle,
  type RequirementPageLocale,
} from '@/lib/ai/requirementMarkdown';
import type { SubmittedRequirement } from '@/lib/ai/types';
import { FolderNameTakenError } from '@/lib/folders/errors';
import { PAGE_TITLE_MAX_LENGTH } from '@/lib/pages';
import { folderRepository } from '@/lib/repositories/folderRepository';
import { foldersService } from '@/lib/services/foldersService';
import { pagesService } from '@/lib/services/pagesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// THE REQUIREMENT PAGE WRITER (Story MOTIR-9430 · MOTIR-9433). A confirmed
// requirement becomes ONE page in the project's root-level "Requirements Docs"
// folder, written by the Motir system account, never by the person who confirmed.
//
// ── THE FOLDER ──────────────────────────────────────────────────────────────────────
// Found by its LABEL at the root, in either language, so a project never ends up with
// an en and a zh folder side by side; created when there is none. A folder that was
// renamed or moved is no longer found, and a new root-level one is made. Two confirms
// racing on an empty project both try to create it: the loser gets
// `FolderNameTakenError` from the `folder_sibling_name_key` index, reads again and uses
// the winner's folder.
//
// ── NOT HERE ──────────────────────────────────────────────────────────────────────
// Nothing reads or writes the plan offer. A retried confirm re-using a page it already
// wrote is the confirm's job: it records the returned `pageId`.

/** The folder's label per language. */
export const REQUIREMENTS_FOLDER_NAMES: Record<RequirementPageLocale, string> = {
  en: 'Requirements Docs',
  zh: '需求文档',
};

/** The page's title: the request text's first non-blank line, trimmed and capped. */
export function requirementPageTitle(requestMd: string, locale: RequirementPageLocale): string {
  const first = requestMd
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const title = first ?? requirementFallbackTitle(locale);
  return title.length <= PAGE_TITLE_MAX_LENGTH
    ? title
    : `${title.slice(0, PAGE_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

export interface WriteRequirementPageInput {
  /** TRUSTED: resolved from the person's own conversation, never from request input. */
  workspaceId: string;
  projectId: string;
  requirement: SubmittedRequirement;
  /** The offer's request text; the page is titled from it. */
  requestMd: string;
  /** The conversation's title, or its id when it has none. */
  conversationLabel: string;
  /** When the requirement was confirmed. */
  at: Date;
  locale: RequirementPageLocale;
}

export interface WrittenRequirementPage {
  pageId: string;
  folderId: string;
  title: string;
}

async function findFolder(
  ctx: { userId: string; workspaceId: string },
  projectId: string,
  locale: RequirementPageLocale,
): Promise<string | null> {
  const labels = Object.values(REQUIREMENTS_FOLDER_NAMES);
  const found = await withWorkspaceContext({ ...ctx, projectId }, (tx) =>
    folderRepository.findRootByNames(
      projectId,
      labels.map((l) => l.toLowerCase()),
      tx,
    ),
  );
  if (found.length === 0) return null;
  // The folder in the call's own language wins when both exist; else the oldest.
  const own = REQUIREMENTS_FOLDER_NAMES[locale].toLowerCase();
  return (found.find((f) => f.name.toLowerCase() === own) ?? found[0]!).id;
}

async function findOrCreateFolder(
  ctx: { userId: string; workspaceId: string },
  projectId: string,
  locale: RequirementPageLocale,
): Promise<string> {
  const existing = await findFolder(ctx, projectId, locale);
  if (existing) return existing;
  try {
    const created = await foldersService.createFolder(
      { projectId, parentFolderId: null, name: REQUIREMENTS_FOLDER_NAMES[locale] },
      ctx,
    );
    return created.id;
  } catch (err) {
    if (!(err instanceof FolderNameTakenError)) throw err;
    // A concurrent confirm created it first: use the winner's.
    const winner = await findFolder(ctx, projectId, locale);
    if (winner) return winner;
    throw err;
  }
}

export const requirementPageService = {
  /**
   * Write the requirement as one page in the project's Requirements Docs folder, as
   * the Motir system account. `SystemPrincipalNotProvisionedError` is thrown before
   * anything is written. A page write that fails is rethrown unchanged, leaving at
   * most the folder behind, which the next confirm reuses.
   */
  async write(input: WriteRequirementPageInput): Promise<WrittenRequirementPage> {
    const ctx = await motirSystemContext(input.workspaceId);
    const folderId = await findOrCreateFolder(ctx, input.projectId, input.locale);
    const title = requirementPageTitle(input.requestMd, input.locale);
    const page = await pagesService.createPageFromMarkdown(ctx, {
      projectId: input.projectId,
      title,
      markdown: renderRequirementMarkdown(input.requirement, {
        locale: input.locale,
        conversationLabel: input.conversationLabel,
        at: input.at,
      }),
      parent: { kind: 'folder', id: folderId },
    });
    return { pageId: page.id, folderId, title };
  },
};
