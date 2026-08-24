import { describe, expect, it } from 'vitest';
import { auditEmptyLine } from '../routes/AuditLog.js';
import { auditScopeParam } from './audit.js';
import { parsePlatformSalonPage } from './platformSalons.js';

/**
 * The salon list parser and the `?salon=` scope, against the body the real
 * endpoint actually sent.
 *
 * THE FIXTURE IS A CAPTURED RESPONSE, not a hand-written shape — off
 * `GET /v1/platform/salons` on `avo_lane_c`, API on 4130, owner-console token,
 * after onboarding a salon through the real wizard endpoint. It carries four
 * things a written fixture would have got wrong and the screen depends on:
 *
 *   - `nameAr` present on one salon and NULL on the other.
 *   - `city` PRESENT AND NULL on a seeded salon, present and real on an
 *     onboarded one. Migration 0037 made the column nullable, so the two
 *     coexist permanently and the City column has to render both.
 *   - the enums LOWERCASE on the wire, against a design that draws them
 *     capitalised.
 *   - a genuine `memberCount: 0`, which is a real zero after data lands and the
 *     reason the no-fabricated-zero rule is about PENDING rather than the digit.
 */
const WIRE = {
  items: [
    {
      id: 'SAL-AMARA',
      name: 'Amara',
      nameAr: 'أمارا',
      city: null,
      plan: 'growth',
      loyaltyMode: 'tiers',
      branchCount: 2,
      memberCount: 2,
      createdAt: '2026-08-24T11:37:38.149Z',
    },
    {
      id: 'SAL-GLOWBAR',
      name: 'Glow Bar',
      nameAr: null,
      city: 'Jabriya',
      plan: 'starter',
      loyaltyMode: 'stamps',
      branchCount: 1,
      memberCount: 0,
      createdAt: '2026-08-24T11:38:14.902Z',
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
      city: null,
      plan: 'growth',
      loyaltyMode: 'tiers',
      branchCount: 2,
      memberCount: 2,
      createdAt: '2026-08-24T11:37:38.149Z',
    });
    expect(page.items[1]?.nameAr).toBeNull();
    // The two city cases the column has to render, side by side on one page.
    expect(page.items[0]?.city).toBeNull();
    expect(page.items[1]?.city).toBe('Jabriya');
    // A real zero survives. The rule the screen enforces is about pending, and a
    // parser that "helpfully" dropped a zero count would break the honest case.
    expect(page.items[1]?.memberCount).toBe(0);
  });

  it('carries a cursor when the server sends one', () => {
    expect(parsePlatformSalonPage({ ...WIRE, nextCursor: 'SAL-GLOWBAR' }).nextCursor).toBe(
      'SAL-GLOWBAR',
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

  /**
   * A MISSING `city` KEY IS NOT THE SAME AS `city: null`, and this is the
   * assertion that says so. Null means "no city on record" and renders a dash;
   * absent means this client is talking to an API from before migration 0037, and
   * silently drawing an empty column for every salon would hide that entirely.
   */
  it('refuses a row with no city key at all, while accepting a null one', () => {
    const { city: _dropped, ...withoutCity } = WIRE.items[1] as { city: unknown };
    expect(() => parsePlatformSalonPage({ ...WIRE, items: [withoutCity] })).toThrow(/city/);
    expect(parsePlatformSalonPage({ ...WIRE, items: [WIRE.items[0]] }).items[0]?.city).toBeNull();
  });

  it('refuses a city that is neither a string nor null', () => {
    const bad = { ...WIRE, items: [{ ...WIRE.items[0], city: 7 }] };
    expect(() => parsePlatformSalonPage(bad)).toThrow(/city/);
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
