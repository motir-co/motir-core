import {
  getCodeAudit,
  getConvention,
  putConvention,
  refreshCodeAudit,
  type RawConvention,
  type RawConventionSurface,
  type RawCodeAuditSurface,
  type RawExternalScannerState,
} from '@/lib/ai/motirAiClient';
import { resolveProjectCodeContext } from '@/lib/ai/codeContext';
import {
  ConventionBlankError,
  ConventionTooLongError,
  ConventionVersionConflictError,
  EmptyRepoScopeError,
  UnknownRepoScopeError,
} from '@/lib/codeHealth/errors';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { MotirAiConventionConflictError, MotirAiError } from '@/lib/ai/errors';
import { projectAccessService, type AccessActorContext } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { resolveCodeContextState } from '@/lib/services/codeContextService';
import { matchRepoInSet } from '@/lib/services/repoFileReadService';
import { userRepository } from '@/lib/repositories/userRepository';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type {
  CodingConventionDTO,
  ConventionSurfaceDTO,
  CodeAuditSurfaceDTO,
  CodeAuditFindingDTO,
  CodeHealthSummaryDTO,
  ExternalScannerStateDTO,
  ExternalScannerSource,
  PlanningCodeHealthAuditDTO,
  PlanningCodeHealthConventionDTO,
  PlanningCodeHealthDTO,
  PlanningCodeHealthRepoDTO,
  PlanningConventionDTO,
  ReauditRepoJobsDTO,
  ReauditResultDTO,
  SavedConventionDTO,
} from '@/lib/dto/codeHealth';

// The Code-health surface service (Subtask 7.14.5 / MOTIR-926, amended by
// MOTIR-1663). The ONLY thing the /code-health page + its API routes call — it
// (1) GATES on the 6.4 project-admin permission, then (2) reaches the store
// ONLY over the 7.1 boundary via the motirAiClient leaf, and (3) maps the raw
// boundary shapes to the browser-facing DTOs. The approve/edit write path is
// removed (MOTIR-1660/1663: the convention is derived + auto-used, read-only
// with refine-via-universal-chat). Per-repo scope per MOTIR-1662.

const FINDINGS_PAGE_SIZE = 100;

// The longest convention a person may save, in characters. The editor's counter
// shows the same number (design-notes § The editable convention card); motir-ai
// stores up to 64 KB, and a character is at least one byte, so this never exceeds it.
export const CONVENTION_MAX_CHARS = 65_536;

// Resolve `editedByName` on every version of a surface from `editedByUserId`. One
// lookup for the set of editors, not one per version.
async function withEditorNames(surface: ConventionSurfaceDTO): Promise<ConventionSurfaceDTO> {
  const all = [...(surface.convention ? [surface.convention] : []), ...surface.versions];
  const ids = [...new Set(all.map((c) => c.editedByUserId).filter((id): id is string => !!id))];
  if (ids.length === 0) return surface;
  const users = await userRepository.findByIds(ids);
  const names = new Map(users.map((u) => [u.id, u.name]));
  const named = (c: CodingConventionDTO): CodingConventionDTO =>
    c.editedByUserId ? { ...c, editedByName: names.get(c.editedByUserId) ?? null } : c;
  return {
    ...surface,
    convention: surface.convention ? named(surface.convention) : null,
    versions: surface.versions.map(named),
  };
}

// The PLANNING read's page sizes (MOTIR-7793). motir-ai's `parsePositiveInt`
// REJECTS `0` for both `findingsLimit` and `versionsLimit`, so the cheapest legal
// summary read is `1` — and the one finding / one version it returns is dropped.
const PLANNING_FINDINGS_LIMIT = 1;
const PLANNING_VERSIONS_LIMIT = 1;

function toProvenance(raw: RawConvention['provenance']): CodingConventionDTO['provenance'] {
  return (raw ?? []).map((p) => ({ ruleId: p.ruleId, category: p.category, source: p.source }));
}

function toConventionDTO(raw: RawConvention): CodingConventionDTO {
  return {
    id: raw.id,
    repoKey: raw.repoKey,
    version: raw.version,
    contentMd: raw.contentMd,
    provenance: toProvenance(raw.provenance),
    authorKind: raw.authorKind ?? 'derived',
    editedByUserId: raw.editedByUserId ?? null,
    // Filled in by `withEditorNames`; the pure mapper has no user lookup.
    editedByName: null,
    pendingDerivedMd: raw.pendingDerivedMd ?? null,
    createdAt: raw.createdAt,
  };
}

