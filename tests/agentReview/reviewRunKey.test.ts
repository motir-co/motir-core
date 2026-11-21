import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  gateIdOfReviewRunKey,
  reviewAgentRunKey,
  reviewItemRunKey,
  reviewItemRunKeyPrefix,
  reviewOwnAgentRunKey,
  reviewPressKey,
  reviewRunKeyPrefix,
} from '@/lib/agentReview/reviewRunKey';

// WHICH GATE A REVIEW RUN ANSWERS, read back off its idempotency key (Story MOTIR-11941 ·
// MOTIR-11944 / MOTIR-11945 / MOTIR-11952). Every review run's key is either under its
// GATE's prefix (a press, or a review in the person's own agent) or under its ITEM's
// gate-off prefix, and only the first names a gate.

const digest = (version: string) => createHash('sha256').update(version).digest('hex');

describe('a review run key', () => {
  it('spells a press and an own-agent review under the gate’s prefix', () => {
    expect(reviewRunKeyPrefix('g1')).toBe('agent-review:g1:');
    expect(reviewPressKey('g1', 2)).toBe('agent-review:g1:press:2');
    expect(reviewAgentRunKey('g1', 'k7')).toBe('agent-review:g1:agent:k7');
    expect(reviewPressKey('g1', 2).startsWith(reviewRunKeyPrefix('g1'))).toBe(true);
  });

  it('spells a gate-off review under the item and the DIGEST of its version', () => {
    const version = 'acme/app#1@abc,acme/api#2@def';
    expect(reviewItemRunKeyPrefix('w1', version)).toBe(`agent-review-item:w1:${digest(version)}:`);
    expect(reviewItemRunKey('w1', version, 'r1')).toBe(
      `agent-review-item:w1:${digest(version)}:r1`,
    );
    // Deterministic for its request id; a different version is a different namespace.
    expect(reviewItemRunKey('w1', version, 'r1')).toBe(reviewItemRunKey('w1', version, 'r1'));
    expect(reviewItemRunKeyPrefix('w1', `${version},x`)).not.toBe(
      reviewItemRunKeyPrefix('w1', version),
    );
  });

  it('keys an own-agent review by the gate with Review on, else by the item', () => {
    expect(reviewOwnAgentRunKey('w1', { gateId: 'g1', subjectVersion: 'v' }, 'k7')).toBe(
      'agent-review:g1:agent:k7',
    );
    expect(reviewOwnAgentRunKey('w1', { gateId: null, subjectVersion: 'v' }, 'k7')).toBe(
      `agent-review-item:w1:${digest('v')}:agent:k7`,
    );
  });

  it('reads the gate back off a gate key, and none off any other key', () => {
    expect(gateIdOfReviewRunKey(reviewPressKey('g1', 1))).toBe('g1');
    expect(gateIdOfReviewRunKey(reviewAgentRunKey('g2', 'k'))).toBe('g2');
    expect(gateIdOfReviewRunKey(reviewItemRunKey('w1', 'v', 'r'))).toBeNull();
    expect(gateIdOfReviewRunKey('agent-review:')).toBeNull();
    expect(gateIdOfReviewRunKey('agent-review::press:1')).toBeNull();
    expect(gateIdOfReviewRunKey('run:abc')).toBeNull();
    expect(gateIdOfReviewRunKey(null)).toBeNull();
    expect(gateIdOfReviewRunKey(undefined)).toBeNull();
  });
});
