import {
  getPreplanState as fetchPreplanState,
  saveDesignChoice as saveDesignChoiceUpstream,
} from '@/lib/ai/motirAiClient';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { InvalidDesignChoiceError } from '@/lib/ai/preplanErrors';
import { isStyleId, type StyleId } from '@/lib/theme/styles';
import { isPaletteId, type PaletteId } from '@/lib/theme/palettes';
import { isTypeId, type TypeId } from '@/lib/theme/typography';
import {
  BACKGROUND_AREAS,
  BACKGROUND_NONE,
  isBackgroundId,
  type BackgroundArea,
  type BackgroundChoice,
} from '@motir/design-system';
import type { RawPreplanSession, RawPreplanStateResponse } from '@/lib/ai/types';
import type { ProjectContext } from '@/lib/projects';
import type { DesignChoiceDTO, PreplanStateDTO } from '@/lib/dto/aiPreplan';
import { projectAccessService } from '@/lib/services/projectAccessService';

// The starter flag set ALONGSIDE the design choice (motir-ai stores it as the
// distinct `designStarter` column). A real pick → 'bare' (the project scaffolds
// from the bare starter with the chosen look applied), versus 'with-design' on a
// SKIP (the default-design starter). This card wires the pick path; the skip path
// is the plan-exit's concern (MOTIR-1041).
const DESIGN_STARTER_ON_PICK = 'bare';

// The raw three-axis ids as they arrive from the route (pre-validation), and the
// optional per-area backgrounds (MOTIR-11607). Each is validated against the
// registries before the write.
export interface DesignChoiceInput {
  styleId: string;
  paletteId: string;
  typeId: string;
  backgrounds?: Record<BackgroundArea, string>;
}

// The pre-plan READ-THROUGH service (Subtask 7.3.70): the thin motir-core seam
// the discovery UI (7.3.5) reads its resumable pre-plan state from. This is the
// email.ts-style LEAF-CLIENT pattern — motir-core holds NO pre-plan state; the
// session decisions + revision logs + diffs live in motir-ai and are fetched
// over the 7.1 boundary via the 7.3.25 client primitive (`getPreplanState`,
// which is `server-only`). No pre-plan table is added to motir-core (the
// open-core invariant).
//
// project→AiProject resolution happens on the motir-ai side: the read is keyed by
// the core (workspace, project) ids, and motir-ai resolves its AiProject from
// them READ-ONLY, returning the empty state ({ session: null, docs: [] }) for a
// not-yet-started project (never a 404). So this side just forwards the core ids
// off the already-resolved ProjectContext — the auth/membership + active-project
// gate ran in the route (getSession + getActiveProject, the project analogue of
// getSession — mirrors aiChatService / /api/board). A transport / upstream
// failure throws a typed MotirAiError the route maps to 502.

export const aiPreplanService = {
  // Read the active project's resumable pre-plan state — the session decisions,
  // each artifact's forward revision log, and the per-revision diffs — mapped to
  // the motir-core DTO the browser consumes.
  async getPreplanState(ctx: ProjectContext): Promise<PreplanStateDTO> {
    // `project:browse`, NOT `ai:plan` (MOTIR-2358). The route carries a READ and
    // a WRITE, and they are different acts: this one returns the project's
    // pre-plan tier documents, which is closer to browsing than to spending. One
    // file is not one key.
    await projectAccessService.assertPermission(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      'project:browse',
    );
    const raw = await fetchPreplanState({
      coreWorkspaceId: ctx.workspaceId,
      coreProjectId: ctx.projectId,
    });
    return mapPreplanState(raw);
  },

  // Persist the user's design-step choice (Subtask 7.3.81). VALIDATE each axis
  // against the motir-core registries (motir-ai owns none, storing the choice
  // opaquely) — an unknown id throws InvalidDesignChoiceError (the route → 422) —
  // then forward to the motir-ai write seam with the resolved org id (the write
  // find-or-creates the AiProject) and the 'bare' starter flag. Returns the
  // (validated) choice the upstream echoed back, so the route can confirm it.
  async saveDesignChoice(ctx: ProjectContext, choice: DesignChoiceInput): Promise<DesignChoiceDTO> {
    // The WRITE half is a planning act — `ai:plan` (MOTIR-2358).
    await projectAccessService.assertPermission(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      'ai:plan',
    );
    const validated = validateDesignChoice(choice);
    const organizationId = await resolveOrganizationId(ctx);
    const raw = await saveDesignChoiceUpstream({
      coreOrganizationId: organizationId,
      coreWorkspaceId: ctx.workspaceId,
      coreProjectId: ctx.projectId,
      designChoice: validated,
      designStarter: DESIGN_STARTER_ON_PICK,
    });
    // Trust the round-trip but fall back to the just-validated choice if motir-ai
    // somehow omitted it (defensive — the write always echoes the session DTO).
    return mapDesignChoice(raw.designChoice) ?? validated;
  },
};

