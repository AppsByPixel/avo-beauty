/**
 * `queueScope` — the tenancy boundary that has no path segment.
 *
 * `GET /v1/support/tickets` is the one shared read in this API whose tenancy check
 * is not `requireSameSalon(p, req.params.id)`. api-contract.md § Operations gives
 * "Owner / Merchant | Support queue" ONE endpoint, so there is no salon id in the
 * path to compare against and the boundary is a `WHERE` clause instead. That makes
 * it invisible to a census over route paths, and it makes its absence silent: a
 * merchant read missing the predicate is not a 403 anybody notices, it is one salon
 * reading every other salon's customer correspondence.
 *
 * So the predicate is asserted here, and asserted as SQL rather than as an
 * endpoint's reply. A pure unit spec, no database — `api/vitest.config.ts` points
 * `DATABASE_URL` at port 1 on purpose — which is possible because `queueScope` takes
 * the principal and the query as arguments and returns conditions.
 *
 * WHAT THIS SPEC CANNOT COVER, stated rather than implied: the handlers themselves
 * are database-bound, so "the row that came back is the row the predicate allows" is
 * an endpoint-level assertion and belongs to Lane D in `e2e/`. Owed, and named in
 * the report: the #11 case (`POST` with `route: 'salon'` against an AVO-routed topic
 * stores `avo`), the cross-salon queue read, and the concurrent reorder.
 */

import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { and, type SQL } from 'drizzle-orm';
import { ApiError } from '../http/errors';
import { queueScope } from './support';
import type { PlatformPrincipal, StaffPrincipal } from '../auth/principal';

/**
 * `sqlToQuery` renders a condition to text and parameters with no connection —
 * the dialect is pure. So the assertions below are about the SQL that WOULD run,
 * which is the only thing worth asserting about a predicate.
 */
const dialect = new PgDialect();

function render(filters: SQL[]): { sql: string; params: unknown[] } {
  const combined = filters.length === 0 ? undefined : and(...filters);
  if (combined === undefined) return { sql: '', params: [] };
  const q = dialect.sqlToQuery(combined);
  return { sql: q.sql, params: q.params };
}

const MERCHANT: StaffPrincipal = {
  kind: 'staff',
  id: 'ST-001',
  salonId: 'SAL-AMARA',
  scope: 'dashboard',
  sessionId: 'sess-staff',
  name: 'Noura F.',
  role: 'manager',
  perms: {
    dashboard: true,
    appointments: true,
    shop: true,
    loyalty: true,
    team: true,
    scanner: true,
    charges: true,
    void: true,
    marketing: true,
  },
  branchAccessAll: true,
  branchAccessIds: [],
};

const CONSOLE: PlatformPrincipal = {
  kind: 'platform_admin',
  id: 'PLT-001',
  scope: 'platform',
  sessionId: 'sess-platform',
  name: 'Yousef',
  role: 'founder',
  owner: true,
  sections: {
    analytics: true,
    activity: true,
    salons: true,
    accounts: true,
    admins: true,
    controls: true,
    approvals: true,
    policies: true,
    audit: true,
  },
};

function refusal(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected a refusal, got none');
}

describe('queueScope — the merchant side', () => {
  /**
   * THE LOAD-BEARING CASE. Both halves of rule 2 with an empty query: the merchant
   * did not ask to be scoped, so a predicate that only appeared when she passed a
   * filter would be no predicate at all.
   */
  it('scopes an unfiltered merchant read to her own salon AND to salon-routed rows', () => {
    const { sql, params } = render(queueScope(MERCHANT, {}));

    expect(sql).toContain('"salon_id"');
    expect(sql).toContain('"route"');
    expect(params).toContain('SAL-AMARA');
    expect(params).toContain('salon');
    // Nothing else. Two conditions, two parameters.
    expect(params).toHaveLength(2);
  });

  it('keeps both conditions when she filters by status', () => {
    const { params } = render(queueScope(MERCHANT, { status: 'open' }));
    expect(params).toEqual(['SAL-AMARA', 'salon', 'open']);
  });

  /**
   * `?route=salon` is what her own console would send back, and it must not be able
   * to REPLACE the forced condition — only agree with it.
   */
  it('does not let ?route=salon substitute for the forced route condition', () => {
    const { params } = render(queueScope(MERCHANT, { route: 'salon' }));
    expect(params).toEqual(['SAL-AMARA', 'salon']);
  });

  /**
   * Rule 2's second half, and refused rather than narrowed: an empty page would say
   * "AVO has no tickets about you", which is a different and false statement.
   */
  it('refuses ?route=avo outright', () => {
    const e = refusal(() => queueScope(MERCHANT, { route: 'avo' }));
    expect(e.statusCode).toBe(403);
    expect(e.message).toContain('not visible to the salon');
  });

  it('refuses another salon by name', () => {
    const e = refusal(() => queueScope(MERCHANT, { salon: 'SAL-GLOW' }));
    expect(e.statusCode).toBe(403);
    expect(e.message).toBe('That salon is not yours.');
  });

  it('accepts her own salon as a redundant filter', () => {
    const { params } = render(queueScope(MERCHANT, { salon: 'SAL-AMARA' }));
    expect(params).toEqual(['SAL-AMARA', 'salon']);
  });
});

describe('queueScope — the console side', () => {
  /**
   * THE ABSENCE IS THE DIFFERENCE, exactly as it is between
   * `GET /salons/{id}/audit` and `GET /v1/platform/audit`. An unfiltered console
   * read has NO predicate — if this ever returns a condition, the console has
   * acquired a tenancy boundary it is not supposed to have.
   */
  it('builds no predicate at all for an unfiltered read', () => {
    expect(queueScope(CONSOLE, {})).toHaveLength(0);
  });

  it('narrows by route, status and salon, and only by those', () => {
    const { params } = render(
      queueScope(CONSOLE, { route: 'avo', status: 'closed', salon: 'SAL-GLOW' }),
    );
    expect(params).toEqual(['avo', 'SAL-GLOW', 'closed']);
  });

  it('reads the AVO queue, which the merchant cannot', () => {
    const { params } = render(queueScope(CONSOLE, { route: 'avo' }));
    expect(params).toEqual(['avo']);
  });
});

describe('queueScope — the enumerations', () => {
  /**
   * Refused by name for both audiences. A typo'd `route=slaon` returning an empty
   * page reads identically to "no tickets", and only one of those is worth acting
   * on — `GET /v1/platform/audit`'s reasoning about an unknown `?salon=`.
   */
  it('refuses an unknown route before it refuses anything else', () => {
    for (const p of [MERCHANT, CONSOLE]) {
      const e = refusal(() => queueScope(p, { route: 'slaon' }));
      expect(e.statusCode).toBe(400);
      expect(e.code).toBe('invalid_route');
    }
  });

  it('refuses an unknown status', () => {
    for (const p of [MERCHANT, CONSOLE]) {
      const e = refusal(() => queueScope(p, { status: 'resolved' }));
      expect(e.statusCode).toBe(400);
      expect(e.code).toBe('invalid_status');
    }
  });

  /**
   * An absent filter and a blank one are the same thing. A console sending
   * `?route=&status=` from an untouched form must not be refused, and — the half
   * that matters — an empty string must not become a filter that matches nothing.
   */
  it('treats a blank filter as absent', () => {
    expect(queueScope(CONSOLE, { route: '', status: '', salon: '' })).toHaveLength(0);
    const { params } = render(queueScope(MERCHANT, { route: '', status: '' }));
    expect(params).toEqual(['SAL-AMARA', 'salon']);
  });
});
