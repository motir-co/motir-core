import { describe, expect, it } from 'vitest';
import {
  PLAN_REGISTRATION_BATCH_MAX,
  PLAN_REGISTRATION_FIELD_MAX,
  PlanRegistrationRefusal,
  parsePlanRegistrationEntries,
  parsePlanRegistrationEntry,
} from '@/lib/plans/planAuthorRegistration';

// The pure half of MOTIR-11085: what a `registrations` entry may say, and what is stored of it.

const handOff = {
  op: 'register',
  id: ' reg-1 ',
  kind: 'hand_off',
  session: 'planItem:adapter',
  level: 'planItem:story',
  receiver: 'planItem:role',
  what: '  Create the role. ',
  reason: 'owned_elsewhere',
};

const rename = {
  op: 'register',
  id: 'reg-2',
  kind: 'rename',
  session: 'planItem:adapter',
  from: 'UserRole',
  to: 'MemberRole',
  codeFact: 'prisma/schema.prisma already names MemberRole',
};

describe('parsePlanRegistrationEntry — a hand-off', () => {
  it('keeps its fields trimmed, drops a rename’s, and reads relayed as false by default', () => {
    expect(parsePlanRegistrationEntry({ ...handOff, from: 'x', to: 'y', codeFact: 'z' })).toEqual({
      op: 'register',
      id: 'reg-1',
      kind: 'hand_off',
      session: 'planItem:adapter',
      level: 'planItem:story',
      receiver: 'planItem:role',
      what: 'Create the role.',
      reason: 'owned_elsewhere',
      from: null,
      to: null,
      codeFact: null,
      relayed: false,
    });
  });

  it('reads an absent level as the top level, and carries relayed: true', () => {
    const { level: _level, ...top } = handOff;
    expect(parsePlanRegistrationEntry({ ...top, relayed: true })).toMatchObject({
      level: null,
      relayed: true,
    });
  });

  it('keeps line breaks in `what` and drops every other control character', () => {
    expect(
      parsePlanRegistrationEntry({ ...handOff, what: 'one\r\ntwo\u0007three', receiver: 'a\nb' }),
    ).toMatchObject({ what: 'one\ntwo three', receiver: 'a b' });
  });

  it('caps a long field with an ellipsis', () => {
    const r = parsePlanRegistrationEntry({ ...handOff, what: 'x'.repeat(5000) }) as {
      what: string;
    };
    expect(Array.from(r.what)).toHaveLength(PLAN_REGISTRATION_FIELD_MAX.what);
    expect(r.what.endsWith('…')).toBe(true);
  });

  it.each([
    [null, /must be an object/],
    [[], /must be an object/],
    [{ ...handOff, op: 'close' }, /\.op must be one of: register, relay/],
    [{ ...handOff, kind: 'move' }, /\.kind must be one of: hand_off, rename/],
    [{ ...handOff, id: ' ' }, /\.id is required/],
    [{ ...handOff, session: undefined }, /\.session is required/],
    [{ ...handOff, receiver: null }, /\.receiver is required/],
    [{ ...handOff, what: '' }, /\.what is required/],
    [{ ...handOff, reason: undefined }, /\.reason is required/],
    [{ ...handOff, what: 3 }, /\.what must be a string/],
    [{ ...handOff, relayed: 'yes' }, /\.relayed must be a boolean/],
  ])('refuses %j', (raw, message) => {
    expect(() => parsePlanRegistrationEntry(raw)).toThrow(PlanRegistrationRefusal);
    expect(() => parsePlanRegistrationEntry(raw)).toThrow(message);
  });
});

describe('parsePlanRegistrationEntry — a rename', () => {
  it('keeps its fields and drops a hand-off’s', () => {
    expect(parsePlanRegistrationEntry({ ...rename, receiver: 'r', what: 'w' })).toEqual({
      op: 'register',
      id: 'reg-2',
      kind: 'rename',
      session: 'planItem:adapter',
      level: null,
      receiver: null,
      what: null,
      reason: null,
      from: 'UserRole',
      to: 'MemberRole',
      codeFact: 'prisma/schema.prisma already names MemberRole',
      relayed: false,
    });
  });

  it.each([
    [{ ...rename, from: undefined }, /\.from is required/],
    [{ ...rename, to: '' }, /\.to is required/],
    [{ ...rename, codeFact: null }, /\.codeFact is required/],
  ])('refuses %j', (raw, message) => {
    expect(() => parsePlanRegistrationEntry(raw)).toThrow(message);
  });
});

describe('parsePlanRegistrationEntry — a relay', () => {
  it('keeps the outcome and its reason', () => {
    expect(
      parsePlanRegistrationEntry({
        op: 'relay',
        id: 'r',
        outcome: 'raised_as_gap',
        reason: ' no card ',
      }),
    ).toEqual({ op: 'relay', id: 'r', outcome: 'raised_as_gap', reason: 'no card' });
    expect(parsePlanRegistrationEntry({ op: 'relay', id: 'r', outcome: 'unsettled' })).toEqual({
      op: 'relay',
      id: 'r',
      outcome: 'unsettled',
      reason: null,
    });
  });

  it.each([
    [{ op: 'relay', id: 'r' }, /\.outcome must be one of: applied, raised_as_gap, unsettled/],
    [{ op: 'relay', id: 'r', outcome: 'done' }, /\.outcome must be one of/],
    [{ op: 'relay', outcome: 'applied' }, /\.id is required/],
  ])('refuses %j', (raw, message) => {
    expect(() => parsePlanRegistrationEntry(raw)).toThrow(message);
  });
});

describe('parsePlanRegistrationEntries — the whole call', () => {
  it('parses every entry in order', () => {
    expect(
      parsePlanRegistrationEntries([handOff, { op: 'relay', id: 'reg-1', outcome: 'applied' }]).map(
        (e) => e.op,
      ),
    ).toEqual(['register', 'relay']);
  });

  it('names the failing entry by its index', () => {
    expect(() => parsePlanRegistrationEntries([handOff, { ...rename, to: '' }])).toThrow(
      /^registrations\[1\]\.to/,
    );
  });

  it.each([
    [[]],
    ['nope'],
    [undefined],
    [Array.from({ length: PLAN_REGISTRATION_BATCH_MAX + 1 }, () => handOff)],
  ])('refuses an empty, oversized or non-array batch', (raw) => {
    expect(() => parsePlanRegistrationEntries(raw)).toThrow(/1 to 50 entries/);
  });
});
