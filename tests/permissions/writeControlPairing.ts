import type { PermissionKey } from '@/lib/permissions/catalog';

// MOTIR-6176 — the PAIRING the write-control guard (`writeControlGuard.test.ts`)
// holds the app to: every function exported from a `'use server'` file under
// `app/(authed)`, with the gate its SERVICE applies. It is read off the service,
// never off the UI; `docs/permissions/ui-gating-inventory.md` (MOTIR-6172) is
// where each row was measured, with file:line evidence.
//
// ⚠️ A NEW server action FAILS the guard until it is paired here. That is the
// whole mechanism: whoever adds a write has to say, in this file, which key its
// service asserts — and once it is paired, every client control that calls it
// has to read a capability before it may enable itself.

/** How a server action is gated on the SERVER. */
export type ActionGate =
  /** The service asserts this project permission key. */
  | { kind: 'key'; key: PermissionKey }
  /**
   * The service asserts a WORKSPACE or ORG role rather than a project key.
   * `workspace:inviter` is whoever may invite (a Manager, or a Full member), with
   * a Limited invitation kept to a Manager (MOTIR-6546's scope rules).
   */
  | { kind: 'role'; role: 'org:owner-or-admin' | 'workspace:manager' | 'workspace:inviter' }
  /** A READ. Its page's own gate decides who reaches it; nothing to enable. */
  | { kind: 'read' }
  /** Acts on the actor's OWN account or membership — there is no right to lack. */
  | { kind: 'self'; reason: string }
  /**
   * The server asserts LESS than it should, and a bug card carries the fix. The
   * client control is still held to the rule: it must read a capability or be
   * exempted naming the same card.
   */
  | { kind: 'known-gap'; card: `MOTIR-${number}`; reason: string };

const EDIT: ActionGate = { kind: 'key', key: 'work_item:edit' };
const READ: ActionGate = { kind: 'read' };

