'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronsUpDown, Info, Lock, Mail } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Pill } from '@/components/ui/Pill';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Tooltip } from '@/components/ui/Tooltip';
import type { WorkspaceAccessScope, WorkspaceRole } from '@/generated/prisma/client';
import { WORKSPACE_ROLES } from '@/lib/workspaces/roles';
import type {
  MemberAddedProjectDTO,
  MemberRoleContextDTO,
  WorkspaceMemberWithAccessDTO,
} from '@/lib/dto/workspaces';
import type { PendingInviteDTO } from '@/lib/dto/invites';
import { removeMemberAction, setMemberRoleAction } from '../actions';
import { AccessScopeCell, NoProjectsHelp } from './AccessScopeCell';
import { InviteAccessFields } from './InviteAccessFields';
import { PendingInvitesSection } from './PendingInvitesSection';

export interface MembersCardProps {
  workspaceId: string;
  workspaceName: string;
  /** Every member, with their access scope and added-project count (MOTIR-6545). */
  members: WorkspaceMemberWithAccessDTO[];
  currentUserId: string;
  /**
   * The role column's context, decided on the SERVER (Story MOTIR-6168 ·
   * MOTIR-6465): whether the viewer is a Manager, which members the org makes a
   * Manager, and the workspace's custom roles. The client never decides who is
   * a Manager.
   */
  roleContext: MemberRoleContextDTO;
  /**
   * The workspace's pending invitations (MOTIR-9997), loaded by the host only
   * for a viewer who may invite. Absent or empty draws no block at all.
   */
  pendingInvites?: PendingInviteDTO[];
}

export function MembersCard({
  workspaceId,
  workspaceName,
  members,
  currentUserId,
  roleContext,
  pendingInvites = [],
}: MembersCardProps) {
  const t = useTranslations('settings');
  const { toast } = useToast();
  const router = useRouter();
  const [inviteOpen, setInviteOpen] = useState(false);

  // The picker's options: the three built-ins, then this workspace's custom
  // roles under a heading that names the kind (design panel 1b). A custom
  // role's name is its author's text and never goes through `t()`.
  const roleOptions = useMemo<ComboboxOption<string>[]>(
    () => [
      ...WORKSPACE_ROLES.map((role) => ({
        value: role,
        label: t(`members.role.${role}`),
        description: t(`members.roleDesc.${role}`),
        group: t('members.roleGroupBuiltIn'),
      })),
      ...roleContext.customRoles.map((role) => ({
        value: role.id,
        label: role.name,
        description: t('members.customRoleOption'),
        group: t('members.roleGroupCustom'),
      })),
    ],
    [roleContext.customRoles, t],
  );

  // The only STORED Manager is locked (panel 1c) — the server refuses the change
  // anyway (LastManagerError), and the reason names what unlocks it. An org
  // Owner / Admin is locked at Manager by their org role (panel 6a).
  const storedManagers = members.filter(
    (m) => m.workspaceRole === 'manager' && m.customRole === null,
  );
  function lockReason(m: WorkspaceMemberWithAccessDTO): string | null {
    if (roleContext.orgManagedUserIds.includes(m.userId)) {
      return t('members.orgAdminRole', { org: roleContext.organizationName });
    }
    if (storedManagers.length === 1 && storedManagers[0]!.userId === m.userId) {
      return t('members.onlyManager');
    }
    return null;
  }

  return (
    <Card
      id="members"
      header={
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="font-sans text-base font-semibold text-(--el-text)">
              {t('members.heading')}
            </h2>
            {/* A member count is metadata, not an "info" severity state — so the
                neutral tone is the right semantics here (independent of #35,
                now resolved: all colored tones clear WCAG AA too). */}
            <Pill tone="neutral">{t('members.count', { count: members.length })}</Pill>
          </div>
          {/* A Limited member gets no Invite at all (MOTIR-6551 · W9). */}
          {roleContext.canInvite ? (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Mail className="h-4 w-4" />}
              onClick={() => setInviteOpen(true)}
            >
              {t('members.invite')}
            </Button>
          ) : null}
        </div>
      }
    >
      {roleContext.canManageRoles ? null : (
        <p className="border-(--el-info) bg-(--el-tint-sky) text-(--el-text-strong) rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) mb-3 flex items-center gap-2 border-l-2 font-sans text-xs">
          <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {t('members.rolesManagerOnly')}
        </p>
      )}
      <div
        className="border-(--el-border-soft) text-(--el-text-secondary) flex items-center justify-between border-b pb-2 font-mono text-[11px] uppercase tracking-wider"
        aria-hidden
      >
        <span className="flex-1">{t('members.personColumn')}</span>
        <span className="w-[8.5rem]">{t('members.roleColumn')}</span>
        <span className="mr-[4.75rem] ml-3 w-[13rem]">{t('members.accessColumn')}</span>
      </div>
      <ul role="list" className="flex flex-col">
        {members.map((m) => (
          <MemberRow
            key={m.userId}
            member={m}
            isSelf={m.userId === currentUserId}
            workspaceName={workspaceName}
            roleContext={roleContext}
            roleOptions={roleOptions}
            locked={lockReason(m)}
            onRemoved={() => router.refresh()}
            onRoleChanged={() => router.refresh()}
          />
        ))}
      </ul>

      {roleContext.canInvite ? <PendingInvitesSection invites={pendingInvites} /> : null}

      <InviteModal
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        workspaceId={workspaceId}
        workspaceName={workspaceName}
        canChooseAccess={roleContext.canManageRoles}
        projects={roleContext.inviteProjects}
        onSent={(email) => {
          toast({ variant: 'success', title: t('members.inviteSentToast', { email }) });
          setInviteOpen(false);
          // The Pending invitations block is server-rendered (MOTIR-9997).
          router.refresh();
        }}
      />
    </Card>
  );
}

