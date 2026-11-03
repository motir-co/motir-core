// Typed refusals of the conversation-note door (MOTIR-10235). Kept in their own
// file so the route can import them without the Prisma client (the
// lib/<domain>/errors.ts convention). `conversationNoteService` throws these;
// `app/api/internal/ai/conversation-notes/route.ts` maps each `code` to a status.

/** No Grill me turn and no conversation turn in the token's project carries the
 *  job — yet: motir-ai can report a note in the moment between submitting the job
 *  and core binding it to its turn, and retries this one. → 404 */
export class ConversationNotesOwnerNotFoundError extends Error {
  readonly code = 'CONVERSATION_NOTES_NOT_FOUND' as const;
  constructor(readonly jobId: string) {
    super(`No conversation in this project carries job ${jobId}.`);
    this.name = 'ConversationNotesOwnerNotFoundError';
  }
}

/** The notes are the wrong shape: none, too many, or one that is blank once
 *  cleaned. → 422 */
export class ConversationNotesInvalidError extends Error {
  readonly code = 'CONVERSATION_NOTES_INVALID' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ConversationNotesInvalidError';
  }
}