/** `<path under app/(authed)>#<export>` → its gate. */
export const SERVER_ACTION_GATES: Record<string, ActionGate> = {
  // ── the app shell ──────────────────────────────────────────────────────────
  '_account-deletion-actions.ts#cancelAccountDeletionAction': {
    kind: 'self',
    reason: 'the actor’s own scheduled deletion',
  },
  '_account-deletion-actions.ts#scheduleAccountDeletionAction': {
    kind: 'self',
    reason: 'the actor’s own account',
  },
  '_actions.ts#createOrganizationAction': {
    kind: 'self',
    reason: 'any signed-in account may found an organization',
  },
  '_actions.ts#createWorkspaceAction': {
    kind: 'self',
    reason: 'org membership only today; the org-Admin gate is MOTIR-6309’s',
  },
  '_actions.ts#switchOrganizationAction': { kind: 'self', reason: 'the actor’s own active org' },
  '_actions.ts#switchWorkspaceAction': { kind: 'self', reason: 'the actor’s own active workspace' },
  '_project-actions.ts#archiveProjectAction': { kind: 'key', key: 'project:administer' },
  '_project-actions.ts#createProjectAction': {
    kind: 'self',
    reason: 'workspace membership creates a project (no project exists to hold a key yet)',
  },
  '_project-actions.ts#setActiveProjectAction': {
    kind: 'known-gap',
    card: 'MOTIR-6319',
    reason: 'pins a project with no `project:browse` check',
  },
  '_project-actions.ts#startNewAiProjectAction': {
    kind: 'self',
    reason: 'workspace membership starts a new project',
  },

  // ── the work item page ─────────────────────────────────────────────────────
  'items/[key]/acceptanceActions.ts#turnOnAcceptanceVideoAction': {
    kind: 'key',
    key: 'workflow:manage',
  },
  'items/[key]/actions.ts#createLinkAction': EDIT,
  'items/[key]/actions.ts#linkMonitorIssueAction': EDIT,
  'items/[key]/actions.ts#linkPullRequestAction': {
    kind: 'known-gap',
    card: 'MOTIR-6318',
    reason: 'the service asserts no key; the MCP arm asserts `work_item:edit`',
  },
  'items/[key]/actions.ts#listLinkCandidatesAction': READ,
  'items/[key]/actions.ts#listPullRequestCandidatesAction': READ,
  'items/[key]/actions.ts#loadHowToTestDraftAction': EDIT,
  'items/[key]/actions.ts#removeLinkAction': EDIT,
  'items/[key]/actions.ts#saveHowToTestAction': EDIT,
  'items/[key]/actions.ts#searchMonitorIssuesAction': EDIT,
  'items/[key]/actions.ts#unlinkMonitorIssueAction': EDIT,
  'items/[key]/actions.ts#unlinkPullRequestAction': {
    kind: 'known-gap',
    card: 'MOTIR-6318',
    reason: 'the service asserts no key; the MCP arm asserts `work_item:edit`',
  },
  // Gate decisions: `work_item:edit` is the floor; the gate's own authority
  // (assignee / reporter / `approval:decide_any`) is decided per record.
  'items/[key]/approvalGateActions.ts#approveAndMergeAction': EDIT,
  'items/[key]/approvalGateActions.ts#decideApprovalGateAction': EDIT,
  'items/[key]/approvalGateActions.ts#queueAgainAutoAction': EDIT,
  'items/[key]/approvalGateActions.ts#retryApproveAndMergeMemberAction': EDIT,
  'items/[key]/commentActions.ts#addCommentAction': { kind: 'key', key: 'comment:add' },
  // Own comment: the author; anyone's: `comment:moderate`.
  'items/[key]/commentActions.ts#deleteCommentAction': { kind: 'key', key: 'comment:moderate' },
  'items/[key]/commentActions.ts#editCommentAction': { kind: 'key', key: 'comment:moderate' },
  'items/[key]/customFieldActions.ts#setCustomFieldValueAction': EDIT,
  'items/[key]/edit/actions.ts#changeStatusAction': EDIT,
  'items/[key]/edit/actions.ts#fileWorkItemAction': EDIT,
  'items/[key]/edit/actions.ts#getWorkItemPlacementAction': READ,
  'items/[key]/edit/actions.ts#updateIssueAction': EDIT,
  'items/[key]/labelComponentActions.ts#addComponentAction': EDIT,
  'items/[key]/labelComponentActions.ts#addLabelAction': EDIT,
  'items/[key]/labelComponentActions.ts#removeComponentAction': EDIT,
  'items/[key]/labelComponentActions.ts#removeLabelAction': EDIT,
  'items/[key]/todoActions.ts#addTodoAction': EDIT,
  'items/[key]/todoActions.ts#deleteTodoAction': EDIT,
  // The guide overlay's re-read of the card's rows (MOTIR-7466) — the browse gate.
  'items/[key]/todoActions.ts#listTodosAction': READ,
  'items/[key]/todoActions.ts#moveTodoAction': EDIT,
  'items/[key]/todoActions.ts#setTodoDoneAction': EDIT,
  'items/[key]/todoActions.ts#updateTodoAction': EDIT,
  'items/[key]/watcherActions.ts#addWatcherAction': { kind: 'key', key: 'watcher:manage' },
  'items/[key]/watcherActions.ts#removeWatcherAction': { kind: 'key', key: 'watcher:manage' },
  'items/[key]/watcherActions.ts#toggleWatchAction': {
    kind: 'self',
    reason: 'watching is the actor’s own subscription to an item they can browse',
  },

  // ── collections ────────────────────────────────────────────────────────────
  'items/actions.ts#createFolderAction': EDIT,
  'items/actions.ts#createIssueAction': EDIT,
  'items/actions.ts#deleteFolderAction': EDIT,
  'items/actions.ts#describeFolderDeletionAction': EDIT,
  'items/actions.ts#listArchivedWorkItemsAction': READ,
  'items/actions.ts#listCandidateParentsAction': READ,
  'items/actions.ts#listChildIssuesAction': READ,
  'items/actions.ts#listCreateLinkCandidatesAction': READ,
  'items/actions.ts#listFolderLevelAction': READ,
  'items/actions.ts#listProjectFoldersAction': READ,
  'items/actions.ts#listRootIssuesAction': READ,
  'items/actions.ts#moveFolderAction': EDIT,
  'items/actions.ts#renameFolderAction': EDIT,
  'my-agents/_actions.ts#resolveChatWorkItemRefsAction': READ,
  'plans/_actions.ts#loadMoreSessionsAction': READ,
  'ready/_actions.ts#loadMoreReadyBugsAction': READ,
  'ready/_actions.ts#loadMoreReadyLeavesAction': READ,

  // ── account settings (the actor's own account) ────────────────────────────
  'settings/account/data/actions.ts#requestDataExportAction': {
    kind: 'self',
    reason: 'the actor’s own data',
  },
  'settings/account/git/actions.ts#disconnectGitAccountAction': {
    kind: 'self',
    reason: 'the actor’s own git identity',
  },
  'settings/account/profile/actions.ts#changePasswordAction': {
    kind: 'self',
    reason: 'the actor’s own password',
  },
  'settings/account/profile/actions.ts#sendSetPasswordLinkAction': {
    kind: 'self',
    reason: 'the actor’s own password',
  },
  'settings/account/profile/actions.ts#updateProfileAvatarAction': {
    kind: 'self',
    reason: 'the actor’s own profile',
  },
  'settings/account/profile/actions.ts#updateProfileNameAction': {
    kind: 'self',
    reason: 'the actor’s own profile',
  },

  // ── organization settings ──────────────────────────────────────────────────
  'settings/organization/git/actions.ts#connectGitlabProjectAction': {
    kind: 'role',
    role: 'org:owner-or-admin',
  },
  'settings/organization/git/actions.ts#disconnectGitlabAction': {
    kind: 'role',
    role: 'org:owner-or-admin',
  },
  'settings/organization/git/actions.ts#disconnectGitlabProjectAction': {
    kind: 'role',
    role: 'org:owner-or-admin',
  },
  'settings/organization/git/actions.ts#listGitlabProjectsAction': READ,
  'settings/organization/actions.ts#reconcileActiveWorkspaceAction': {
    kind: 'self',
    reason:
      'the session’s own active-workspace cookie, re-pointed after an org-tier remove (MOTIR-6312); the removal itself is the gated DELETE route',
  },
  'settings/organization/security/actions.ts#setOrganizationRequireTwoFactorAction': {
    kind: 'role',
    role: 'org:owner-or-admin',
  },

  // ── project settings ───────────────────────────────────────────────────────
  'settings/project/actions.ts#changeProjectKeyAction': { kind: 'key', key: 'project:administer' },
  'settings/project/actions.ts#releaseProjectKeyAction': { kind: 'key', key: 'project:administer' },
  'settings/project/actions.ts#updateProjectDetailsAction': {
    kind: 'key',
    key: 'project:administer',
  },
  'settings/project/actions.ts#updateProjectLogoAction': { kind: 'key', key: 'project:administer' },
  'settings/project/actions.ts#updateProjectOverviewAction': {
    kind: 'key',
    key: 'project:administer',
  },
  'settings/project/monitoring/actions.ts#recheckMonitorHealthAction': {
    kind: 'key',
    key: 'integration:manage',
  },
  'settings/project/workflow/actions.ts#addTransitionAction': {
    kind: 'key',
    key: 'workflow:manage',
  },
  'settings/project/workflow/actions.ts#createStatusAction': {
    kind: 'key',
    key: 'workflow:manage',
  },
  'settings/project/workflow/actions.ts#deleteStatusAction': {
    kind: 'key',
    key: 'workflow:manage',
  },
  'settings/project/workflow/actions.ts#removeTransitionAction': {
    kind: 'key',
    key: 'workflow:manage',
  },
  'settings/project/workflow/actions.ts#reorderStatusAction': {
    kind: 'key',
    key: 'workflow:manage',
  },
  'settings/project/workflow/actions.ts#restoreDefaultTransitionsAction': {
    kind: 'key',
    key: 'workflow:manage',
  },
  'settings/project/workflow/actions.ts#setPolicyModeAction': {
    kind: 'key',
    key: 'workflow:manage',
  },
  'settings/project/workflow/actions.ts#updateStatusAction': {
    kind: 'key',
    key: 'workflow:manage',
  },

  // ── workspace settings ─────────────────────────────────────────────────────
  'settings/workspace/actions.ts#leaveWorkspaceAction': {
    kind: 'self',
    reason: 'the actor’s own membership',
  },
  'settings/workspace/actions.ts#removeMemberAction': {
    kind: 'role',
    role: 'workspace:manager',
  },
  'settings/workspace/actions.ts#renameWorkspaceAction': {
    kind: 'known-gap',
    card: 'MOTIR-6168',
    reason: 'membership only; who may rename is the workspace-roles story’s question',
  },
  'settings/workspace/actions.ts#dismissRoleMigrationEntryAction': {
    kind: 'role',
    role: 'workspace:manager',
  },
  'settings/workspace/actions.ts#loadRoleMigrationPageAction': { kind: 'read' },
  'settings/workspace/actions.ts#setMemberAccessScopeAction': {
    kind: 'role',
    role: 'workspace:manager',
  },
  // The "N projects" popover's list (MOTIR-6551) — a READ, narrowed to what the viewer can enter.
  'settings/workspace/actions.ts#listMemberAddedProjectsAction': READ,
  // The door to one project's Access & members page (MOTIR-6551): it sets the
  // actor's OWN active project, through `setActiveProject`'s entry gate.
  'settings/workspace/actions.ts#openProjectAccessAction': {
    kind: 'self',
    reason: 'the actor’s own active project, through setActiveProject’s entry gate',
  },
  'settings/workspace/actions.ts#setMemberRoleAction': { kind: 'role', role: 'workspace:manager' },
  // Resend a pending invitation (MOTIR-9996): the invite's own scope rules,
  // re-asserted by `workspaceInvitesService.resendInvite`.
  'settings/workspace/actions.ts#resendInviteAction': { kind: 'role', role: 'workspace:inviter' },
  'settings/workspace/jobs/actions.ts#replayDlqAction': { kind: 'role', role: 'workspace:manager' },
  // MOTIR-8083: the platform OPERATOR's replay of a workspace-less dead letter. Not a
  // tenant permission at all — the service asserts the `operator` platform role (and refuses a
  // row that has a workspace), and the control exists only on the System tab, which
  // `parseJobsParams` / `showSystemTab` render for that operator alone. So there is no
  // capability for a client control to read; `self` is the kind that asks for none.
  'settings/workspace/jobs/actions.ts#replaySystemDlqAction': {
    kind: 'self',
    reason:
      'platform staff at operator level (User.platformRole), asserted in the service; the control only exists on the operator-only System tab',
  },
  'settings/workspace/security/actions.ts#setWorkspaceRequireTwoFactorAction': {
    kind: 'role',
    role: 'workspace:manager',
  },
};

