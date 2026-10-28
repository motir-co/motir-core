import 'server-only';

import { type Prisma } from '@/generated/prisma/client';

// WHAT IS IN A PERSONAL-DATA EXPORT (Story 8.4 · Subtask MOTIR-3701 · design of
// record `design/settings/design-notes.md` → `Data & privacy` → DECISION 1).
//
// The design fixes the FORMAT (JSON per record + the original uploaded files in
// a zip) and the SCOPE RULE ("as far as their access reaches"), and says in its
// own words that "which tables are in it is [this feature]'s to enumerate".
// This file IS that enumeration, and it is data rather than prose so that the
// archive, the card's table list and the totality guard all read one source.
//
// ── THE TWO TIERS ARE AN RLS FACT, NOT A TAXONOMY ──────────────────────────
// The scope rule is enforced by the DATABASE, not by the `where` clauses below.
// Every read runs inside the exporting user's OWN Postgres context, so a row the
// reader could not read in the product cannot enter their archive — which is the
// property "an export is not a privilege escalation" needs, and the one a
// hand-written filter can only approximate. The tiers name which context admits
// which table (measured against `pg_policies`, not assumed — a table with no arm
// for the bound context returns ZERO ROWS and raises nothing, so an unarmed read
// would silently ship an EMPTY section that looks exactly like "you have none"):
//
//   - `identity` — the table has no RLS, or an `app.user_id` arm. Read once,
//     under `withUserContext`.
//   - `tenant`   — the table's policy keys on `app.workspace_id`. Read ONCE PER
//     WORKSPACE the user is a member of, under `withWorkspaceContext`, and the
//     union is the section. A workspace they are not in is never bound, so its
//     rows are unreachable rather than filtered out.
//
// ⚠️ A TIER IS A CLAIM ABOUT A POLICY. Before adding a section, check
// `pg_policies` for an arm that admits the tier's context — `tests/export/
// personalDataSections.test.ts` asserts every section is non-empty for a
// fully-populated fixture user, which is what makes a wrong tier fail loudly
// instead of exporting nothing.
//
// ── WHAT IS DELIBERATELY NOT IN IT ─────────────────────────────────────────
// `EXCLUDED_FROM_EXPORT` is the other half of the enumeration and is not an
// afterthought: an omission nobody wrote down is indistinguishable from an
// omission nobody noticed. The totality guard requires every model carrying a
// `User` foreign key to appear in exactly one of the two lists, so a table added
// next year fails the build until somebody decides which it is.

/** Which Postgres context admits this table — see the tier note above. */
export type PersonalDataTier = 'identity' | 'tenant';

export interface PersonalDataSection {
  /** The physical table name. This is the enumeration's key and the archive's
   *  filename stem (`<table>.json`), so it is what the card's list names. */
  table: string;
  /** The Prisma delegate the read goes through. */
  model: PersonalDataDelegate;
  tier: PersonalDataTier;
  /** Why these rows are THIS person's data — the sentence a reviewer checks. */
  basis: string;
  /**
   * Columns that never leave the database. Applied as a Prisma `omit`, so the
   * value is not selected rather than selected and then stripped: a secret that
   * is never read cannot be logged, serialized by mistake, or left in a heap
   * dump. Art. 15 is a right to one's own data, not to the credentials that
   * protect it — a password hash or a TOTP secret in a downloadable file is a
   * new attack surface handed out on request.
   */
  redact?: readonly string[];
  /** The attribution filter, on top of whatever RLS already admits. */
  where: (userId: string) => Record<string, unknown>;
}