// Map motir-ai's `{ convention, versions, nextCursor }` body (MOTIR-2127). The
// surface-level `repoKey` comes from the REQUESTED repoKey — motir-ai does not
// echo it at the surface level, only on each row — falling back to the row's own
// repoKey so a caller that scoped to no repo still labels the card correctly.
function toConventionSurfaceDTO(
  raw: RawConventionSurface,
  requestedRepoKey: string | undefined,
): ConventionSurfaceDTO {
  const versions = (raw.versions ?? []).map(toConventionDTO);
  const convention = raw.convention ? toConventionDTO(raw.convention) : null;
  return {
    repoKey: requestedRepoKey ?? convention?.repoKey ?? versions[0]?.repoKey ?? null,
    convention,
    versions,
    nextCursor: raw.nextCursor,
  };
}

function toHealthSummary(raw: unknown): CodeHealthSummaryDTO {
  const s = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const statusOf = (v: unknown): 'conforms' | 'watch' | 'gap' =>
    v === 'watch' || v === 'gap' ? v : 'conforms';
  const byCategory = Array.isArray(s['byCategory'])
    ? (s['byCategory'] as Record<string, unknown>[]).map((c) => ({
        category: String(c['category'] ?? ''),
        label: String(c['label'] ?? c['category'] ?? ''),
        status: statusOf(c['status']),
        detail: str(c['detail']),
      }))
    : undefined;
  // MOTIR-5921: an audit that read no graph composes no verdict. motir-ai records
  // `sources.graph: false` and a null grade; audits recorded before that fix carry
  // the placeholder grade 'unknown' — neither is a grade to render.
  const sources = (s['sources'] ?? {}) as Record<string, unknown>;
  const notMeasured = sources['graph'] === false;
  const grade = str(s['grade']);
  return {
    grade: notMeasured || grade === 'unknown' ? undefined : grade,
    ...(notMeasured ? { notMeasured: true } : {}),
    conformancePct: notMeasured ? undefined : num(s['conformancePct']),
    score: num(s['score']),
    totalFindings: num(s['totalFindings']),
    conventionVersion: num(s['conventionVersion']),
    byCategory,
  };
}

function toFindingDTO(raw: unknown): CodeAuditFindingDTO {
  const f = (raw ?? {}) as Record<string, unknown>;
  const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    ruleId: String(f['ruleId'] ?? ''),
    category: String(f['category'] ?? ''),
    severity: String(f['severity'] ?? 'low'),
    fileRef: strOrNull(f['fileRef']),
    symbolRef: strOrNull(f['symbolRef']),
    why: strOrNull(f['why']),
    conventionRuleRef: strOrNull(f['conventionRuleRef']),
  };
}

const SCANNER_SOURCES: ExternalScannerSource[] = [
  'github_code_scanning',
  'sonarqube_config',
  'ci_scan_workflow',
  'eslint_config',
];

function toScannerState(
  raw: RawExternalScannerState | null | undefined,
): ExternalScannerStateDTO | null {
  if (!raw || typeof raw !== 'object') return null;
  const detected = Array.isArray(raw.detected)
    ? raw.detected.filter((s): s is ExternalScannerSource =>
        SCANNER_SOURCES.includes(s as ExternalScannerSource),
      )
    : [];
  const suggestion =
    raw.suggestion === 'github_code_scanning' || raw.suggestion === 'sonarqube'
      ? raw.suggestion
      : null;
  const ingested =
    raw.ingested && raw.ingested.source === 'github_code_scanning'
      ? {
          source: 'github_code_scanning' as const,
          analyses: Number(raw.ingested.analyses) || 0,
          tools: Array.isArray(raw.ingested.tools) ? raw.ingested.tools.map(String) : [],
          findingCount: Number(raw.ingested.findingCount) || 0,
        }
      : null;
  return {
    detected,
    ingested,
    noExternalScanner: raw.noExternalScanner === true,
    suggestion,
  };
}

function toCodeAuditSurfaceDTO(raw: RawCodeAuditSurface): CodeAuditSurfaceDTO {
  return {
    audit: raw.audit
      ? {
          id: raw.audit.id,
          healthSummary: toHealthSummary(raw.audit.healthSummary),
          codeGraphRef: raw.audit.codeGraphRef,
          repoKey: raw.audit.repoKey ?? null,
          createdAt: raw.audit.createdAt,
        }
      : null,
    findings: (raw.findings ?? []).map(toFindingDTO),
    total: raw.total,
    nextOffset: raw.nextOffset,
    scanner: toScannerState(raw.scanner),
  };
}

