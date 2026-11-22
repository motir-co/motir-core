import { composeDiscrepancyComment } from '@/lib/dispatchRuns/discrepancyComment';
import { adminDb } from './adminDb';

/**
 * Give a run discrepancy record the comment the door wrote beside it BEFORE MOTIR-11996, and
 * link the record to it, as such a record still is. The door writes no comment any more, so a
 * suite that pins what happens to a pre-11996 record's comment (edited, deleted) builds one
 * here, with the composer the door used. Answers the comment's id.
 */
export async function linkLegacyDiscrepancyComment(recordId: string): Promise<string> {
  const row = await adminDb.runDiscrepancyRecord.findUniqueOrThrow({
    where: { id: recordId },
    include: { entries: { orderBy: [{ kind: 'asc' }, { position: 'asc' }] } },
  });
  const points = row.entries
    .filter((e) => e.kind === 'point')
    .map((e) => ({ planAsked: e.planText, built: e.outcomeText, why: e.why }));
  const decisions = row.entries
    .filter((e) => e.kind === 'decision')
    .map((e) => ({
      planSaid: e.planText,
      chose: e.outcomeText,
      why: e.why,
      ...(e.alternatives === null ? {} : { alternatives: e.alternatives }),
    }));
  const comment = await adminDb.comment.create({
    data: {
      workspaceId: row.workspaceId,
      workItemId: row.workItemId,
      authorId: row.recordedById!,
      bodyMd: composeDiscrepancyComment(points, decisions),
    },
  });
  await adminDb.runDiscrepancyRecord.update({
    where: { id: recordId },
    data: { commentId: comment.id },
  });
  return comment.id;
}
