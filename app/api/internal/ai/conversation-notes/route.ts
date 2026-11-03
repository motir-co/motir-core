import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import {
  ConversationNotesInvalidError,
  ConversationNotesOwnerNotFoundError,
} from '@/lib/conversationNotes/errors';
import { conversationNoteService } from '@/lib/services/conversationNoteService';

// POST /api/internal/ai/conversation-notes (MOTIR-10235) — a CONVERSATION job's
// plain-language notes: a Grill me read (`sharpen_turn`) or an answering session
// (`ask_project`) says, in its own words, what it is doing, and motir-ai posts
// each sentence here as well as streaming it, so the rail draws it again after
// the person leaves and comes back. The planning walk's twin is `plan-step`'s
// `narration` form, whose caps and cleaner this door shares.
//
// Body: `{ jobId: string, notes: string[] }` (1..20 sentences). Answers
// `{ stored }`. The conversation is resolved FROM THE JOB, within the token's
// project and workspace, never named by the caller.
//
// Auth: §4a service bearer + §4b job token (`authenticateAndLimitJobRequest`),
// exactly as `plan-step`.
//
// The signal is ADVISORY, so every refusal is a stable `{ code, error }` and
// never a 500: motir-ai matches the code and carries on.
//
// Typed errors → status:
//   JobAuthError                           → 401
//   CONVERSATION_NOTES_INVALID (body shape) → 400; (a blank note, too many) → 422
//   ConversationNotesOwnerNotFoundError    → 404 (no turn carries the job yet —
//                                             motir-ai retries this one)

const INVALID = 'CONVERSATION_NOTES_INVALID';

function fail(code: string, error: string, status: number): NextResponse {
  return NextResponse.json({ code, error }, { status });
}

export async function POST(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await authenticateAndLimitJobRequest(req);
  } catch (err) {
    const failure = mapJobRequestError(err);
    if (failure) return failure;
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(INVALID, 'request body must be valid JSON', 400);
  }
  const { jobId, notes } = (body ?? {}) as Record<string, unknown>;
  if (typeof jobId !== 'string' || jobId.trim() === '') {
    return fail(INVALID, '`jobId` is required.', 400);
  }
  if (!Array.isArray(notes) || notes.some((n) => typeof n !== 'string')) {
    return fail(INVALID, '`notes` must be an array of strings.', 400);
  }

  try {
    const result = await conversationNoteService.record(
      { jobId, notes: notes as string[] },
      { ctx: auth.ctx, projectId: auth.projectId },
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ConversationNotesInvalidError) return fail(err.code, err.message, 422);
    if (err instanceof ConversationNotesOwnerNotFoundError) return fail(err.code, err.message, 404);
    throw err;
  }
}