// Resolve the repos a `reaudit` submits for, from the project's CONNECTED set and
// the caller's optional scope. Validation happens here — in the same step that
// resolves the connected set — so an invalid scope can never reach a submit.
function resolveReauditTargets(
  connectedRepoRefs: string[],
  scope: string[] | undefined,
): (string | null)[] {
  // No scope: the shipped whole-set fan-out. A project with no connected repo
  // still sends exactly one unscoped pair.
  if (scope === undefined) {
    return connectedRepoRefs.length > 0 ? connectedRepoRefs : [null];
  }
  if (scope.length === 0) throw new EmptyRepoScopeError();

  const connected = new Set(connectedRepoRefs);
  const unknown = scope.filter((repoKey) => !connected.has(repoKey));
  if (unknown.length > 0) throw new UnknownRepoScopeError([...new Set(unknown)]);

  // Preserve the caller's order; collapse repeats.
  return [...new Set(scope)];
}

// One repository's planning sections (MOTIR-7793). Each boundary read is
// contained on its own: a `MotirAiError` degrades THAT section to `unavailable`
// and leaves its sibling — and every other repository — answering. Anything that
// is not a boundary failure is a defect and propagates.
async function readPlanningAudit(
  projectId: string,
  ctx: AccessActorContext,
  repoRef: string,
): Promise<PlanningCodeHealthAuditDTO> {
  try {
    const raw = await getCodeAudit({
      coreWorkspaceId: ctx.workspaceId,
      coreProjectId: projectId,
      repoKey: repoRef,
      findingsLimit: PLANNING_FINDINGS_LIMIT,
    });
    if (!raw.audit) return { state: 'absent' };
    // Built field by field from the summary mapper, never by spreading the
    // surface DTO — so no `findings` page can ride along by accident.
    return {
      state: 'present',
      healthSummary: toHealthSummary(raw.audit.healthSummary),
      createdAt: raw.audit.createdAt,
      codeGraphRef: raw.audit.codeGraphRef,
    };
  } catch (err) {
    if (err instanceof MotirAiError) return { state: 'unavailable', code: err.code };
    throw err;
  }
}

async function readPlanningConvention(
  projectId: string,
  ctx: AccessActorContext,
  repoRef: string,
): Promise<PlanningCodeHealthConventionDTO> {
  try {
    const raw = await getConvention({
      coreWorkspaceId: ctx.workspaceId,
      coreProjectId: projectId,
      repoKey: repoRef,
      versionsLimit: PLANNING_VERSIONS_LIMIT,
    });
    return raw.convention
      ? { state: 'present', convention: toConventionDTO(raw.convention) }
      : { state: 'absent' };
  } catch (err) {
    if (err instanceof MotirAiError) return { state: 'unavailable', code: err.code };
    throw err;
  }
}

