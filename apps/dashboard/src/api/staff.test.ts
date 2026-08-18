import { describe, expect, it } from 'vitest';
import {
  ASSIGNABLE_ROLES,
  ROLE_LABEL,
  applyPermissionRules,
  changedPerms,
  roleOptionsFor,
  type StaffPerms,
} from './staff.js';

const NONE: StaffPerms = {
  dashboard: false,
  appointments: false,
  shop: false,
  loyalty: false,
  team: false,
  scanner: false,
  charges: false,
  void: false,
  marketing: false,
};

/**
 * `void` IMPLIES `charges`, both directions — the rule the server enforces and
 * the UI has to agree with rather than argue with.
 *
 * api-contract.md § StaffUser: "void is meaningless without charges". Granting
 * `void` with `charges` off is a 400 `void_requires_charges`; revoking `charges`
 * revokes `void` silently in the same UPDATE. A UI that sent the raw click gets
 * a rejection for the first and a surprise for the second — the chip stays lit
 * for a beat and then quietly goes out on the next refetch.
 */
describe('applyPermissionRules — the void/charges dependency', () => {
  it('granting void grants charges with it, because it cannot exist alone', () => {
    const next = applyPermissionRules(NONE, 'void', true);
    expect(next.void).toBe(true);
    expect(next.charges).toBe(true);
  });

  it('revoking charges revokes void with it, visibly and in the same request', () => {
    const senior: StaffPerms = { ...NONE, charges: true, void: true };
    const next = applyPermissionRules(senior, 'charges', false);
    expect(next.charges).toBe(false);
    expect(next.void).toBe(false);
  });

  it('revoking void alone leaves charges standing — that combination is legal', () => {
    const senior: StaffPerms = { ...NONE, charges: true, void: true };
    const next = applyPermissionRules(senior, 'void', false);
    expect(next.void).toBe(false);
    expect(next.charges).toBe(true);
  });

  it('granting charges does not grant void — seniority is not implied upward', () => {
    const next = applyPermissionRules(NONE, 'charges', true);
    expect(next.charges).toBe(true);
    expect(next.void).toBe(false);
  });

  it('never produces void-without-charges, whichever key is clicked', () => {
    const states: StaffPerms[] = [
      NONE,
      { ...NONE, charges: true },
      { ...NONE, charges: true, void: true },
    ];
    for (const before of states) {
      for (const key of ['charges', 'void'] as const) {
        for (const next of [true, false]) {
          const after = applyPermissionRules(before, key, next);
          // The one state the database CHECK forbids.
          expect(after.void && !after.charges).toBe(false);
        }
      }
    }
  });
});

/**
 * The patch carries only what moved. Not an optimisation: a full echo would make
 * the server's audit row claim nine permissions "changed" to the values they
 * already held, and that log is the record of who altered someone's authority.
 */
describe('changedPerms — only what moved reaches the wire', () => {
  it('is empty when nothing changed', () => {
    expect(changedPerms(NONE, { ...NONE })).toEqual({});
  });

  it('carries the moved keys and no others', () => {
    const after: StaffPerms = { ...NONE, charges: true, void: true };
    expect(changedPerms(NONE, after)).toEqual({ charges: true, void: true });
  });

  it('carries a revoke as false rather than omitting it', () => {
    const before: StaffPerms = { ...NONE, scanner: true };
    // Omitting the key would mean "leave it alone" to the server, which is the
    // opposite of what the merchant just clicked.
    expect(changedPerms(before, NONE)).toEqual({ scanner: false });
  });
});

/**
 * The design's select offers four roles and no `owner`. An account that already
 * holds `owner` still has to render its own role truthfully — showing an owner as
 * "Manager" because the list lacks her role would misreport authority on the one
 * screen whose job is reporting authority.
 */
describe('roleOptionsFor', () => {
  it("offers the design's four for an assignable role, in its order", () => {
    expect(roleOptionsFor('frontdesk').map((o) => o.value)).toEqual([...ASSIGNABLE_ROLES]);
  });

  it('prepends owner when the account already is one, so the select can show it', () => {
    const values = roleOptionsFor('owner').map((o) => o.value);
    expect(values[0]).toBe('owner');
    expect(values).toHaveLength(ASSIGNABLE_ROLES.length + 1);
  });

  it('always contains the current role, for every role the contract defines', () => {
    // api-contract.md § StaffUser. A role missing from its own select is a
    // silent misreport, so this covers the enum rather than a sample of it.
    for (const role of ['owner', 'manager', 'frontdesk', 'artist', 'scanner']) {
      expect(roleOptionsFor(role).map((o) => o.value)).toContain(role);
    }
  });

  it('labels artist as Stylist — the design word for the contract value', () => {
    // The design draws `<option value="stylist">`, which the API rejects. The
    // label is the design's; only the wire value is corrected.
    expect(ROLE_LABEL['artist']).toBe('Stylist');
    expect(roleOptionsFor('artist').find((o) => o.value === 'artist')?.label).toBe('Stylist');
  });
});
