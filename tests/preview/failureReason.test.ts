// MOTIR-5779 — a failed preview's stored reason is recognised as one of the
// lifecycle's own templates (so another language shows the translated sentence)
// or shown verbatim. Fed the lifecycle's LITERAL output, so a change to a
// template in `previewLifecycleService.ts` turns this red instead of silently
// falling back to English.
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import { knownFailureReason } from '@/lib/preview/failureReason';

describe('knownFailureReason', () => {
  it('recognises the image-build failure with its conclusion', () => {
    expect(
      knownFailureReason(
        'The preview image did not build: the "Preview image" workflow ended with "failure". Its run log on GitHub says why.',
      ),
    ).toEqual({ key: 'imageBuild', values: { conclusion: 'failure' } });
  });

  it('recognises the health-check timeout with its minutes, and the failed check', () => {
    expect(
      knownFailureReason('The preview did not pass its health check within 10 minutes.'),
    ).toEqual({ key: 'healthTimeout', values: { minutes: '10' } });
    expect(knownFailureReason('The preview started but failed its health check.')).toEqual({
      key: 'healthFailed',
      values: {},
    });
  });

  it('shows anything else verbatim', () => {
    expect(knownFailureReason('Motir could not start the preview: quota exceeded')).toBeNull();
    expect(knownFailureReason('')).toBeNull();
  });

  it('each template is the English copy the page would show', () => {
    const copy = en.previewGate.failed.reason;
    expect(copy.imageBuild.replace('{conclusion}', 'failure')).toBe(
      'The preview image did not build: the "Preview image" workflow ended with "failure". Its run log on GitHub says why.',
    );
    expect(copy.healthTimeout.replace('{minutes}', '10')).toBe(
      'The preview did not pass its health check within 10 minutes.',
    );
    expect(copy.healthFailed).toBe('The preview started but failed its health check.');
  });
});
