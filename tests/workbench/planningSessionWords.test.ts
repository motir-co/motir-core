import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { OUT_OF_CREDITS_CODE } from '@/lib/planning/planEditsClient';
import {
  entryControlsOf,
  leftLineKeyOf,
  nextStepKeyOf,
  waitingPlanStateKeyOf,
  RESUME_REASON_CODES,
  RESUME_REFUSAL_KEYS,
  refusalEndsWaiting,
  resumeReasonKeyOf,
  resumeRefusalKeyOf,
  stopPhraseKeyOf,
} from '../../app/(authed)/workbench/_components/planningSessionWords';

// The words of a failed planning session's To resume entry (MOTIR-7917) — pure, so no React.

describe('stopPhraseKeyOf — where the walk stopped, in the progress line’s step words', () => {
  it('lay + title → Laying {title}', () => {
    expect(stopPhraseKeyOf({ stopPhase: 'lay', stopTitle: 'Export' })).toBe('lay');
  });
  it('lay, no title → the project’s top level', () => {
    expect(stopPhraseKeyOf({ stopPhase: 'lay', stopTitle: null })).toBe('layTop');
  });
  it('author + title → Writing {title}', () => {
    expect(stopPhraseKeyOf({ stopPhase: 'author', stopTitle: 'Export' })).toBe('author');
  });
  it('no phase → Drafting a new item (and an author with nothing to name falls to it)', () => {
    expect(stopPhraseKeyOf({ stopPhase: null, stopTitle: null })).toBe('draft');
    expect(stopPhraseKeyOf({ stopPhase: 'author', stopTitle: null })).toBe('draft');
  });
  // MOTIR-11256 — a walk stopped in the reconcile, the final check or its fix names
  // that step, never the lay it used to be reported as.
  it('amend → Reconciling the items under {title}, or at the top level', () => {
    expect(stopPhraseKeyOf({ stopPhase: 'amend', stopTitle: 'Export' })).toBe('amend');
    expect(stopPhraseKeyOf({ stopPhase: 'amend', stopTitle: null })).toBe('amendTop');
  });
  it('check and repair name the final check, with or without a card title', () => {
    for (const stopTitle of ['Export', null]) {
      expect(stopPhraseKeyOf({ stopPhase: 'check', stopTitle })).toBe('check');
      expect(stopPhraseKeyOf({ stopPhase: 'repair', stopTitle })).toBe('repair');
    }
  });
  it('every stop key has words in both locales, and none says "dry run"', () => {
    for (const key of ['amend', 'amendTop', 'check', 'repair'] as const) {
      expect(en.workbench.planningSession.stop[key]).toBeTruthy();
      expect(zh.workbench.planningSession.stop[key]).toBeTruthy();
      expect(en.workbench.planningSession.stop[key]).not.toMatch(/dry.?run/i);
    }
  });
});

describe('resumeReasonKeyOf — TOTAL over the eight stored codes', () => {
  it('returns a key for each code, and every key has words in both locales', () => {
    for (const code of RESUME_REASON_CODES) {
      expect(resumeReasonKeyOf(code)).toBe(code);
      expect(en.workbench.planningSession.reason[code]).toBeTruthy();
      expect(zh.workbench.planningSession.reason[code]).toBeTruthy();
    }
    expect(RESUME_REASON_CODES).toHaveLength(8);
  });
  it('an unknown or missing code reads as `internal`, never the raw code', () => {
    expect(resumeReasonKeyOf('quantum_flux')).toBe('internal');
    expect(resumeReasonKeyOf(null)).toBe('internal');
    expect(resumeReasonKeyOf(undefined)).toBe('internal');
  });
});