export const aiConventionService = {
  // The latest code-health audit summary + a page of findings. `findingsOffset`
  // pages the (bounded, virtualized) list as it scrolls; `repoKey` scopes to a
  // single repo (MOTIR-1662 per-repo scope).
  //
  // `findingsLimit` overrides the page size for a SUMMARY read (MOTIR-2207 ·
  // Panel 7 §3). The multi-repo list needs `healthSummary` + `total` for every
  // connected repo and `findings` for only the selected one, so reading N
  // surfaces at the full page size would ship N × 100 findings to draw an N-row
  // list. This is a passthrough, not a boundary change: `GET /v1/code-audit`
  // already accepts the param and `motirAiClient.getCodeAudit` already forwards
  // it. Note motir-ai's `parsePositiveInt` REJECTS `0`, so the cheapest legal
  // summary read is `1` — see SUMMARY_FINDINGS_LIMIT at the page.
  async getAudit(
    projectId: string,
    ctx: AccessActorContext,
    opts: { repoKey?: string; findingsOffset?: number; findingsLimit?: number } = {},
  ): Promise<CodeAuditSurfaceDTO> {
    // THE READ IS `ai:plan`; EVERY WRITE STAYS `ai:configure` (MOTIR-9173).
    // MOTIR-2362 mapped these reads to `ai:configure` along with the writes, and
    // that took `/code`'s Health section away from every member — worse, the
    // refusal is a `PermissionDeniedError` the page did not catch, so the whole
    // room failed. The owner decided (2026-10-21) that members read the audit and
    // the convention, read-only. `ai:plan` is the key `getPlanningCodeHealth`
    // already gates the same data on for the MCP door, so the UI read now matches
    // it; `saveConvention` and `reaudit` below keep `ai:configure`.
    await projectAccessService.assertPermission(projectId, ctx, 'ai:plan');
    const raw = await getCodeAudit({
      coreWorkspaceId: ctx.workspaceId,
      coreProjectId: projectId,
      repoKey: opts.repoKey,
      findingsOffset: opts.findingsOffset,
      findingsLimit: opts.findingsLimit ?? FINDINGS_PAGE_SIZE,
    });
    return toCodeAuditSurfaceDTO(raw);
  },

  // The per-repo convention (derived, auto-used — read-only; MOTIR-1660/1662).
  // Pass `repoKey` to scope to a single repo; omit for the first repo or the
  // empty surface for a project with no connected repo.
  async getConvention(
    projectId: string,
    ctx: AccessActorContext,
    opts: { repoKey?: string; versionsCursor?: string } = {},
  ): Promise<ConventionSurfaceDTO> {
    // `ai:plan`, the same read key as `getAudit` above (MOTIR-9173).
    await projectAccessService.assertPermission(projectId, ctx, 'ai:plan');
    const raw = await getConvention({
      coreWorkspaceId: ctx.workspaceId,
      coreProjectId: projectId,
      repoKey: opts.repoKey,
      versionsCursor: opts.versionsCursor,
    });
    return withEditorNames(toConventionSurfaceDTO(raw, opts.repoKey));
  },

  // A person's save of one repository's convention (MOTIR-9082): a NEW version,
  // `edited`, written by motir-ai (`PUT /v1/convention`, MOTIR-9080). Gated on
  // `ai:configure`, which the reads no longer share (MOTIR-9173). `baseVersion` is the version the editor
  // loaded (0 for a repository with none); a stale one is refused by motir-ai and
  // surfaces here as `ConventionVersionConflictError` carrying the version that
  // won, so the editor can offer it. Answers the re-read surface, so the card
  // replaces its text, byline and history from ONE response.
  async saveConvention(
    projectId: string,
    ctx: AccessActorContext,
    input: { repoKey: string; contentMd: string; baseVersion: number },
  ): Promise<ConventionSurfaceDTO> {
    await projectAccessService.assertPermission(projectId, ctx, 'ai:configure');
    if (input.contentMd.trim().length === 0) throw new ConventionBlankError();
    if (input.contentMd.length > CONVENTION_MAX_CHARS) {
      throw new ConventionTooLongError(CONVENTION_MAX_CHARS);
    }
    const scope = { coreWorkspaceId: ctx.workspaceId, coreProjectId: projectId };
    try {
      await putConvention({
        ...scope,
        repoKey: input.repoKey,
        contentMd: input.contentMd,
        editedByUserId: ctx.userId,
        baseVersion: input.baseVersion,
      });
    } catch (err) {
      if (!(err instanceof MotirAiConventionConflictError)) throw err;
      // Read what won, so the conflict state can name who saved it and when.
      const latest = await withEditorNames(
        toConventionSurfaceDTO(
          await getConvention({ ...scope, repoKey: input.repoKey }),
          input.repoKey,
        ),
      );
      throw new ConventionVersionConflictError(err.latestVersion, latest);
    }
    const raw = await getConvention({ ...scope, repoKey: input.repoKey });
    return withEditorNames(toConventionSurfaceDTO(raw, input.repoKey));
  },

  // The PLANNING read (Story MOTIR-7782 · Subtask MOTIR-7793) — what
  // `get_code_health` returns: every realized repository in the project's set,
  // with its index state, its latest audit's health SUMMARY and its current
  // derived convention. The same three things the hosted planner composes into
  // every planning session it runs (motir-ai `code_health`), now reachable by an
  // agent planning over the MCP.
  //
  // ⚠️ GATED ON `ai:plan`, NOT `ai:configure` — and NOT the same gate as
  // `getAudit` / `getConvention` above, deliberately
  // (`docs/decisions/member-facing-permissions.md` AMENDMENT 3 to §4). The hosted
  // planner already shows this content to every `ai:plan` holder through their
  // own plan, so `ai:plan` is exactly the set of actors who already see it. The
  // `/code-health` page's reads, and every re-audit and refresh, stay on
  // `ai:configure`, unchanged. The service asserts the SAME key the MCP door
  // checks (`TOOL_PERMISSIONS.get_code_health`), so no finer decision is left to
  // the token owner's role: a token narrowed off `ai:plan` is refused at the
  // door, and an owner without it is refused here.
  //
  // Read-only: no write, no model job, no findings page, no version history.
  // The index state is motir-core's own columns (`resolveCodeContextState`, the
  // ungated join — legal here because this method has just gated).
  async getPlanningCodeHealth(
    projectKey: string,
    ctx: ServiceContext,
  ): Promise<PlanningCodeHealthDTO> {
    // Workspace-bound and browse-gated: another tenant's key reads as a plain
    // not-found, the same 404-not-403 answer every project-keyed tool gives.
    const project = await projectsService.getByKey(projectKey, ctx);
    await projectAccessService.assertPermission(project.id, ctx, 'ai:plan');

    const { repos } = await resolveCodeContextState(project.id, ctx);
    const sections: PlanningCodeHealthRepoDTO[] = await Promise.all(
      repos.map(async (repo) => {
        const [audit, convention] = await Promise.all([
          readPlanningAudit(project.id, ctx, repo.repoRef),
          readPlanningConvention(project.id, ctx, repo.repoRef),
        ]);
        return {
          repoRef: repo.repoRef,
          indexState: repo.indexState,
          indexedAt: repo.indexedAt,
          commitsBehind: repo.commitsBehind,
          refreshFailing: repo.refreshFailing,
          audit,
          convention,
        };
      }),
    );

    return { project: { key: project.identifier, name: project.name }, repos: sections };
  },

  // The convention of ONE repository, in full (MOTIR-9083) — what
  // `get_coding_convention` returns, so a run agent reads its repository's own
  // rules from the stored convention instead of a file in the checkout.
  //
  // GATED ON `ai:plan`, the key `TOOL_PERMISSIONS.get_coding_convention` checks at
  // the door, for the reason `getPlanningCodeHealth` above gives: the hosted
  // planner already shows this text to every `ai:plan` holder, and
  // `CLI_TOKEN_GRANT` holds it, so every `motir run` token reaches it without the
  // grant widening. The `/code` page's reads share this key (MOTIR-9173).
  //
  // `repo` resolves against the project's realized set the way `read_file`'s does
  // (`matchRepoInSet`); a repository outside it answers with the set. Every
  // outcome is a named result, never a throw — only the permission and a missing
  // project are errors.
  async getPlanningConvention(
    projectKey: string,
    repo: string,
    ctx: ServiceContext,
  ): Promise<PlanningConventionDTO> {
    const project = await projectsService.getByKey(projectKey, ctx);
    await projectAccessService.assertPermission(project.id, ctx, 'ai:plan');

    const repoSet = (await resolveCodeContextState(project.id, ctx)).repos.map((r) => r.repoRef);
    const repoRef = matchRepoInSet(repo, repoSet);
    if (!repoRef) return { state: 'repo_not_in_project', repo, repoSet };

    const read = await readPlanningConvention(project.id, ctx, repoRef);
    if (read.state === 'absent') return { state: 'absent', repoRef };
    if (read.state === 'unavailable') return { state: 'unavailable', repoRef, code: read.code };

    const editorId = read.convention.editedByUserId;
    const editedByName =
      read.convention.authorKind === 'edited' && editorId
        ? ((await userRepository.findById(editorId))?.name ?? null)
        : null;
    return { state: 'present', repoRef, convention: read.convention, editedByName };
  },

  // The convention WRITE by project KEY (MOTIR-10183) — what `update_coding_convention`
  // calls. It only resolves what an MCP caller names — the project by key inside the
  // token's workspace, `repo` against the project's realized set the way
  // `getPlanningConvention` does — and hands the save to `saveConvention`, so the MCP
  // write and the /code editor's save are ONE code path: the same `ai:configure` gate,
  // the same blank / too-long refusals, the same stale-`baseVersion` conflict carrying
  // what won, and the same `editedByUserId: ctx.userId` author.
  //
  // `ai:configure` is asserted HERE, before the repository set is read, so an actor who
  // may not edit learns nothing about the project's repositories from the refusal.
  async saveConventionByKey(
    projectKey: string,
    repo: string,
    input: { contentMd: string; baseVersion: number },
    ctx: ServiceContext,
  ): Promise<SavedConventionDTO> {
    const project = await projectsService.getByKey(projectKey, ctx);
    await projectAccessService.assertPermission(project.id, ctx, 'ai:configure');

    const repoSet = (await resolveCodeContextState(project.id, ctx)).repos.map((r) => r.repoRef);
    const repoRef = matchRepoInSet(repo, repoSet);
    if (!repoRef) return { state: 'repo_not_in_project', repo, repoSet };

    const surface = await aiConventionService.saveConvention(project.id, ctx, {
      repoKey: repoRef,
      contentMd: input.contentMd,
      baseVersion: input.baseVersion,
    });
    return { state: 'saved', repoRef, convention: surface.convention };
  },

  // Trigger a re-audit + re-propose for the project (the "Deepen this audit" →
  // "Re-audit now" action, MOTIR-1592 over the MOTIR-928 refresh seam).
  //
  // FANS OUT over the connected repo SET (MOTIR-2123). One submit derives ONE
  // repo: motir-ai's `parseCodeAuditInput` resolves `repoRef ?? repos[0]` ("an
  // audit targets ONE repo") and `proposeConvention` records that same key, so a
  // single call left every repo but the alphabetically-first one with no
  // convention. Both jobs must fan out TOGETHER — `resolveSourceAuditId` reads
  // the audit for the SAME (project, repo), so a convention derived for a repo
  // with no audit of its own would link `sourceAuditId: null`.
  //
  // The per-repo scope rides the EXISTING envelope: `repoRef` is authoritative
  // over `repos[]` on the far side, so the repo set stays on `context.code`
  // beside it and no boundary change is needed. A project with NO connected repo
  // still submits exactly one unscoped pair — unchanged from before the fan-out.
  //
  // `opts.repoKeys` SCOPES the fan-out to an explicit target set (MOTIR-2247), so
  // deriving one repo's report no longer costs every repo's. Semantics:
  //
  //   undefined  → the shipped whole-set behaviour, byte for byte (including the
  //                single unscoped pair a project with no connected repo sends).
  //   []         → EmptyRepoScopeError. NOT "derive nothing": a client that
  //                computes zero targets must fail loudly, not look successful.
  //   [a, b]     → exactly those, VALIDATED against the connected set first.
  //                An unknown key raises before ANY submit, so a request mixing
  //                valid and invalid members queues nothing (no partial fan-out).
  //
  // Duplicates collapse to one pair — "one pair per NAMED repo" — since a repeated
  // key would spend a second derivation on a repo already being derived.
  async reaudit(
    projectId: string,
    ctx: AccessActorContext,
    projectKey: string,
    opts: { repoKeys?: string[] } = {},
  ): Promise<ReauditResultDTO> {
    // `ai:configure`, NOT `ai:plan` (Story MOTIR-2291 · Subtask MOTIR-2362).
    // The inventory mapped the four coding-convention operations to `ai:plan`,
    // which the decision record puts at `member` — applying that mapping would
    // have WIDENED admin-only operations to every member, in a story where every
    // other row narrows. `docs/decisions/member-facing-permissions.md` §4 resolves
    // it as a MAPPING fix: re-running a convention audit is AI CONFIGURATION
    // wearing a usage-shaped URL, the same class as the AI settings MOTIR-2300
    // already put behind `ai:configure`. `assertCanManage` was
    // `assertPermission(…, 'project:administer')` and `admin` holds
    // `ai:configure`, so NO actor's answer changes.
    await projectAccessService.assertPermission(projectId, ctx, 'ai:configure');
    const code = await resolveProjectCodeContext({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      projectId,
    });
    const { organizationId, isMeta, internalBilling } = await resolveTenantOrg({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    const tenant = {
      organizationId,
      isMeta,
      internalBilling,
      workspaceId: ctx.workspaceId,
      projectId,
      projectKey,
    };
    const repoRefs = code?.repos.map((repo) => repo.repoRef) ?? [];
    const targets: (string | null)[] = resolveReauditTargets(repoRefs, opts.repoKeys);

    const repos: ReauditRepoJobsDTO[] = [];
    for (const repoKey of targets) {
      const { auditJobId, conventionJobId } = await refreshCodeAudit(
        tenant,
        { code: repoKey === null ? (code ?? {}) : { ...code, repoRef: repoKey } },
        { userId: ctx.userId },
      );
      repos.push({ repoKey, auditJobId, conventionJobId });
    }
    return { repos };
  },
};
