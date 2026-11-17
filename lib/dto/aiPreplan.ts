import type { FeatureCatalogView } from '@/lib/onboarding/directionDoc';
import type { StyleId } from '@/lib/theme/styles';
import type { PaletteId } from '@/lib/theme/palettes';
import type { TypeId } from '@/lib/theme/typography';
import type { BackgroundArea, BackgroundChoice } from '@motir/design-system';

// The onboarding DESIGN CHOICE (Subtask 7.3.81 / MOTIR-1255) — Motir's three
// design axes the design step (MOTIR-1040) lets the user pick for THEIR project:
// Style × Palette × Type. Persisted to motir-ai (`PreplanSession.designChoice`,
// stored opaquely there) and read back here so re-entering the step restores the
// saved look. The ids are the motir-core registry ids — `aiPreplanService`
// VALIDATES each against `isStyleId`/`isPaletteId`/`isTypeId` before it writes
// (motir-ai owns no registries), so a populated DTO always carries a known id.
// The light/dark Theme toggle is a PREVIEW mode, NOT an axis — it is not part of
// the persisted design choice.
//
// `backgrounds` (MOTIR-11607) is the background each page area draws — a
// registered background id or `none` — validated against the package's
// background registry the same way. Absent on a choice saved before it existed;
// provisioning then writes the style's default background for every area.
export interface DesignChoiceDTO {
  styleId: StyleId;
  paletteId: PaletteId;
  typeId: TypeId;
  backgrounds?: Record<BackgroundArea, BackgroundChoice>;
}

// The pre-plan read DTO (Subtask 7.3.70) — what `GET /api/ai/pre-plan` returns to
// the browser so the discovery UI (7.3.5) can RESUME the onboarding loop and
// render each artifact's forward revision diffs at the gate. Built by
// aiPreplanService from the motir-ai `GET /v1/preplan` body (the 7.3.25 read
// surface), which motir-core reaches ONLY through the `server-only` client
// (`getPreplanState`) — there is no pre-plan table in motir-core (the open-core
// invariant). motir-ai owns the project→AiProject resolution (keyed by the core
// workspace+project ids), so this side never holds an `aiProjectId`; the DTO
// drops that motir-ai-internal identity rather than leak it to the browser.

// One forward revision of a pre-plan artifact. `version` 1 is the created
// baseline (`diff` null); each later version carries the structured doc diff the
// resume gate renders. Forward-only — there is no rollback. `diff` is the
// motir-ai docDiff shape, opaque to motir-core and passed through verbatim for
// the gate to render.
export interface PreplanRevisionDTO {
  version: number;
  changeReason: string | null;
  changeKind: string | null;
  diff: unknown;
  createdAt: string; // ISO
}

// The four pre-plan artifacts the onboarding loop produces, in journey order.
export type PreplanArtifactKind = 'discovery' | 'vision' | 'feasibility' | 'validation';

// The visual treatment of a summary finding (mirrors motir-ai's tone enum):
// `positive` a captured fact, `neutral` the deliberate negative space (the muted
// "Out" row), `caution` a still-to-prove finding.
export type PreplanFindingTone = 'positive' | 'neutral' | 'caution';

// One labelled key→value finding in a tier's structured summary (MOTIR-1392 →
// MOTIR-1225). Passed through verbatim from motir-ai (the producer derives it
// from the structured tier docs); the canvas captured-findings renders it.
export interface PreplanFindingDTO {
  label: string;
  value: string;
  tone: PreplanFindingTone;
}

// One artifact's CURRENT rendered body + its full forward revision LOG.
// `currentBody` / `currentVersion` are the latest version's Markdown write-up +
// its number — what the 7.3.5 read-only review renders through 834's
// `DirectionDocView` (mapped via `toDirectionDocView` in lib/onboarding/
// directionDoc.ts), so the body is NEVER invented client-side. Sourced from the
// motir-ai `/v1/preplan` body (the field 7.3.72 added). `summary` is the
// structured per-tier breakdown (MOTIR-1392) the canvas captured-findings
// renders — `[]` when the tier has a body but no structured doc yet. `versions`
// is the orthogonal when/why/what diff timeline the gate renders separately. A
// kind present here always has ≥1 version, so both body fields are populated.
export interface PreplanArtifactLogDTO {
  kind: PreplanArtifactKind;
  currentBody: string;
  currentVersion: number;
  summary: PreplanFindingDTO[];
  versions: PreplanRevisionDTO[];
}

// The session-persistent pre-plan state (one per project) — the strategy
// decisions + where the loop is + the transcript essentials the UI replays.
export interface PreplanSessionDTO {
  // The 5 strategy decisions captured across the onboarding interview.
  classification: string | null;
  platform: string | null;
  designStarter: string | null;
  // The user's persisted three-axis design choice (7.3.81 / MOTIR-1255), or null
  // until they pick one in the design step. Read back from motir-ai so re-entering
  // the step restores the saved look.
  designChoice: DesignChoiceDTO | null;
  validationTiming: string | null;
  docSkipSet: string[];
  // Where the loop currently sits (the gate the UI resumes at) + lifecycle.
  currentGate: string | null;
  status: string;
  // Transcript essentials — the conversation the UI replays on resume. Opaque to
  // motir-core (motir-ai owns its shape); passed through verbatim.
  conversation: unknown;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

// The full pre-plan read for the active project. `session` is null and `docs` is
// empty for a project that never started a pre-plan — a LEGITIMATE empty resume
// state, NOT an error (motir-ai returns it, never a 404). A motir-ai transport /
// upstream failure surfaces as the route's 502, never a misleading empty here.
export interface PreplanStateDTO {
  session: PreplanSessionDTO | null;
  docs: PreplanArtifactLogDTO[];
  // The structured feature catalog (7.3.78), FOLDED INTO the vision tier on the
  // consumer side — so it is a sibling field, not a `docs[]` entry. Reuses 834's
  // `FeatureCatalogView` (the motir-core catalog shape that mirrors motir-ai's
  // `FeatureCatalogDto`), so the gate's `DirectionDocView` consumes it directly.
  // Null until the vision step drafts it (the same empty-resume shape as a null
  // session / empty docs).
  catalog: FeatureCatalogView | null;
}