/** The Prisma delegates this file reads — narrowed so a typo is a type error. */
export type PersonalDataDelegate =
  | 'user'
  | 'account'
  | 'session'
  | 'passkey'
  | 'twoFactor'
  | 'apiToken'
  | 'deviceCode'
  | 'oauthClient'
  | 'oauthAccessToken'
  | 'oauthRefreshToken'
  | 'oauthConsent'
  | 'emailChangeRequest'
  | 'legalAcceptance'
  | 'workspaceMembership'
  | 'organizationMembership'
  | 'roleMigrationReport'
  | 'notificationPreference'
  | 'userAppearancePreference'
  | 'canvasNodePosition'
  | 'projectRepoCollaborator'
  | 'githubIdentity'
  | 'importSourceIdentity'
  | 'publicRequestVote'
  | 'accountDeletionRequest'
  | 'organizationDeletionRequest'
  | 'organizationContentLanguageChange'
  | 'dataExportRequest'
  | 'projectMembership'
  | 'projectAutoTranslateChange'
  | 'notification'
  | 'savedFilter'
  | 'savedFilterStar'
  | 'savedFilterSubscription'
  | 'automationRule'
  | 'dashboard'
  | 'watcher'
  | 'commentMention'
  | 'publicFollow'
  | 'dispatchRun'
  | 'agentInstance'
  | 'agentTerminalConnection'
  | 'comment'
  | 'workItem'
  | 'workItemRevision'
  | 'workItemLink'
  | 'attachment'
  | 'component'
  | 'customFieldValue'
  | 'acceptanceEvidence'
  | 'designEvidence'
  | 'testInstructions'
  | 'import'
  | 'plan'
  | 'planChangeSession'
  | 'planChangeTurn'
  | 'planChangeMailboxEntry'
  | 'planChangeRunPause'
  | 'sharpenSession'
  | 'sharpenTurn'
  | 'workItemTodo'
  | 'folder'
  | 'page'
  | 'pageVersion'
  | 'decisionPagePublication'
  | 'pageWorkItemLink'
  | 'monitorConnection'
  | 'approvalGate'
  | 'planRevision';

const byUserId = (userId: string) => ({ userId });