describe('resumeRefusalKeyOf — TOTAL over the resume route’s refusals', () => {
  it.each([
    ['RESUME_ALREADY_STARTED', null, 'alreadyStarted'],
    ['PLAN_SESSION_ENDED', 409, 'ended'],
    ['SESSION_ENDED', null, 'ended'],
    ['SESSION_NOT_FAILED', 409, 'notFailed'],
    ['NOT_SESSION_OWNER', 403, 'notOwner'],
    ['PLAN_NOT_RESUMABLE', 409, 'notResumable'],
    // MOTIR-8570 — motir-ai REFUSED the resume (a 400 `validation_error`, which core's client
    // raises as `MotirAiBadRequestError` and the route answers as a 502). Nothing was unreachable
    // and nothing will change on a retry, so it reads as "can't be continued", not as an outage.
    ['MOTIR_AI_BAD_REQUEST', 502, 'notResumable'],
    [OUT_OF_CREDITS_CODE, 402, 'credits'],
    [null, 402, 'credits'],
    ['SOMETHING_ELSE', 502, 'unavailable'],
    [null, null, 'unavailable'],
  ] as const)('%s / %s → %s', (code, status, expected) => {
    expect(resumeRefusalKeyOf(code, status)).toBe(expected);
  });

  it('every key that is an error has a sentence in both locales', () => {
    for (const key of RESUME_REFUSAL_KEYS) {
      if (key === 'alreadyStarted') continue; // not an error: it reads as resuming
      expect(en.workbench.planningSession.refusal[key]).toBeTruthy();
      expect(zh.workbench.planningSession.refusal[key]).toBeTruthy();
    }
  });

  // `notResumable` joined them in MOTIR-9121: the server records the attempt as not resumable
  // and releases it, so the same Resume is never offered again.
  it('only `ended`, `notFailed` and `notResumable` say the session no longer waits', () => {
    expect(RESUME_REFUSAL_KEYS.filter(refusalEndsWaiting).sort()).toEqual([
      'ended',
      'notFailed',
      'notResumable',
    ]);
  });
});

describe('situation 2 (MOTIR-7940)', () => {
  it('Resume is offered ONLY on a failed walk; Open on every form', () => {
    expect(entryControlsOf('failed_walk')).toEqual({ resume: true, open: true });
    expect(entryControlsOf('failed_beside_waiting_plan')).toEqual({ resume: false, open: true });
    expect(entryControlsOf('ended_with_waiting_plan')).toEqual({ resume: false, open: true });
  });

  it('the waiting plan’s state and next step are total over planned / stale, with words in both locales', () => {
    expect(waitingPlanStateKeyOf('planned')).toBe('stateWaiting');
    expect(waitingPlanStateKeyOf('stale')).toBe('stateStale');
    expect(nextStepKeyOf('planned')).toBe('nextReply');
    expect(nextStepKeyOf('stale')).toBe('nextAgain');
    for (const messages of [en, zh]) {
      const b = messages.workbench.planningSession.form.b;
      for (const key of ['stateWaiting', 'stateStale', 'nextReply', 'nextAgain'] as const) {
        expect(b[key]).toBeTruthy();
      }
    }
  });

  it('the held line says why an entry left — and a failed walk never takes one', () => {
    expect(leftLineKeyOf('failed_walk', null, false)).toBeNull();
    expect(leftLineKeyOf('failed_beside_waiting_plan', 'planned', false)).toBe('turn');
    expect(leftLineKeyOf('failed_beside_waiting_plan', 'stale', false)).toBe('again');
    expect(leftLineKeyOf('ended_with_waiting_plan', 'planned', false)).toBe('carry');
    expect(leftLineKeyOf('ended_with_waiting_plan', 'planned', true)).toBe('decided');
    for (const key of ['turn', 'carry', 'decided', 'again'] as const) {
      expect(en.workbench.planningSession.left[key]).toBeTruthy();
      expect(zh.workbench.planningSession.left[key]).toBeTruthy();
    }
  });

  it('no new string leaks an internal word', () => {
    const own = {
      ...en.workbench.planningSession.form.b,
      ...en.workbench.planningSession.form.c,
      ...en.workbench.planningSession.left,
    };
    for (const text of Object.values(own))
      expect(text).not.toMatch(/generating|planned|stale|session/i);
  });
});

describe('the exhaustive switches fail loudly on a form this build does not know', () => {
  it('entryControlsOf and the form body return the unknown value rather than a Resume', async () => {
    const { PlanningSessionFormBody } =
      await import('../../app/(authed)/workbench/_components/PlanningSessionResumeForms');
    expect(entryControlsOf('mystery' as never)).toBe('mystery');
    expect(PlanningSessionFormBody({ entry: { form: 'mystery' } as never })).toBe('mystery');
  });
});
