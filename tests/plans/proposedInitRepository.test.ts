import { describe, expect, it } from 'vitest';
import { InvalidProposalError } from '@/lib/plans/errors';
import {
  INIT_SUBJECT,
  assertProposedInitRepository,
} from '@/lib/plans/validateProposedInitRepository';

// MOTIR-11051 — the one rule an init card's declared repository answers to.
// Pure, so it is driven from hand-built proposals with no database.

const check = (fields: Parameters<typeof assertProposedInitRepository>[0]) => () =>
  assertProposedInitRepository(fields, '"Create motir-infra"');

function refusal(fields: Parameters<typeof assertProposedInitRepository>[0]): InvalidProposalError {
  try {
    check(fields)();
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidProposalError);
    return err as InvalidProposalError;
  }
  throw new Error('expected a refusal');
}

describe('assertProposedInitRepository', () => {
  it('names the init member as `init`', () => {
    expect(INIT_SUBJECT).toBe('init');
  });

  it('accepts a legal declaration on an init card carrying no pin', () => {
    expect(check({ subject: 'init', initRepositoryName: 'motir-infra' })).not.toThrow();
  });

  it('accepts a bare name in any casing', () => {
    expect(check({ subject: 'init', initRepositoryName: 'Motir-Infra' })).not.toThrow();
  });

  it('treats an absent or null declaration as no declaration at all', () => {
    expect(check({ subject: 'data' })).not.toThrow();
    expect(check({ subject: 'data', initRepositoryName: null })).not.toThrow();
    expect(check({ targetRepo: 'motir-core' })).not.toThrow();
  });

  it('treats a null or empty pin as no pin', () => {
    expect(
      check({
        subject: 'init',
        initRepositoryName: 'motir-infra',
        targetRepo: null,
        targetRepos: [],
        targetRepositories: [],
        targetRepositoryRef: null,
        targetRepoRole: null,
      }),
    ).not.toThrow();
  });

  it('refuses a declaration with no subject, naming the field and the init member', () => {
    const err = refusal({ initRepositoryName: 'motir-infra' });
    expect(err.code).toBe('INVALID_PROPOSAL');
    expect(err.message).toContain('initRepositoryName');
    expect(err.message).toContain('no subject');
    expect(err.message).toContain('`init`');
  });

  it('refuses a declaration whose subject is another member', () => {
    const err = refusal({ subject: 'data', initRepositoryName: 'motir-infra' });
    expect(err.message).toContain('subject `data`');
    expect(err.message).toContain('`init`');
  });

  it.each([
    ['targetRepo', { targetRepo: 'motir-infra' }],
    ['targetRepos', { targetRepos: ['motir-infra'] }],
    ['targetRepositories', { targetRepositories: ['cm_repo'] }],
    ['targetRepositoryRef', { targetRepositoryRef: 'cm_repo' }],
    ['targetRepoRole', { targetRepoRole: 'infra' }],
  ] as const)('refuses a declaration beside the `%s` pin, naming both', (key, pin) => {
    const err = refusal({ subject: 'init', initRepositoryName: 'motir-infra', ...pin });
    expect(err.message).toContain('initRepositoryName');
    expect(err.message).toContain(`\`${key}\``);
    expect(err.message).toContain('drop the pin');
  });

  it('names every pin when several travel together', () => {
    const err = refusal({
      subject: 'init',
      initRepositoryName: 'motir-infra',
      targetRepo: 'a',
      targetRepoRole: 'infra',
    });
    expect(err.message).toContain('`targetRepo`, `targetRepoRole`');
    expect(err.message).toContain('drop the pins');
  });

  it.each(['', '   ', 'motir infra', 'motir-co/motir-infra', 'tab\tname'])(
    'refuses the non-bare name %j, saying to send the bare repository name',
    (name) => {
      const err = refusal({ subject: 'init', initRepositoryName: name });
      expect(err.message).toContain('not a bare repository name');
      expect(err.message).toContain(`\`${name}\``);
    },
  );
});
