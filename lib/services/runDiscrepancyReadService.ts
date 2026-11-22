import type { WorkItemRunDiscrepancyRecordDto } from '@/lib/dto/runDiscrepancy';
import {
  runDiscrepancyRecordBodies,
  toWorkItemRunDiscrepancyRecordDto,
} from '@/lib/mappers/runDiscrepancyMappers';
import { runDiscrepancyRecordRepository } from '@/lib/repositories/runDiscrepancyRecordRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { resolveMarkdownBodiesWorkItemRefs } from '@/lib/workItems/resolveWorkItemRefs';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { projectAccessService } from './projectAccessService';

// A CARD'S RUN DISCREPANCY RECORDS, for its Run discrepancy section (Task MOTIR-11996;
// `design/runs/design-notes.md` § _Run discrepancy — the record gets its own section on the
// work item page_). The record IS the discrepancy since `record_run_discrepancy` stopped
// writing a comment beside it, so this read is how a person sees one.
//
// ⚠️ WHO SEES IT is whoever may read the card: `project:browse` on its project, inside the
// card's workspace — the same scope the record's RLS policy (`app.workspace_id`) gives it.
// A reader who may not browse gets the 404-shaped `WorkItemNotFoundError`, like the item
// page's other reads.
//
// It reads the record and its entries ONLY — never the comment a run used to write, which a
// person may have edited or deleted. A record whose comment is gone reads in full.

export const runDiscrepancyReadService = {
  /** The card's records, newest first. `[]` when it has none — the section then draws nothing. */
  async listForWorkItem(
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<WorkItemRunDiscrepancyRecordDto[]> {
    const binding = { userId: ctx.userId, workspaceId: ctx.workspaceId };
    const item = await withWorkspaceContext(binding, (tx) =>
      workItemRepository.findById(workItemId, tx),
    );
    if (!item) throw new WorkItemNotFoundError(workItemId);
    await projectAccessService.assertPermission(item.projectId, ctx, 'project:browse');

    const records = await withWorkspaceContext({ ...binding, projectId: item.projectId }, (tx) =>
      runDiscrepancyRecordRepository.listByWorkItem(item.id, tx),
    );
    // ONE read resolves the cards every record links, for this reader (MOTIR-10023).
    const workItemRefs = await resolveMarkdownBodiesWorkItemRefs(
      records.flatMap(runDiscrepancyRecordBodies),
      ctx,
    );
    return records.map((record) => toWorkItemRunDiscrepancyRecordDto(record, workItemRefs));
  },
};
