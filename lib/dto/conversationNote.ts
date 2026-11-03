/**
 * One plain-language note a conversation job wrote while it worked (MOTIR-10235)
 * — a Grill me read or an answering session, in the session's own words. `jobId`
 * is the job that wrote it, so a surface can draw each job's notes beside the
 * turn that job produced (or in place of its "reading" line while it runs).
 */
export interface ConversationNoteDto {
  jobId: string;
  body: string;
}