export const PERSONAL_DATA_SECTIONS: readonly PersonalDataSection[] = [
  // ── IDENTITY TIER — the account itself ────────────────────────────────────
  {
    table: 'user',
    model: 'user',
    tier: 'identity',
    basis: 'The account and profile — the row this whole export is about.',
    where: (userId) => ({ id: userId }),
  },
  {
    table: 'account',
    model: 'account',
    tier: 'identity',
    basis: 'Linked sign-in providers (password, Google) — which identities open this account.',
    // The password HASH and every OAuth token. `scope` and `providerId` stay:
    // knowing you signed in with Google is the reader's data, the bearer token
    // that acts as them is not.
    redact: ['password', 'accessToken', 'refreshToken', 'idToken'],
    where: byUserId,
  },
  {
    table: 'session',
    model: 'session',
    tier: 'identity',
    basis: 'Sign-in sessions, with the IP and user-agent recorded against each.',
    // The session token is a live credential — anyone holding it IS the user
    // until it expires. The IP/user-agent stay: they are exactly the "who has
    // been using my account" question Art. 15 exists to answer.
    redact: ['token'],
    where: byUserId,
  },
  {
    table: 'passkey',
    model: 'passkey',
    tier: 'identity',
    basis: 'Registered passkeys — one per device the reader enrolled.',
    redact: ['publicKey', 'credentialID'],
    where: byUserId,
  },
  {
    table: 'two_factor',
    model: 'twoFactor',
    tier: 'identity',
    basis: 'Two-factor enrolment — that it exists, and when it was set up.',
    // The TOTP secret and the backup codes ARE the second factor. Exporting
    // them would make a downloaded archive a complete bypass of it.
    redact: ['secret', 'backupCodes'],
    where: byUserId,
  },
  {
    table: 'api_token',
    model: 'apiToken',
    tier: 'identity',
    basis: 'Personal access tokens the reader minted, with their scopes and last use.',
    redact: ['tokenHash'],
    where: byUserId,
  },
  {
    table: 'device_code',
    model: 'deviceCode',
    tier: 'identity',
    basis: '`motir login` device grants this account claimed.',
    redact: ['deviceCode', 'userCode'],
    where: byUserId,
  },
  {
    table: 'oauth_client',
    model: 'oauthClient',
    tier: 'identity',
    basis: 'OAuth clients the reader registered while signed in (MOTIR-6982).',
    // A public client carries no secret, but a confidential one would: never out.
    redact: ['clientSecret'],
    where: byUserId,
  },
  {
    table: 'oauth_consent',
    model: 'oauthConsent',
    tier: 'identity',
    basis: 'Apps the reader allowed to act for them, and the scopes they granted.',
    where: byUserId,
  },
  {
    table: 'oauth_access_token',
    model: 'oauthAccessToken',
    tier: 'identity',
    basis: 'Access tokens issued to apps the reader connected, with their expiry.',
    // Stored hashed, and still a credential's fingerprint: it never leaves.
    redact: ['token'],
    where: byUserId,
  },
  {
    table: 'oauth_refresh_token',
    model: 'oauthRefreshToken',
    tier: 'identity',
    basis: 'Refresh tokens issued to apps the reader connected, and their revocation.',
    // `rotationReplayResponse` (better-auth 1.7) is the last rotation's token
    // response, encrypted, kept to answer a retried refresh: a credential too.
    redact: ['token', 'rotationReplayResponse'],
    where: byUserId,
  },
  {
    table: 'email_change_request',
    model: 'emailChangeRequest',
    tier: 'identity',
    basis: 'Pending verified email changes.',
    redact: ['token'],
    where: byUserId,
  },
  {
    table: 'legal_acceptance',
    model: 'legalAcceptance',
    tier: 'identity',
    basis: 'What this account agreed to, and when — the append-only consent record.',
    where: byUserId,
  },
  {
    table: 'workspace_membership',
    model: 'workspaceMembership',
    tier: 'identity',
    basis: 'Which workspaces the reader belongs to, and in what role.',
    where: byUserId,
  },
  {
    table: 'organization_membership',
    model: 'organizationMembership',
    tier: 'identity',
    basis: 'Which organizations the reader belongs to, and in what role.',
    where: byUserId,
  },
  {
    table: 'notification_preference',
    model: 'notificationPreference',
    tier: 'identity',
    basis: 'The per-event, per-channel notification toggles the reader set.',
    where: byUserId,
  },
  {
    table: 'user_appearance_preference',
    model: 'userAppearancePreference',
    tier: 'identity',
    basis:
      'The cross-device appearance preference: theme, style, palette, type pairing, and the font picked for each language.',
    where: byUserId,
  },
  {
    table: 'canvas_node_position',
    model: 'canvasNodePosition',
    tier: 'identity',
    basis: 'Where the reader dragged each node on a planning canvas.',
    where: byUserId,
  },
  {
    table: 'project_repository_collaborator',
    model: 'projectRepoCollaborator',
    tier: 'identity',
    basis: 'Repository collaborator invitations issued to the reader.',
    where: byUserId,
  },
  {
    table: 'github_identity',
    model: 'githubIdentity',
    tier: 'identity',
    basis: 'The linked GitHub identity (login and account id).',
    redact: ['accessTokenEncrypted'],
    where: byUserId,
  },
  {
    table: 'import_source_identity',
    model: 'importSourceIdentity',
    tier: 'identity',
    basis: 'Linked import-source identities (Jira, Linear, …) per workspace.',
    redact: ['accessTokenEncrypted', 'refreshTokenEncrypted'],
    where: byUserId,
  },
  {
    table: 'public_request_vote',
    model: 'publicRequestVote',
    tier: 'identity',
    basis: 'Upvotes the reader cast on public requests.',
    where: byUserId,
  },
  {
    table: 'account_deletion_request',
    model: 'accountDeletionRequest',
    tier: 'identity',
    basis: 'Account-erasure requests the reader has raised.',
    where: byUserId,
  },
  {
    table: 'organization_deletion_request',
    model: 'organizationDeletionRequest',
    tier: 'identity',
    basis:
      'Organization deletions the reader scheduled or cancelled — the record names them as the actor.',
    where: (userId) => ({ OR: [{ requestedByUserId: userId }, { cancelledByUserId: userId }] }),
  },
  {
    table: 'organization_content_language_change',
    model: 'organizationContentLanguageChange',
    tier: 'identity',
    // `changed_by_user_id` attributes an organisation's content-language change to
    // the person who made it (Story MOTIR-7731) — the "this person did this" shape
    // `organization_deletion_request` is exported for. The table's policy carries an
    // `app.user_id` arm on that column, so the identity context admits these rows.
    basis: 'Content-language changes the reader made to an organization.',
    where: (userId) => ({ changedByUserId: userId }),
  },
  {
    table: 'data_export_request',
    model: 'dataExportRequest',
    tier: 'identity',
    basis: 'Personal-data export requests the reader has raised — this one included.',
    where: byUserId,
  },

  // ── TENANT TIER — the reader's own rows inside workspaces they belong to ──
  // Each is filtered to the reader's OWN attribution. A workspace's other
  // content is not the reader's personal data and is not theirs to receive,
  // even where they can read it in the product.
  {
    table: 'project_membership',
    model: 'projectMembership',
    tier: 'tenant',
    basis: 'Explicit project memberships the reader holds.',
    where: byUserId,
  },
  {
    table: 'project_auto_translate_change',
    model: 'projectAutoTranslateChange',
    tier: 'tenant',
    // `changed_by_user_id` attributes a flip of a project's auto-translate switch to
    // the person who made it (Story MOTIR-7738). The table's policy keys on
    // `app.workspace_id` (the `page_version` pair), so it is read per workspace;
    // there is no `app.user_id` arm. The row holds no credential, so nothing is
    // redacted.
    basis: "Flips of a project's auto-translate switch the reader made.",
    where: (userId) => ({ changedByUserId: userId }),
  },
  {
    table: 'role_migration_report',
    model: 'roleMigrationReport',
    tier: 'tenant',
    basis:
      'How the move to workspace roles changed the reader’s own role in a workspace — ' +
      'their roles before, their role after, and why (Story MOTIR-6168).',
    where: byUserId,
  },
  {
    table: 'notification',
    model: 'notification',
    tier: 'tenant',
    basis: "Notifications delivered to the reader's inbox.",
    // RECIPIENT only. A row where the reader is the ACTOR is somebody else's
    // inbox item; that it names them does not make it their record.
    where: (userId) => ({ recipientUserId: userId }),
  },
  {
    table: 'saved_filter',
    model: 'savedFilter',
    tier: 'tenant',
    basis: 'Saved filters the reader owns.',
    where: (userId) => ({ ownerId: userId }),
  },
  {
    // Story MOTIR-1789 — the dispatch RUN record.
    //
    // ⚠️ EXPORTED RATHER THAN EXCLUDED, and the distinction is the person's own
    // action. A run says *this person dispatched an agent over these work items,
    // at this time, and it stopped for this reason* — durable history keyed to
    // them by `createdById`, not the transient operational substrate the
    // `PlanTargetLock` exclusion describes. It survives 30 days and outlives the
    // work items it names, which is precisely what makes it a record.
    //
    // The LEGS and EVENTS are not separate sections: neither carries a User
    // foreign key, so neither is user-keyed data. They belong to the RUN, and a
    // run belongs to the workspace that owns the work.
    table: 'dispatch_run',
    model: 'dispatchRun',
    tier: 'tenant',
    basis: 'Agent runs this person started.',
    where: (userId) => ({ createdById: userId }),
  },
  {
    // Story MOTIR-6860 — the person's own agent instances: what they named, which
    // profile, its state and when it last saw activity. Its running INTERVALS are
    // not a section: they carry no User foreign key and belong to the instance.
    table: 'agent_instance',
    model: 'agentInstance',
    tier: 'tenant',
    basis: 'Agent instances this person created.',
    where: (userId) => ({ ownerId: userId }),
  },
  {
    // Story MOTIR-6861 · MOTIR-6940 — one row per terminal this person opened on
    // their own agent: which agent, when it opened and closed, and why it closed.
    // A record of the person's own action, so EXPORTED. It holds nothing about
    // what flowed through the terminal (`agent-terminal.md` Q8), so neither does
    // the export.
    table: 'agent_terminal_connection',
    model: 'agentTerminalConnection',
    tier: 'tenant',
    basis: 'Terminals this person opened on their own agents (when, and why they closed).',
    where: byUserId,
  },
  {
    table: 'saved_filter_star',
    model: 'savedFilterStar',
    tier: 'tenant',
    basis: 'Saved filters the reader starred.',
    where: byUserId,
  },
  {
    table: 'saved_filter_subscription',
    model: 'savedFilterSubscription',
    tier: 'tenant',
    basis: 'The reader’s emailed-results subscriptions.',
    where: byUserId,
  },
  {
    table: 'automation_rule',
    model: 'automationRule',
    tier: 'tenant',
    basis: 'Automation rules the reader owns.',
    where: (userId) => ({ ownerId: userId }),
  },
  {
    table: 'dashboard',
    model: 'dashboard',
    tier: 'tenant',
    basis: 'Dashboards the reader owns.',
    where: (userId) => ({ ownerId: userId }),
  },
  {
    table: 'watcher',
    model: 'watcher',
    tier: 'tenant',
    basis: 'Work items the reader watches.',
    where: byUserId,
  },
  {
    table: 'comment_mention',
    model: 'commentMention',
    tier: 'tenant',
    basis: 'Comments in which the reader was mentioned.',
    where: (userId) => ({ mentionedUserId: userId }),
  },
  {
    table: 'public_follow',
    model: 'publicFollow',
    tier: 'tenant',
    basis: 'Public projects this account follows.',
    where: byUserId,
  },
  {
    table: 'comment',
    model: 'comment',
    tier: 'tenant',
    basis: 'Comments the reader wrote.',
    where: (userId) => ({ authorId: userId }),
  },
  {
    table: 'work_item',
    model: 'workItem',
    tier: 'tenant',
    basis:
      'Work items the reader reported, is assigned, or submitted as a bug report or feature request.',
    where: (userId) => ({
      OR: [{ reporterId: userId }, { assigneeId: userId }, { submittedByUserId: userId }],
    }),
  },
  {
    table: 'work_item_revision',
    model: 'workItemRevision',
    tier: 'tenant',
    basis: 'Work-item field changes the reader made.',
    where: (userId) => ({ changedById: userId }),
  },
  {
    table: 'work_item_link',
    model: 'workItemLink',
    tier: 'tenant',
    basis: 'Work-item links the reader created.',
    where: (userId) => ({ createdById: userId }),
  },
  {
    // `created_by_id` attributes an act — making this folder — to a person, the
    // same shape as `work_item_link.created_by_id` directly above, so it is
    // EXPORTED rather than excluded (Story MOTIR-5308 · MOTIR-5312).
    table: 'folder',
    model: 'folder',
    tier: 'tenant',
    basis: 'Folders the reader created.',
    where: (userId) => ({ createdById: userId }),
  },
  {
    // `created_by_id` / `updated_by_id` attribute acts — making a page, and the
    // latest edit to it — to a person, the same shape as `folder` directly above,
    // so it is EXPORTED (Story MOTIR-5752). The body ships as `body_markdown`, its
    // readable form; `body_state` is the binary Yjs document that markdown is
    // derived from, which would serialize as a byte-indexed object nobody can
    // read, so it is not selected.
    table: 'page',
    model: 'page',
    tier: 'tenant',
    basis: 'Pages the reader created or last edited.',
    redact: ['bodyState'],
    where: (userId) => ({ OR: [{ createdById: userId }, { updatedById: userId }] }),
  },
  {
    // `author_id` attributes an act — a run of saves to a page, or a restore — to
    // a person, the same shape as `page.updated_by_id` directly above, so it is
    // EXPORTED (Story MOTIR-5754). As there, the snapshot ships as its readable
    // `body_markdown` and the binary `body_state` is not selected.
    table: 'page_version',
    model: 'pageVersion',
    tier: 'tenant',
    basis: 'Versions of pages the reader saved or restored.',
    redact: ['bodyState'],
    where: (userId) => ({ authorId: userId }),
  },
  {
    // `published_by_id` attributes an act — publishing a page version as a work
    // item's decision — to a person, the same shape as `page_version.author_id`
    // directly above, so it is EXPORTED (Story MOTIR-5761 · MOTIR-7428). The row
    // carries ids and a time, no content.
    table: 'decision_page_publication',
    model: 'decisionPagePublication',
    tier: 'tenant',
    basis: 'Decision pages the reader published to a work item.',
    where: (userId) => ({ publishedById: userId }),
  },
  {
    // `created_by_id` attributes an act — the save that wrote a page's link to a
    // work item — to a person, the same SetNull-preserved shape as
    // `decision_page_publication.published_by_id` directly above, so it is
    // EXPORTED (Story MOTIR-7565 · MOTIR-7571). The row carries ids, a source and
    // a time, no content.
    table: 'page_work_item_link',
    model: 'pageWorkItemLink',
    tier: 'tenant',
    basis: 'Links between pages and work items the reader created by saving a page.',
    where: (userId) => ({ createdById: userId }),
  },
  {
    // `bound_by_user_id` attributes an act — binding a monitored project to this
    // Motir project — to a person, and it is WHOSE NAME every bug the reconciler
    // files goes on (Story MOTIR-4929 · MOTIR-5576). The same SetNull-preserved
    // attribution shape as `folder.created_by_id` above, so it is EXPORTED. The
    // row carries no secret: the credential lives on the grant
    // (`monitor_installation`), which is not exported from here.
    table: 'monitor_connection',
    model: 'monitorConnection',
    tier: 'tenant',
    basis: 'Monitored projects the reader bound, whose bugs are filed in their name.',
    where: (userId) => ({ boundByUserId: userId }),
  },
  {
    table: 'attachment',
    model: 'attachment',
    tier: 'tenant',
    basis: 'Files the reader uploaded — the rows whose bytes ride in `files/`.',
    where: (userId) => ({ uploaderUserId: userId }),
  },
  {
    table: 'component',
    model: 'component',
    tier: 'tenant',
    basis: 'Components for which the reader is the default assignee.',
    where: (userId) => ({ defaultAssigneeId: userId }),
  },
  {
    table: 'custom_field_value',
    model: 'customFieldValue',
    tier: 'tenant',
    basis: 'Custom-field values naming the reader.',
    where: (userId) => ({ valueUserId: userId }),
  },
  {
    table: 'acceptance_evidence',
    model: 'acceptanceEvidence',
    tier: 'tenant',
    basis: 'Story-acceptance videos the reader approved.',
    where: (userId) => ({ approvedById: userId }),
  },
  {
    table: 'design_evidence',
    model: 'designEvidence',
    tier: 'tenant',
    basis: 'Design results the reader withdrew.',
    where: (userId) => ({ withdrawnById: userId }),
  },
  {
    table: 'test_instructions',
    model: 'testInstructions',
    tier: 'tenant',
    // `published_by_id` attributes a How-to-test record to the person (or the
    // person whose token a dispatched agent held) who wrote it — the same
    // SetNull-preserved attribution as `design_evidence.withdrawnById`, so it
    // is exported rather than excluded (MOTIR-5328).
    basis: 'How-to-test instructions the reader published.',
    where: (userId) => ({ publishedById: userId }),
  },
  {
    table: 'import',
    model: 'import',
    tier: 'tenant',
    basis: 'Issue-import runs the reader started.',
    where: (userId) => ({ createdById: userId }),
  },
  {
    table: 'plan',
    model: 'plan',
    tier: 'tenant',
    basis: 'Plans the reader requested or decided.',
    where: (userId) => ({ OR: [{ createdById: userId }, { decidedById: userId }] }),
  },
  {
    table: 'plan_change_session',
    model: 'planChangeSession',
    tier: 'tenant',
    basis: 'Plan-change conversations the reader opened.',
    where: (userId) => ({ createdById: userId }),
  },
  {
    table: 'plan_change_turn',
    model: 'planChangeTurn',
    tier: 'tenant',
    basis: 'Turns the reader wrote in a plan-change conversation.',
    where: (userId) => ({ authorId: userId }),
  },
  {
    table: 'plan_change_mailbox_entry',
    model: 'planChangeMailboxEntry',
    tier: 'tenant',
    // What the reader typed at a RUNNING planning job, and the stops they raised
    // (Story MOTIR-4054 · MOTIR-4067). `body` is the user's own words verbatim,
    // so it is exported like a turn — the mailbox is a different table from
    // `plan_change_turn` only because of WHEN it is read, not WHOSE it is.
    basis: 'Turns and stops the reader sent to a running plan-change job.',
    where: (userId) => ({ authorId: userId }),
  },
  {
    table: 'plan_change_run_pauses',
    model: 'planChangeRunPause',
    tier: 'tenant',
    // `answered_by_id` records WHO answered the planner's mid-run offer or question
    // (Story MOTIR-7990 · MOTIR-8007), and `reply_text` is their own words verbatim.
    basis: 'Mid-run planner pauses the reader answered.',
    where: (userId) => ({ answeredById: userId }),
  },
  {
    table: 'sharpen_session',
    model: 'sharpenSession',
    tier: 'tenant',
    // A Sharpen conversation the reader opened on a plan or work item (Task
    // MOTIR-1101), and the answers it settled.
    basis: 'Sharpen conversations the reader opened.',
    where: (userId) => ({ createdById: userId }),
  },
  {
    table: 'sharpen_turn',
    model: 'sharpenTurn',
    tier: 'tenant',
    // The reader's own answers verbatim, exported like a plan-change turn.
    basis: 'Answers the reader gave in a Sharpen conversation.',
    where: (userId) => ({ authorId: userId }),
  },
  {
    table: 'work_item_todo',
    model: 'workItemTodo',
    tier: 'tenant',
    // `done_by_id` records WHO ticked a step, which is an attribution of an act
    // to a person — the same shape as `plan_revision.changedById` and
    // `design_evidence.withdrawnById`, both of which are exported. So this is
    // EXPORTED rather than excluded: a table carrying "this person did this" is
    // personal data whatever the row is otherwise about.
    basis: 'To-do steps the reader ticked off.',
    where: (userId) => ({ doneById: userId }),
  },
  {
    table: 'approval_gate',
    model: 'approvalGate',
    tier: 'tenant',
    // `decided_by_id` records WHO approved or requested changes on a gate —
    // the "human in the agent loop" evidence (Story MOTIR-4778). Same shape as
    // `work_item_todo.doneById` and `acceptance_evidence.approvedById`, both
    // exported: a SetNull-preserved attribution of a decision to a person is
    // personal data whatever the gate is otherwise about. Rows the reader did
    // NOT decide carry a null / other `decided_by_id` and are not theirs.
    basis: 'Approval-gate decisions the reader made.',
    where: (userId) => ({ decidedById: userId }),
  },
  {
    table: 'plan_revision',
    model: 'planRevision',
    tier: 'tenant',
    basis: 'Plan content changes the reader made.',
    where: (userId) => ({ changedById: userId }),
  },
];

