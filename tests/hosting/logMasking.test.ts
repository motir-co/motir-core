// MOTIR-12105 — masking a production log line and parsing the logs query: pure,
// no I/O. The two traps the card names are pinned here exhaustively — secrets
// that overlap or nest, and a filter that would otherwise probe a secret — with
// the service and route suites asserting the same rules end to end.
import { describe, expect, it } from 'vitest';
import { InvalidLogLimitError, InvalidLogRangeError } from '@/lib/hosting/errors';
import {
  connectionStringSecrets,
  LOG_SECRET_MASK,
  maskSecretValues,
  matchesOutsideSecrets,
  secretNeedles,
} from '@/lib/hosting/logMasking';
import {
  LOG_LIMIT_DEFAULT,
  LOG_LIMIT_MAX,
  logLimit,
  parseProductionLogQuery,
} from '@/lib/hosting/productionLogQuery';

const M = LOG_SECRET_MASK;

describe('secretNeedles', () => {
  it('orders the values longest first, drops empties and duplicates', () => {
    expect(secretNeedles(['ab', '', 'abcd', 'ab', 'xyz'])).toEqual(['abcd', 'xyz', 'ab']);
  });

  it('adds each non-blank line of a multi-line value beside the whole value', () => {
    const pem = '-----BEGIN KEY-----\r\nAAAA\n\n   \nBBBB\n-----END KEY-----';
    const needles = secretNeedles([pem]);
    expect(needles[0]).toBe(pem);
    expect(needles).toEqual(
      expect.arrayContaining(['-----BEGIN KEY-----', 'AAAA', 'BBBB', '-----END KEY-----']),
    );
    expect(needles).not.toContain('');
    expect(needles).not.toContain('   ');
  });

  it('masks a one-character secret too', () => {
    expect(secretNeedles(['x'])).toEqual(['x']);
  });
});

describe('connectionStringSecrets', () => {
  it('names the password, raw and decoded', () => {
    expect(connectionStringSecrets('postgres://app:p%40ss@db.example:5432/app')).toEqual([
      'p%40ss',
      'p@ss',
    ]);
    expect(connectionStringSecrets('postgres://app:plain@db/app')).toEqual(['plain']);
  });

  it('names nothing for a value that is not a URL with a password', () => {
    expect(connectionStringSecrets('not a url')).toEqual([]);
    expect(connectionStringSecrets('https://user@example.com/')).toEqual([]);
    expect(connectionStringSecrets('https://example.com/')).toEqual([]);
  });

  it('keeps the encoded form alone when it does not decode', () => {
    expect(connectionStringSecrets('postgres://app:%E0%A4%A@db/app')).toEqual(['%E0%A4%A']);
  });
});

describe('maskSecretValues', () => {
  it('replaces every occurrence of a value', () => {
    expect(maskSecretValues('token=abc and abc again', secretNeedles(['abc']))).toBe(
      `token=${M} and ${M} again`,
    );
  });

  it('masks a secret that contains another whole, as one mask', () => {
    const needles = secretNeedles(['pass', 'password123']);
    expect(maskSecretValues('pw=password123;', needles)).toBe(`pw=${M};`);
    expect(maskSecretValues('only pass here', needles)).toBe(`only ${M} here`);
  });

  it('masks the inner secret first given in either order the same way', () => {
    expect(maskSecretValues('x=password123', ['pass', 'password123'])).toBe(`x=${M}`);
  });

  it('leaves no character of two overlapping secrets', () => {
    expect(maskSecretValues('--abcd--', secretNeedles(['abc', 'bcd']))).toBe(`--${M}--`);
  });

  it('masks overlapping occurrences of one secret', () => {
    expect(maskSecretValues('aaaa', secretNeedles(['aa']))).toBe(M);
  });

  it('masks a multi-line secret printed one line at a time', () => {
    const needles = secretNeedles(['line-one-secret\nline-two-secret']);
    expect(maskSecretValues('got line-two-secret', needles)).toBe(`got ${M}`);
  });

  it('is case-sensitive: a value is masked as it is written', () => {
    expect(maskSecretValues('ABC abc', ['abc'])).toBe(`ABC ${M}`);
  });

  it('returns the line unchanged with no secrets', () => {
    expect(maskSecretValues('nothing to hide', [])).toBe('nothing to hide');
  });
});