/**
 * Client files that call a GATED action (`key`, `role` or `known-gap`) WITHOUT
 * reading a capability themselves — each with the reason it is still correct,
 * which the guard VERIFIES rather than trusts. Asserted tight both ways: an
 * entry for a file that no longer needs one fails as stale.
 */
export type ControlExemption =
  /** Mounted only by these parents, and every one of them reads a capability. */
  | { kind: 'mounted-by'; parents: string[] }
  /** Rendered only on this settings page, which refuses an actor without the key. */
  | { kind: 'page-guarded'; page: string }
  /** A filed gap: this control and its server action are that card's to fix. */
  | { kind: 'known-gap'; card: `MOTIR-${number}` };

export const CONTROL_EXEMPTIONS: Record<string, ControlExemption> = {
  // Start's project choice (MOTIR-8254) switches to a project the page listed
  // through `listProjects`, which returns only browsable projects; the action's
  // own missing `project:browse` check is MOTIR-6319's to add.
  'app/(onboarding)/onboarding/migrate/_components/MigrateWizard.tsx': {
    kind: 'known-gap',
    card: 'MOTIR-6319',
  },
  'app/(authed)/items/[key]/_components/DevelopmentLinkControl.tsx': {
    kind: 'mounted-by',
    parents: ['app/(authed)/items/[key]/_components/LateSections.tsx'],
  },
  'app/(authed)/items/[key]/_components/MonitorErrorsLinkControl.tsx': {
    kind: 'mounted-by',
    parents: [
      'app/(authed)/items/[key]/_view.tsx',
      'app/(authed)/items/[key]/_components/WorkItemDetailActions.tsx',
      'app/(authed)/items/[key]/_components/MonitorErrorsCard.tsx',
    ],
  },
  'app/(authed)/items/_components/customFieldEditing.tsx': {
    kind: 'mounted-by',
    parents: [
      'app/(authed)/items/[key]/_components/CustomFieldsSection.tsx',
      'app/(authed)/items/_components/IssueQuickViewPanel.tsx',
    ],
  },
  'app/(authed)/items/_components/fieldChipEditing.ts': {
    kind: 'mounted-by',
    parents: [
      'app/(authed)/items/[key]/_components/LabelsCard.tsx',
      'app/(authed)/items/[key]/_components/ComponentsCard.tsx',
      'app/(authed)/items/_components/IssueQuickViewPanel.tsx',
    ],
  },
  // The migration report is handed only to a Manager by the server
  // (`roleMigrationReportService.firstPageForViewer`); both mounts read the
  // workspace capability before rendering it.
  'app/(authed)/settings/workspace/_components/RoleMigrationNotice.tsx': {
    kind: 'mounted-by',
    parents: [
      'app/(authed)/settings/workspace/page.tsx',
      'app/(authed)/settings/organization/_components/WorkspaceFoldInSection.tsx',
    ],
  },
  'app/(authed)/settings/project/_components/ArchiveProjectModal.tsx': {
    kind: 'page-guarded',
    page: 'app/(authed)/settings/project/page.tsx',
  },
  'app/(authed)/settings/project/_components/ChangeKeyModal.tsx': {
    kind: 'page-guarded',
    page: 'app/(authed)/settings/project/page.tsx',
  },
  'app/(authed)/settings/project/_components/ProjectLogoField.tsx': {
    kind: 'page-guarded',
    page: 'app/(authed)/settings/project/page.tsx',
  },
  'app/(authed)/settings/project/_components/ReleaseKeyModal.tsx': {
    kind: 'page-guarded',
    page: 'app/(authed)/settings/project/page.tsx',
  },
  'app/(authed)/settings/project/monitoring/_components/MonitoringRoom.tsx': {
    kind: 'page-guarded',
    page: 'app/(authed)/settings/project/monitoring/page.tsx',
  },
  // Rendered only when `GitlabConnection` holds `canManage` (MOTIR-6320).
  'app/(authed)/settings/organization/git/_components/GitlabDisconnectButton.tsx': {
    kind: 'mounted-by',
    parents: ['app/(authed)/settings/organization/git/_components/GitlabConnection.tsx'],
  },
  'app/(authed)/settings/organization/git/_components/GitlabProjectPicker.tsx': {
    kind: 'mounted-by',
    parents: ['app/(authed)/settings/organization/git/_components/GitlabConnection.tsx'],
  },
  'app/(authed)/settings/workspace/_components/NameCard.tsx': {
    kind: 'known-gap',
    card: 'MOTIR-6168',
  },
};
