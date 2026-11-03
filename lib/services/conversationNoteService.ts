import type { Prisma } from '@/generated/prisma/client';
import {
  ConversationNotesInvalidError,
  ConversationNotesOwnerNotFoundError,
} from '@/lib/conversationNotes/errors';
import type { ConversationNoteDto } from '@/lib/dto/conversationNote';
import { toConversationNoteDto } from '@/lib/mappers/conversationNoteMappers';
import { cleanNarrationSentence, PLAN_NARRATION_BATCH_MAX } from '@/lib/plans/planNarration';
import {
  conversationNoteRepository,
  type ConversationNoteOwner,
} from '@/lib/repositories/conversationNoteRepository';
import { planChangeTurnRepository } from '@/lib/repositories/planChangeTurnRepository';
import { sharpenTurnRepository } from '@/lib/repositories/sharpenTurnRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// A CONVERSATION JOB'S NOTES (MOTIR-10235) — what a Grill me read (`sharpen_turn`)
// or an answering session (`ask_project`) said, in its own words, while it
// worked. motir-ai streams each one live as a `note` frame and posts it here, so
// the rail can draw it again after the person leaves and comes back.
//
// The planning walk's twin is `plansService.recordPlanNarration`, and the caps and
// the cleaner are ITS (`lib/plans/planNarration.ts`): a conversation note is the
// same kind of sentence, so it is held to the same shape.
//
// ⚠️ THE OWNER IS RESOLVED FROM THE JOB, never named by the caller. A job's person
// turn (Grill me) or its conversation turn (the ASK door) says which conversation
// it was submitted for, within the job token's project and workspace — so a token
// cannot write a note into another project's conversation by naming it.

/** The newest notes a conversation's read carries. */
export const CONVERSATION_NOTES_READ_MAX = 400;

export interface RecordConversationNotesInput {
  jobId: string;
  notes: readonly string[];
}

export interface RecordConversationNotesAuth {
  ctx: { userId: string; workspaceId: string };
  projectId: string;
}

/** Each note cleaned, or a typed refusal — never a silently dropped sentence. */
function cleanNotes(notes: readonly string[]): string[] {
  if (notes.length === 0) {
    throw new ConversationNotesInvalidError('`notes` carries at least one sentence.');
  }
  if (notes.length > PLAN_NARRATION_BATCH_MAX) {
    throw new ConversationNotesInvalidError(
      `\`notes\` carries at most ${PLAN_NARRATION_BATCH_MAX} sentences per call.`,
    );
  }
  return notes.map((raw) => {
    const clean = cleanNarrationSentence(raw);
    if (clean === null) throw new ConversationNotesInvalidError('A note is blank.');
    return clean;
  });
}

async function ownerOf(
  jobId: string,
  auth: RecordConversationNotesAuth,
  tx: Prisma.TransactionClient,
): Promise<ConversationNoteOwner> {
  const { workspaceId } = auth.ctx;
  const grill = await sharpenTurnRepository.findPersonTurnByJobInProject(
    jobId,
    auth.projectId,
    workspaceId,
    tx,
  );
  if (grill) return { sharpenSessionId: grill.sessionId };
  const asked = await planChangeTurnRepository.findSessionIdByJobInProject(
    jobId,
    auth.projectId,
    workspaceId,
    tx,
  );
  if (asked) return { planChangeSessionId: asked.sessionId };
  throw new ConversationNotesOwnerNotFoundError(jobId);
}

export const conversationNoteService = {
  /** Append a job's notes to the conversation it was submitted for. */
  async record(
    input: RecordConversationNotesInput,
    auth: RecordConversationNotesAuth,
  ): Promise<{ stored: number }> {
    const bodies = cleanNotes(input.notes);
    return withWorkspaceContext({ ...auth.ctx, projectId: auth.projectId }, async (tx) => {
      const owner = await ownerOf(input.jobId, auth, tx);
      // One job's batches append one at a time: `seq` stays gapless per job.
      await conversationNoteRepository.lockJob(input.jobId, tx);
      const from = await conversationNoteRepository.maxSeq(input.jobId, tx);
      const rows = await conversationNoteRepository.createMany(
        bodies.map((body, i) => ({
          workspaceId: auth.ctx.workspaceId,
          jobId: input.jobId,
          seq: from + i + 1,
          body,
          sharpenSessionId: 'sharpenSessionId' in owner ? owner.sharpenSessionId : null,
          planChangeSessionId: 'planChangeSessionId' in owner ? owner.planChangeSessionId : null,
        })),
        tx,
      );
      return { stored: rows.length };
    });
  },

  /** A conversation's notes, oldest first, inside the caller's bound transaction. */
  async listFor(
    owner: ConversationNoteOwner,
    tx: Prisma.TransactionClient,
  ): Promise<ConversationNoteDto[]> {
    const rows = await conversationNoteRepository.listLatestByOwner(
      owner,
      CONVERSATION_NOTES_READ_MAX,
      tx,
    );
    return rows.map(toConversationNoteDto);
  },
};