function MemberRow({
  member,
  isSelf,
  workspaceName,
  roleContext,
  roleOptions,
  locked,
  onRemoved,
  onRoleChanged,
}: {
  member: WorkspaceMemberWithAccessDTO;
  isSelf: boolean;
  workspaceName: string;
  roleContext: MemberRoleContextDTO;
  roleOptions: ComboboxOption<string>[];
  /** Why this row's picker is locked, or null when it is operable. */
  locked: string | null;
  onRemoved: () => void;
  onRoleChanged: () => void;
}) {
  const t = useTranslations('settings');
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [rolePending, startRoleTransition] = useTransition();
  const initial = (member.name || member.email).charAt(0).toUpperCase();

  // The role the row SHOWS. An org Owner / Admin is a Manager whatever their
  // stored workspace role (MOTIR-6456 panel 6a); a custom-role holder shows the
  // custom role. Held locally so a change repaints at once (the page-state
  // contract's case 1) and reverts on a refusal.
  const orgManaged = roleContext.orgManagedUserIds.includes(member.userId);
  const serverKey = orgManaged ? 'manager' : (member.customRole?.id ?? member.workspaceRole);
  const [roleKey, setRoleKey] = useState(serverKey);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  // The access scope the row SHOWS (MOTIR-6551), held here because the row also
  // draws the 0-projects help line under its cells.
  const [scope, setScope] = useState<WorkspaceAccessScope>(member.accessScope);
  const isManagerRow = orgManaged || roleKey === 'manager';
  // Removing ANOTHER member is a Manager's act, and never reaches an org Owner /
  // Admin (the server refuses both — `workspacesService.removeMember`).
  const canRemove = roleContext.canManageRoles && !orgManaged;

  const labelOf = (key: string) =>
    roleOptions.find((o) => o.value === key)?.label ?? t('members.role.member');

  function commit(nextKey: string) {
    const previous = roleKey;
    setRoleKey(nextKey);
    const builtIn = (WORKSPACE_ROLES as readonly string[]).includes(nextKey);
    startRoleTransition(async () => {
      const result = await setMemberRoleAction(
        member.userId,
        builtIn ? (nextKey as WorkspaceRole) : 'member',
        builtIn ? null : nextKey,
      );
      if (result.ok) {
        toast({
          variant: 'success',
          title: t('members.roleChanged', {
            name: member.name,
            role: labelOf(nextKey),
            workspace: workspaceName,
          }),
        });
        onRoleChanged();
        return;
      }
      setRoleKey(previous);
      toast(
        result.code === 'LAST_MANAGER'
          ? {
              variant: 'error',
              title: t('members.lastManagerTitle'),
              description: t('members.lastManagerBody', { name: member.name }),
            }
          : {
              variant: 'error',
              title: t('members.roleChangeErrorTitle', { name: member.name }),
              description: t('members.roleChangeErrorBody', { role: labelOf(previous) }),
            },
      );
    });
  }

  function handlePick(nextKey: string) {
    if (nextKey === roleKey) return;
    // A Manager stepping down on their OWN row is asked first (panel 6c): once
    // they are not a Manager they cannot put themselves back.
    if (isSelf && roleKey === 'manager' && nextKey !== 'manager') {
      setConfirmKey(nextKey);
      return;
    }
    commit(nextKey);
  }

  function handleRemove() {
    startTransition(async () => {
      const result = await removeMemberAction(member.userId);
      if (result.ok) {
        toast({ variant: 'success', title: t('members.removedToast', { name: member.name }) });
        onRemoved();
      } else {
        toast({
          variant: 'error',
          title: t('members.removeErrorTitle'),
          description: result.error,
        });
      }
    });
  }

  const roleLabel = t('members.roleSelectLabel', { name: member.name });

  return (
    <li className="border-(--el-border-soft) flex flex-col gap-1 border-b py-3 last:border-b-0">
      <div className="flex items-center gap-3">
        <span className="bg-(--el-text) text-(--el-text-inverted) inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-sans text-xs font-semibold">
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-sans text-sm font-medium text-(--el-text)">
            {member.name}
            {isSelf ? (
              <span className="text-(--el-text-secondary) font-normal">
                {t('members.youSuffix')}
              </span>
            ) : null}
          </p>
          <p className="text-(--el-text-secondary) truncate font-sans text-xs">{member.email}</p>
        </div>
        <div className="w-[8.5rem] shrink-0" data-testid={`member-role-${member.userId}`}>
          {roleContext.canManageRoles ? (
            <Combobox
              options={roleOptions}
              value={roleKey}
              onChange={handlePick}
              label={roleLabel}
              loading={rolePending}
              disabled={rolePending || locked !== null}
            />
          ) : (
            // Read-only for a non-Manager: the role as TEXT in the disabled
            // trigger's shape, so the column keeps its line (MOTIR-2462's
            // treatment) without putting a control in the DOM.
            <Tooltip content={t('members.rolesManagerOnly')}>
              <span
                tabIndex={0}
                aria-label={`${roleLabel}: ${labelOf(roleKey)}`}
                className="border-(--el-border) bg-(--el-surface) text-(--el-text-secondary) h-(--height-control) rounded-(--radius-input) px-(--spacing-control-x) flex w-full items-center justify-between gap-1 border font-sans text-sm"
              >
                <span className="truncate">{labelOf(roleKey)}</span>
                <ChevronsUpDown
                  className="text-(--el-text-faint) h-3.5 w-3.5 shrink-0"
                  aria-hidden
                />
              </span>
            </Tooltip>
          )}
        </div>
        <div className="ml-3 w-[13rem] shrink-0">
          <AccessScopeCell
            member={member}
            scope={scope}
            onScopeChange={setScope}
            isManagerRow={isManagerRow}
            canManage={roleContext.canManageRoles}
            workspaceName={workspaceName}
          />
        </div>
        {isSelf || !canRemove ? (
          // No Remove on the self row (that is Leave), and none for an actor who
          // cannot remove this person — a non-Manager, or any row an org Owner /
          // Admin holds, which only the organization changes (MOTIR-6317; the
          // permission-gated UI rule HIDES an entry point the actor cannot use).
          // An invisible twin keeps the pickers in one column (design panel 1a).
          <span aria-hidden className="invisible">
            <Button variant="ghost" size="sm" tabIndex={-1}>
              {t('members.remove')}
            </Button>
          </span>
        ) : (
          <Button variant="ghost" size="sm" onClick={handleRemove} loading={isPending}>
            {t('members.remove')}
          </Button>
        )}
      </div>
      {!isManagerRow && scope === 'limited' && member.addedProjectCount === 0 ? (
        <NoProjectsHelp name={member.name} workspaceName={workspaceName} />
      ) : null}
      {locked && roleContext.canManageRoles ? (
        <p className="text-(--el-text-secondary) flex items-center gap-1.5 pl-11 font-sans text-xs">
          <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {locked}
        </p>
      ) : null}

      <Modal
        open={confirmKey !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmKey(null);
        }}
        title={t('members.selfDemoteTitle', { role: labelOf(confirmKey ?? 'member') })}
        description={t('members.selfDemoteBody', { workspace: workspaceName })}
        size="md"
      >
        <Modal.Footer>
          <Button variant="ghost" onClick={() => setConfirmKey(null)}>
            {t('members.selfDemoteKeep')}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              const next = confirmKey;
              setConfirmKey(null);
              if (next) commit(next);
            }}
          >
            {t('members.selfDemoteConfirm', { role: labelOf(confirmKey ?? 'member') })}
          </Button>
        </Modal.Footer>
      </Modal>
    </li>
  );
}