// Validate the three axes against the motir-core registries, narrowing to the
// branded ids, then each page area's background against the package's background
// registry (or `none`). Checked in order; the FIRST unknown value throws.
function validateDesignChoice(choice: DesignChoiceInput): DesignChoiceDTO {
  if (!isStyleId(choice.styleId)) throw new InvalidDesignChoiceError('styleId', choice.styleId);
  if (!isPaletteId(choice.paletteId))
    throw new InvalidDesignChoiceError('paletteId', choice.paletteId);
  if (!isTypeId(choice.typeId)) throw new InvalidDesignChoiceError('typeId', choice.typeId);
  const dto: DesignChoiceDTO = {
    styleId: choice.styleId,
    paletteId: choice.paletteId,
    typeId: choice.typeId,
  };
  if (choice.backgrounds !== undefined) {
    const backgrounds = {} as Record<BackgroundArea, BackgroundChoice>;
    for (const area of BACKGROUND_AREAS) {
      const value = choice.backgrounds[area];
      if (value !== BACKGROUND_NONE && !isBackgroundId(value)) {
        throw new InvalidDesignChoiceError(`backgrounds.${area}`, value);
      }
      backgrounds[area] = value;
    }
    dto.backgrounds = backgrounds;
  }
  return dto;
}

// Map the wire design choice (opaque strings) to the DTO (branded ids). motir-core
// validated these before writing, so the cast is sound; null stays null.
function mapDesignChoice(raw: RawPreplanSession['designChoice']): DesignChoiceDTO | null {
  if (!raw) return null;
  const dto: DesignChoiceDTO = {
    styleId: raw.styleId as StyleId,
    paletteId: raw.paletteId as PaletteId,
    typeId: raw.typeId as TypeId,
  };
  if (raw.backgrounds) {
    dto.backgrounds = {
      landing: raw.backgrounds.landing as BackgroundChoice,
      login: raw.backgrounds.login as BackgroundChoice,
      hero: raw.backgrounds.hero as BackgroundChoice,
    };
  }
  return dto;
}

// Resolve the active workspace's organization id — the billing entity the write
// tenant carries (the write find-or-creates the AiProject under it). RLS-aware,
// mirroring aiExplanationService / aiChatService.
async function resolveOrganizationId(ctx: ProjectContext): Promise<string> {
  return withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (tx) => {
    const workspace = await workspaceRepository.findByIdInTx(ctx.workspaceId, tx);
    if (!workspace) throw new Error(`workspace ${ctx.workspaceId} not found`);
    return workspace.organizationId;
  });
}

// Map the motir-ai wire body to the motir-core DTO: drop the motir-ai-internal
// `aiProjectId` (never leaked to the browser), pass the opaque `conversation` /
// `diff` payloads through verbatim (motir-ai owns their shape; the gate renders
// them), and preserve the forward-only revision ordering motir-ai returns.
function mapPreplanState(raw: RawPreplanStateResponse): PreplanStateDTO {
  return {
    session: raw.session
      ? {
          classification: raw.session.classification,
          platform: raw.session.platform,
          designStarter: raw.session.designStarter,
          designChoice: mapDesignChoice(raw.session.designChoice),
          validationTiming: raw.session.validationTiming,
          docSkipSet: raw.session.docSkipSet,
          currentGate: raw.session.currentGate,
          status: raw.session.status,
          conversation: raw.session.conversation,
          createdAt: raw.session.createdAt,
          updatedAt: raw.session.updatedAt,
        }
      : null,
    docs: raw.docs.map((doc) => ({
      kind: doc.kind,
      // The latest rendered body the 7.3.5 gate displays (7.3.72/MOTIR-1188),
      // passed through verbatim alongside the forward revision log.
      currentBody: doc.currentBody,
      currentVersion: doc.currentVersion,
      // The structured per-tier summary the canvas captured-findings renders
      // (MOTIR-1392 producer → MOTIR-1225 consumer), passed through verbatim
      // ({ label, value, tone } per finding). `[]` for a not-yet-summarized tier.
      summary: doc.summary.map((f) => ({ label: f.label, value: f.value, tone: f.tone })),
      versions: doc.versions.map((v) => ({
        version: v.version,
        changeReason: v.changeReason,
        changeKind: v.changeKind,
        diff: v.diff,
        createdAt: v.createdAt,
      })),
    })),
    // The structured feature catalog (7.3.78), folded into the vision tier by the
    // gate. Mapped onto 834's `FeatureCatalogView` — keeping the per-node ids the
    // list render keys on, dropping the motir-ai-internal catalog id/aiProjectId/
    // timestamps (never leaked to the browser). Null until the vision step drafts it.
    catalog: raw.catalog
      ? {
          categories: raw.catalog.categories.map((cat) => ({
            id: cat.id,
            title: cat.title,
            features: cat.features.map((f) => ({
              id: f.id,
              name: f.name,
              descriptionMd: f.descriptionMd,
              phase: f.phase,
              status: f.status,
            })),
          })),
          glossary: raw.catalog.glossary.map((group) => ({
            id: group.id,
            title: group.title,
            concepts: group.concepts.map((concept) => ({
              id: concept.id,
              term: concept.term,
              aka: concept.aka,
              descriptionMd: concept.descriptionMd,
              example: concept.example,
            })),
          })),
        }
      : null,
  };
}
