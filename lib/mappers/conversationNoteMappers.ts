import type { ConversationNote } from '@/generated/prisma/client';
import type { ConversationNoteDto } from '@/lib/dto/conversationNote';

/** A stored conversation note as it crosses the API boundary (MOTIR-10235). */
export function toConversationNoteDto(row: ConversationNote): ConversationNoteDto {
  return { jobId: row.jobId, body: row.body };
}
