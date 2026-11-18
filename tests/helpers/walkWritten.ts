import { adminDb } from './adminDb';

/**
 * MARK EVERY `add` OF A PLAN WRITTEN — the stored `authorFinished` a walk's author
 * sessions leave on each card they finish (MOTIR-10496).
 *
 * A plan a walk touched (a step, a narration session, a listed committed card) closes
 * `planned` only once every card it owes is written; until then it closes `stopped`
 * and cannot be approved (Bug MOTIR-11701). A fixture that drives steps but stands in
 * for the author sessions calls this before its close, so the close it tests is the
 * close of a FINISHED walk.
 */
export async function markEveryAddWritten(planId: string): Promise<void> {
  const adds = await adminDb.planItem.findMany({ where: { planId, op: 'add' } });
  for (const add of adds) {
    const fields = (add.proposedFields ?? {}) as Record<string, unknown>;
    await adminDb.planItem.update({
      where: { id: add.id },
      data: { proposedFields: { ...fields, authorFinished: true } },
    });
  }
}
