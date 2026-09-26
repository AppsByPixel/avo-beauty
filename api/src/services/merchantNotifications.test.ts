/**
 * The bell's two pure decisions: WHICH KINDS a reader may be told about, and
 * WHETHER A STORED `deep_link` IS FIT TO HAND A CLIENT.
 *
 * Everything else about this feature is a claim about a WHERE clause and lives in
 * `routes/merchantNotifications.int.test.ts` against real rows. These two are
 * functions of their arguments and nothing else, so they are pinned here where a
 * failure names the rule rather than the query.
 *
 * WHAT A UNIT SPEC CAN AND CANNOT SAY ABOUT THE FILTER. It can prove that
 * `visibleKinds` returns the right set for a given `perms`. It CANNOT prove that
 * the endpoint applies it — that is the integration file's § "permission-off, per
 * kind", which revokes each permission on a real staff row and requires the
 * corresponding row to leave a real response. Both halves are needed and neither
 * substitutes: a correct set never consulted is exactly the defect
 * non-negotiable #7 is about.
 */

import { describe, expect, it } from 'vitest';
import type { StaffPerms } from '../auth/principal';
import {
  KIND_PERMISSION,
  NOTIFICATION_KINDS,
  safeDeepLink,
  serialiseNotification,
  visibleKinds,
} from './merchantNotifications';

/** Every permission off. Each spec turns on exactly what it is about. */
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

const perms = (...on: (keyof StaffPerms)[]): StaffPerms => ({
  ...NONE,
  ...Object.fromEntries(on.map((k) => [k, true])),
});

describe('visibleKinds — the filter, one permission at a time', () => {
  /**
   * THE SEEDED FRONT DESK'S SHAPE, and the reason the union was rejected.
   * `ST-002` holds `appointments` and not `team`; a bell gated on
   * `team AND appointments AND marketing` would show her nothing at all,
   * including her own no-shows.
   */
  it('appointments alone sees no-shows and nothing else', () => {
    expect(visibleKinds(perms('appointments'))).toEqual(['booking_no_show']);
  });

  it('team alone sees disconnected calendars and nothing else', () => {
    expect(visibleKinds(perms('team'))).toEqual(['calendar_disconnected']);
  });

  it('marketing alone sees held campaigns and nothing else', () => {
    expect(visibleKinds(perms('marketing'))).toEqual(['campaign_held']);
  });

  /**
   * THE LEAK, INVERTED. A stylist holding `scanner` and `charges` is a real
   * seeded shape and she must see NOTHING — `booking_no_show`'s body carries a
   * customer's name and a money fact.
   */
  it('a permission that maps to no kind sees nothing', () => {
    expect(visibleKinds(perms('scanner', 'charges', 'void', 'shop'))).toEqual([]);
  });

  it('an owner holding everything sees all three, in enum order', () => {
    expect(visibleKinds(perms('team', 'appointments', 'marketing'))).toEqual([
      'calendar_disconnected',
      'booking_no_show',
      'campaign_held',
    ]);
  });

  /**
   * `dashboard` IS THE WIDE GRANT ELSEWHERE AND GRANTS NOTHING HERE, which is
   * worth pinning rather than leaving implied. `services/reports.ts` calls
   * `dashboard` "the wider grant" and it opens the Overview, the activity feed and
   * the audit log. If it ever came to imply the bell's three kinds, the filter
   * would collapse to "anyone who can open the dashboard", which is the ungated
   * answer wearing a permission's name.
   */
  it('dashboard alone grants no kind', () => {
    expect(visibleKinds(perms('dashboard'))).toEqual([]);
  });

  /**
   * THE MAP IS TOTAL, AND THIS IS THE SPEC THAT SAYS SO AT RUNTIME. The
   * `satisfies Record<NotificationKind, PermissionName>` on `KIND_PERMISSION`
   * already makes a fourth kind a compile error — this catches the same gap from
   * the other side, for a kind added to the enum and to `NOTIFICATION_KINDS`
   * together by someone following the pattern without reading the header.
   */
  it('every kind maps to a permission, and every kind is reachable by one', () => {
    for (const kind of NOTIFICATION_KINDS) {
      const permission = KIND_PERMISSION[kind];
      expect(permission, `${kind} has no permission`).toBeTruthy();
      expect(
        visibleKinds(perms(permission)),
        `${kind} is unreachable by its own permission ${permission}`,
      ).toContain(kind);
    }
  });
});