function InviteModal({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
  canChooseAccess,
  projects,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceName: string;
  /** A Manager chooses Full or Limited (MOTIR-6551 · W7); anyone else invites Full (W9). */
  canChooseAccess: boolean;
  /** The Manager's projects — the Limited invite's picker. */
  projects: MemberAddedProjectDTO[];
  onSent: (email: string) => void;
}) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [scope, setScope] = useState<WorkspaceAccessScope>('full');
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function reset() {
    setEmail('');
    setError(undefined);
    setScope('full');
    setProjectIds([]);
    setProjectsError(null);
  }

  function handleSend() {
    const value = email.trim();
    if (!value) return;
    setError(undefined);
    setProjectsError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/invites`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // The scope rides every invite; projects only a Limited one
          // (MOTIR-6546 refuses projects on a Full invite).
          body: JSON.stringify(
            scope === 'limited'
              ? { email: value, accessScope: 'limited', projectIds }
              : { email: value, accessScope: 'full' },
          ),
        });
        if (res.ok) {
          onSent(value);
          reset();
          return;
        }
        const data = (await res.json().catch(() => ({}))) as { code?: string };
        // A refusal about the PROJECTS is the picker's field error (W8).
        if (
          data.code === 'INVITE_PROJECT_INVALID' ||
          data.code === 'INVITE_PROJECTS_REQUIRE_LIMITED'
        ) {
          setProjectsError(t('members.errorInviteProjects'));
          return;
        }
        setError(messageForInviteError(t, res.status, data.code, value));
      } catch {
        setError(t('members.errorUnexpected'));
      }
    });
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title={t('members.inviteModalTitle', { workspaceName })}
      description={t('members.inviteModalDescription')}
      size="md"
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
      >
        {/* The fields scroll inside the panel: a Limited invite's project
            picker makes this modal tall (MOTIR-2491's rule). */}
        <Modal.Body className="gap-4">
          <Input
            label={t('members.emailLabel')}
            type="email"
            placeholder={t('members.emailPlaceholder')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={error}
            autoFocus
          />
          {canChooseAccess ? (
            <InviteAccessFields
              scope={scope}
              onScopeChange={setScope}
              projects={projects}
              projectIds={projectIds}
              onProjectIdsChange={setProjectIds}
              error={projectsError}
              disabled={isPending}
            />
          ) : null}
          <p className="text-(--el-text-secondary) font-sans text-xs">
            {t('members.inviteJoinsAsMember')}
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            {tc('cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={isPending} disabled={!email.trim()}>
            {t('members.sendInvite')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}

function messageForInviteError(
  t: (key: string, values?: Record<string, string>) => string,
  status: number,
  code: string | undefined,
  email: string,
): string {
  if (status === 422 || code === 'ALREADY_MEMBER') {
    return t('members.errorAlreadyMember', { email });
  }
  if (status === 429 || code === 'RATE_LIMITED') {
    return t('members.errorRateLimited');
  }
  if (code === 'INVITE_NOT_ALLOWED_FOR_SCOPE' || code === 'INVITE_SCOPE_FORBIDDEN') {
    return t('members.errorInviteNotAllowed');
  }
  if (status === 400 || code === 'INVALID_EMAIL') {
    return t('members.errorInvalidEmail');
  }
  return t('members.errorGeneric');
}
