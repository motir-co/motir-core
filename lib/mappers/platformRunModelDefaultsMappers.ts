import type { User } from '@/generated/prisma/client';
import type { RunModelDefaultKey, RunModelDefaultsRead } from '@/lib/ai/types';
import type {
  PlatformRunModelDefaultOptionDTO,
  PlatformRunModelDefaultRowDTO,
  PlatformRunModelDefaultsDTO,
} from '@/lib/dto/platformRunModelDefaults';

/** The card's order: the two roles first, then the levels easiest to hardest (design). */
export const RUN_MODEL_DEFAULT_ROW_ORDER: readonly RunModelDefaultKey[] = [
  'review',
  'design',
  'trivial',
  'low',
  'medium',
  'high',
];

/**
 * motir-ai's run-model-defaults read + the narrowed run offer → the card's DTO
 * (MOTIR-10844).
 *
 * `options` are the models a hosted run may actually use: motir-ai's offer
 * narrowed to the run-model list (`hostedRunModelService.listOfferedModels`).
 * A stored model is WITHDRAWN when motir-ai says it is not offered OR it is not
 * among those options, so the console never shows as healthy a model a hosted
 * run would skip. A row motir-ai did not answer is left out, never invented.
 */
export function toPlatformRunModelDefaultsDTO(
  read: RunModelDefaultsRead,
  options: readonly PlatformRunModelDefaultOptionDTO[],
  runDefault: string | null,
  users: readonly Pick<User, 'id' | 'name' | 'email'>[],
  canEdit: boolean,
): PlatformRunModelDefaultsDTO {
  const nameById = new Map(users.map((u) => [u.id, u.name?.trim() || u.email]));
  const usable = new Set(options.map((o) => o.id));
  const rows: PlatformRunModelDefaultRowDTO[] = [];
  for (const key of RUN_MODEL_DEFAULT_ROW_ORDER) {
    const s = read.settings.find((x) => x.key === key);
    if (!s) continue;
    const changed = !!s.updatedByCoreUserId;
    rows.push({
      key,
      model: s.model,
      withdrawn: s.model !== null && (s.offered === false || !usable.has(s.model)),
      inheritsModel: key === 'review' ? runDefault : key === 'design' ? null : s.effectiveModel,
      updatedAt: changed ? s.updatedAt : null,
      updatedBy: s.updatedByCoreUserId ? (nameById.get(s.updatedByCoreUserId) ?? null) : null,
      seeded: !changed,
    });
  }
  return { rows, options: options.map((o) => ({ id: o.id, provider: o.provider })), canEdit };
}