describe('safeDeepLink — a site-relative path, or null', () => {
  /** The three the product actually mints. All must survive. */
  it.each([
    '/merchant/team/AR-001',
    '/merchant/appointments/BK-4410293',
    '/marketing/campaigns',
  ])('keeps the link this product writes: %s', (link) => {
    expect(safeDeepLink(link)).toBe(link);
  });

  it('keeps a path with a query and a fragment', () => {
    expect(safeDeepLink('/merchant/appointments?status=no_show#top')).toBe(
      '/merchant/appointments?status=no_show#top',
    );
  });

  /**
   * THE FOUR WAYS OFF THIS ORIGIN. The protocol-relative case is the one a naive
   * "starts with a slash" check ships, and it is a working open redirect in the
   * chrome of every screen.
   */
  it.each([
    ['an absolute http url', 'https://evil.test/x'],
    ['a javascript scheme', 'javascript:alert(1)'],
    ['a data url', 'data:text/html,<script>1</script>'],
    ['a protocol-relative url', '//evil.test/x'],
    ['a backslash the browser folds to a slash', '/\\evil.test/x'],
    ['a backslash anywhere', '/merchant\\team'],
    ['a newline', '/merchant/team\nLocation: https://evil.test'],
    ['a NUL', '/merchant/team\u0000'],
    ['a bare word with no leading slash', 'merchant/team/AR-001'],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('refuses %s', (_why, link) => {
    expect(safeDeepLink(link)).toBeNull();
  });

  it('refuses a link longer than the bound', () => {
    expect(safeDeepLink(`/${'x'.repeat(512)}`)).toBeNull();
  });

  it('null and undefined are null, not a throw', () => {
    expect(safeDeepLink(null)).toBeNull();
    expect(safeDeepLink(undefined)).toBeNull();
  });
});

describe('serialiseNotification — what reaches the wire', () => {
  const row = {
    id: 'NT-1',
    kind: 'booking_no_show' as const,
    severity: 'info' as const,
    title: 'A deposit was returned automatically',
    body: 'Latifa did not arrive for her appointment.',
    deepLink: '/merchant/appointments/BK-1',
    createdAt: new Date('2026-09-26T08:00:00.000Z'),
    readAt: null,
    resolvedAt: null,
  };

  /**
   * `metadata`, `subjectType` and `subjectId` ARE ABSENT AND THIS IS THE CHECK.
   * `metadata` carries `memberId` and `depositFils`, has no schema in
   * `packages/types`, and the design renders none of it. A key that appears here
   * becomes a shape a client gets built against —
   * `e2e/contract.test.ts`'s whole subject. Asserted as an exact key set so a
   * field added by convenience fails rather than ships.
   */
  it('serves exactly nine keys, and none of them is metadata', () => {
    expect(Object.keys(serialiseNotification(row)).sort()).toEqual([
      'body',
      'createdAt',
      'deepLink',
      'id',
      'kind',
      'readAt',
      'resolvedAt',
      'severity',
      'title',
    ]);
  });

  /**
   * A BAD LINK IS AN UNCLICKABLE ROW, NOT A 500. One row written by a future
   * fourth raise site must not take the whole bell down — a merchant with no bell
   * is worse off than one with a dead link in it.
   */
  it('nulls a link that fails validation rather than throwing', () => {
    expect(serialiseNotification({ ...row, deepLink: '//evil.test/x' }).deepLink).toBeNull();
  });

  /**
   * BOTH TIMESTAMPS REACH THE WIRE, INDEPENDENTLY. The resolved-but-never-read
   * row is the case the brief names, and a client cannot draw it — struck through,
   * out of the badge, still in the list — unless it is told both.
   */
  it('carries readAt and resolvedAt as separate facts', () => {
    const view = serialiseNotification({
      ...row,
      readAt: null,
      resolvedAt: new Date('2026-09-26T09:00:00.000Z'),
    });
    expect(view.readAt).toBeNull();
    expect(view.resolvedAt).toBe('2026-09-26T09:00:00.000Z');
  });
});
