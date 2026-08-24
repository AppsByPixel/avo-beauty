import { describe, expect, it } from 'vitest';
import { auditEmptyLine } from '../routes/AuditLog.js';
import { auditScopeParam } from './audit.js';
import { parsePlatformSalonPage } from './platformSalons.js';

/**
 * The salon list parser and the `?salon=` scope, against the body the real
 * endpoint actually sent.
 *
 * THE FIXTURE IS A CAPTURED RESPONSE, not a hand-written shape — the seed's two
 * salons off `GET /v1/platform/salons` on `avo_lane_c`, with the API booted on
 * 4130 and an owner-console token. It carries three things a written fixture
 * would have got wrong and the screen depends on: `nameAr` present on one salon
 * and NULL on the other, the enums LOWERCASE on the wire against a design that
 * draws them capitalised, and a genuine `memberCount: 0` — which is a real zero
 * after data lands, and the reason the no-fabricated-zero rule is about PENDING
 * rather than about the digit.
 */
const WIRE = {
  items: [
    {
      id: 'SAL-AMARA',
      name: 'Amara',
      nameAr: 'أمارا',
      plan: 'growth',
      loyaltyMode: 'tiers',
      branchCount: 2,
      memberCount: 2,
      createdAt: '2026-08-24T11:03:52.265Z',
    },
    {
      id: 'SAL-LUMIERE',
      name: 'Lumiere',
      nameAr: null,
      plan: 'starter',
      loyaltyMode: 'tiers',
      branchCount: 2,
      memberCount: 0,
      createdAt: '2026-08-24T11:03:52.268Z',
    },
  ],
  nextCursor: null,
};

describe('parsePlatformSalonPage reads the real wire', () => {
  it('keeps both salons, the null nameAr and the lowercase enums', () => {
    const page = parsePlatformSalonPage(WIRE);
    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toEqual({
      id: 'SAL-AMARA',
      name: 'Amara',
      nameAr: 'أمارا',
      plan: 'growth',
      loyaltyMode: 'tiers',
      branchCount: 2,
      memberCount: 2,
      createdAt: '2026-08-24T11:03:52.265Z',
    });
    expect(page.items[1]?.nameAr).toBeNull();
    // A real zero survives. The rule the screen enforces is about pending, and a
    // parser that "helpfully" dropped a zero count would break the honest case.
    expect(page.items[1]?.memberCount).toBe(0);
  });

  it('carries a cursor when the server sends one', () => {
    expect(parsePlatformSalonPage({ ...WIRE, nextCursor: 'SAL-LUMIERE' }).nextCursor).toBe(
      'SAL-LUMIERE',
    );
  });

  /**
   * THE ENUMS ARE THE POINT OF PARSING RATHER THAN CASTING. `plan` picks a badge
   * token and `loyaltyMode` picks a word; an unrecognised value renders a badge
   * with no colour or the literal `undefined` into a cell. Asserting on the thing
   * — that it throws — and not on the sentence.
   */
  it('refuses a plan it cannot paint', () => {
    const bad = { ...WIRE, items: [{ ...WIRE.items[0], plan: 'enterprise' }] };
    expect(() => parsePlatformSalonPage(bad)).toThrow(/enterprise/);
  });

  it('refuses a loyalty mode it cannot name', () => {
    const bad = { ...WIRE, items: [{ ...WIRE.items[0], loyaltyMode: 'points' }] };
    expect(() => parsePlatformSalonPage(bad)).toThrow(/points/);
  });

  it('refuses a count that is not a whole number', () => {
    for (const memberCount of [1.5, -1, null, '2']) {
      const bad = { ...WIRE, items: [{ ...WIRE.items[0], memberCount }] };
      expect(() => parsePlatformSalonPage(bad)).toThrow(/memberCount/);
    }
  });

  it('refuses an nameAr that is neither a string nor null', () => {
    const bad = { ...WIRE, items: [{ ...WIRE.items[0], nameAr: 42 }] };
    expect(() => parsePlatformSalonPage(bad)).toThrow(/nameAr/);
  });

  it('refuses a body that is not the page shape at all', () => {
    expect(() => parsePlatformSalonPage(null)).toThrow(/not an object/);
    expect(() => parsePlatformSalonPage({ items: 'none', nextCursor: null })).toThrow(/items/);
    expect(() => parsePlatformSalonPage({ items: [], nextCursor: 7 })).toThrow(/nextCursor/);
  });
});

/**
 * ONE WIRE PARAMETER, TWO ENTRY SHAPES. `?salon=` takes the `platform` literal or
 * a salon id and never both, which is why the client models it as one field.
 */
describe('auditScopeParam collapses the scope onto one query value', () => {
  it('sends nothing for the unscoped read', () => {
    expect(auditScopeParam(null)).toBeNull();
  });

  it('sends the platform literal', () => {
    expect(auditScopeParam('platform')).toBe('platform');
  });

  it('sends a salon id', () => {
    expect(auditScopeParam({ salonId: 'SAL-AMARA' })).toBe('SAL-AMARA');
  });
});

/**
 * The empty line names the salon it filtered on. The regression this pins is the
 * one the row-365 audit found on the merchant screen: a filter that is invisible
 * in the sentence turns "you narrowed to Amara and it has no Money rows" into
 * "the platform has no Money rows".
 */
describe('auditEmptyLine names a salon scope', () => {
  it('names the salon alone', () => {
    expect(auditEmptyLine('', null, 'Amara')).toBe('No entries from Amara yet.');
  });

  it('names the salon and the kind together', () => {
    expect(auditEmptyLine('', 'money', 'Amara')).toBe('No Money entries from Amara yet.');
  });

  it('names the salon and the search together', () => {
    expect(auditEmptyLine('noura', 'risk', 'Amara')).toBe(
      'No Risk entries from Amara match “noura”.',
    );
  });

  it('still names the platform literal by its phrase', () => {
    expect(auditEmptyLine('', null, 'AVO platform actions')).toBe(
      'No entries from AVO platform actions yet.',
    );
  });

  it('leaves the unfiltered sentence alone', () => {
    expect(auditEmptyLine('', null, null)).toBe('No entries match that search.');
  });
});