/**
 * Models carrying a `User` foreign key that are deliberately NOT exported, each
 * with the reason. The totality guard reads this list, so an exclusion is a
 * decision on the record rather than a gap — which is the whole difference
 * between a table nobody exported and a table nobody noticed.
 */
export const EXCLUDED_FROM_EXPORT: Readonly<Record<string, string>> = {
  AgentTerminalTicket:
    'A 60-second, single-use connection ticket (`agent-terminal.md` Q3), stored only ' +
    'as a hash and swept once expired. It carries no fact about the person beyond ' +
    '"a ticket existed" and is gone before an export could describe it — the ' +
    'terminal itself is recorded in `agent_terminal_connection`, which IS exported.',
  PlatformAuditLog:
    'The controller’s own audit of moooon B.V. operator actions across the estate. ' +
    'Its rows name OTHER tenants (`targetLabel`, `organizationId`), so exporting them ' +
    'to the operator as a data subject would hand one person a machine-readable ' +
    'record about customers they administer — the exact privilege escalation ' +
    'DECISION 1’s scope clause forbids. It is also outside every workspace, so no ' +
    'reader’s access reaches it.',
  ImpersonationSession:
    'A platform staff "View as" session (MOTIR-749). Its User FKs are the moooon ' +
    'B.V. operator who opened it and the customer account it was opened AS. To the ' +
    'operator it is a record about a tenant they administered — `PlatformAuditLog`’s ' +
    'argument; to the customer it is an internal support record whose permanent form ' +
    'is the hash-chained audit log (`user.impersonation_start` / `_end`), not this ' +
    'operational row, which carries a credential hash and is written only from the ' +
    'platform tier.',
  Organization:
    'Not a user-keyed row about the reader. Its one User FK is `suspendedByUserId` ' +
    '(MOTIR-748): the moooon B.V. operator who suspended a CUSTOMER organization. ' +
    'Exporting it to that operator as a data subject would hand them a record about ' +
    'a tenant they administer — `PlatformAuditLog`’s argument, and the suspension is ' +
    'recorded there (`org.suspend`) with the same actor.',
  OrgFeatureFlag:
    'A per-organization kill-switch override (MOTIR-750) whose only User FK is the ' +
    'moooon B.V. operator who last flipped it. A record about a customer tenant, ' +
    'written only from the platform tier — `PlatformAuditLog`’s argument; every flip ' +
    'is recorded there (`org.kill_switch_off` / `org.kill_switch_on`).',
  PlatformFleetOrgCi:
    'The platform switch that moves a connected organisation’s private CI onto the ' +
    'shared runner fleet (MOTIR-8714), whose only User FK is the platform superadmin ' +
    'who last flipped it. Platform configuration written only from the platform tier, ' +
    'not a record about the operator as a data subject — `PlatformRunModel`’s argument; ' +
    'every flip is recorded in the audit log (`fleet.org_ci.enable` / ' +
    '`fleet.org_ci.disable`) with the same actor.',
  PlatformFleetKindSwitch:
    'A fleet kind’s Fly↔AWS switch (MOTIR-9503) — today the agent hoster’s — whose ' +
    'only User FK is the platform superadmin who last flipped it. Platform configuration ' +
    'written only from the platform tier, not a record about the operator as a data ' +
    'subject — `PlatformFleetOrgCi`’s argument; every flip is recorded in the audit log ' +
    '(`fleet.agent_hosting.enable` / `fleet.agent_hosting.disable`) with the same actor.',
  CapacityAlertSetting:
    'The single platform-wide provider-capacity alert share (MOTIR-9609), whose only ' +
    'User FK is the platform operator who last set it. Platform configuration written ' +
    'only from the platform tier, not a record about the operator as a data subject — ' +
    '`PlatformRunModel`’s argument; every change is recorded in the audit log ' +
    '(`capacity.alert_share.set`) with the same actor.',
  PlatformRunModel:
    'A row of the platform-wide hosted-run model list (MOTIR-7525) whose only User FK ' +
    'is the moooon B.V. operator who added the model. Platform configuration written ' +
    'only from the platform tier, not a record about the operator as a data subject — ' +
    '`OrgFeatureFlag`’s argument; every add and remove is recorded in the audit log ' +
    '(`ai.run_model_list.add` / `ai.run_model_list.remove`) with the same actor.',
  IdeaResearchRun:
    'A row of the idea store’s research-run log (MOTIR-7662) whose only User FK is ' +
    'the moooon B.V. operator who recorded the run. Motir’s own content, written only ' +
    'from the platform tier, not a record about the operator as a data subject — ' +
    '`PlatformRunModel`’s argument; every run is recorded in the audit log ' +
    '(`idea.research_run`) with the same actor.',
  PlanTargetLock:
    'A planning lease measured in minutes, held by a session and released by a sweep. ' +
    'It carries no fact about the person beyond "a lock existed", and is gone before ' +
    'an export could describe it — transient operational substrate, not a record.',
  ProjectVisitor:
    'Exported, but not as a raw table: `buildPersonalDataArchive` writes it as ' +
    '`project-visits.json` (Story MOTIR-6170 · MOTIR-6668), each record joined to the ' +
    'name and key of the public project it is about and saying who the consent shared ' +
    'the person’s name and email with. A dump of the table would name projects only by ' +
    'an opaque id, which answers Art. 15 in letter and not in substance.',
  Project:
    'Not a user-keyed row. `Project` appears in the User relation graph only as the ' +
    'back-relation of `user.lastActiveProjectId`; that pointer is a COLUMN on `user` ' +
    'and ships in the `user` section. The project itself belongs to the workspace.',
};

/** Sections in the tier the given context can read. */
export function sectionsForTier(tier: PersonalDataTier): readonly PersonalDataSection[] {
  return PERSONAL_DATA_SECTIONS.filter((s) => s.tier === tier);
}

/**
 * Read one section. `omit` is what applies the redaction — the column is never
 * selected, so the secret does not enter the process.
 */
export async function readSection(
  section: PersonalDataSection,
  userId: string,
  tx: Prisma.TransactionClient,
): Promise<unknown[]> {
  // The registry is deliberately DATA — one loop reads every section — so the
  // delegate is resolved by name and its args are built at runtime. Prisma's
  // per-model `findMany` overloads cannot type that; the narrowing that matters
  // (the model name is real, the redacted columns exist) is enforced by
  // `PersonalDataDelegate` and by the totality test, not here.
  const delegate = tx[section.model] as unknown as {
    findMany: (args: Record<string, unknown>) => Promise<unknown[]>;
  };
  const args: Record<string, unknown> = { where: section.where(userId) };
  if (section.redact?.length) {
    args.omit = Object.fromEntries(section.redact.map((f) => [f, true]));
  }
  return delegate.findMany(args);
}