describe('matchesOutsideSecrets', () => {
  const needles = secretNeedles(['hunter2secret']);

  it('keeps every line with no filter', () => {
    expect(matchesOutsideSecrets('x hunter2secret', needles, undefined)).toBe(true);
    expect(matchesOutsideSecrets('x', needles, '')).toBe(true);
    expect(matchesOutsideSecrets('x', needles, null)).toBe(true);
  });

  it('drops a line the filter matched only inside a secret', () => {
    expect(matchesOutsideSecrets('login hunter2secret ok', needles, 'hunter')).toBe(false);
    expect(matchesOutsideSecrets('login hunter2secret ok', needles, 'r2s')).toBe(false);
  });

  it('drops a line the filter matched only across a secret boundary', () => {
    expect(matchesOutsideSecrets('xhunter2secret', needles, 'xh')).toBe(false);
  });

  it('keeps a line whose visible text holds the filter, in any case', () => {
    expect(matchesOutsideSecrets('Hunter logged in, pw hunter2secret', needles, 'hunter')).toBe(
      true,
    );
    expect(matchesOutsideSecrets('ERROR: boom', needles, 'error')).toBe(true);
  });

  it('never matches the mask text in place of a secret', () => {
    expect(matchesOutsideSecrets('pw hunter2secret', needles, M)).toBe(false);
  });

  it('refuses a filter carrying the stand-in character', () => {
    expect(matchesOutsideSecrets('a\u0000b', [], '\u0000')).toBe(false);
  });
});

describe('parseProductionLogQuery', () => {
  it('defaults the limit and leaves the rest out', () => {
    expect(parseProductionLogQuery({})).toEqual({ limit: LOG_LIMIT_DEFAULT });
    expect(
      parseProductionLogQuery({ since: '', until: null, q: '', limit: null, cursor: '' }),
    ).toEqual({ limit: LOG_LIMIT_DEFAULT });
  });

  it('parses every parameter', () => {
    expect(
      parseProductionLogQuery({
        since: '2026-11-01T00:00:00Z',
        until: '2026-11-02',
        q: 'error',
        limit: '50',
        cursor: 'opaque',
      }),
    ).toEqual({
      since: new Date('2026-11-01T00:00:00Z'),
      until: new Date('2026-11-02T00:00:00Z'),
      filter: 'error',
      limit: 50,
      cursor: 'opaque',
    });
  });

  it('clamps a limit past the ceiling', () => {
    expect(parseProductionLogQuery({ limit: '5000' }).limit).toBe(LOG_LIMIT_MAX);
  });

  it.each(['0', '-1', '1.5', 'ten', ''])('refuses the limit %j', (limit) => {
    expect(() => parseProductionLogQuery({ limit })).toThrow(InvalidLogLimitError);
  });

  it.each([
    ['since', 'yesterday'],
    ['since', '1'],
    ['until', '2026-13-45T00:00:00Z'],
    ['until', '2026-11-01T25:00'],
  ])('refuses %s=%j', (field, value) => {
    expect(() => parseProductionLogQuery({ [field]: value })).toThrow(InvalidLogRangeError);
  });

  it('refuses a window that ends before it starts', () => {
    expect(() =>
      parseProductionLogQuery({ since: '2026-11-02T00:00:00Z', until: '2026-11-01T00:00:00Z' }),
    ).toThrow(InvalidLogRangeError);
  });
});

describe('logLimit', () => {
  it('defaults, clamps and refuses', () => {
    expect(logLimit(undefined)).toBe(LOG_LIMIT_DEFAULT);
    expect(logLimit(null)).toBe(LOG_LIMIT_DEFAULT);
    expect(logLimit(7)).toBe(7);
    expect(logLimit(LOG_LIMIT_MAX + 1)).toBe(LOG_LIMIT_MAX);
    expect(() => logLimit(0)).toThrow(InvalidLogLimitError);
    expect(() => logLimit(2.5)).toThrow(InvalidLogLimitError);
  });
});
