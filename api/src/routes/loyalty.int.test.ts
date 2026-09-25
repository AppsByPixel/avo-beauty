/**
 * LOYALTY AUTHORITY, END TO END, AGAINST A REAL DATABASE.
 *
 * Aftab, verbatim: *"Owner console will control the loyalty part not the
 * merchant (it will be read only for merchant)."* That REVERSES a decision
 * `design/README.md:136` records as closed — "merchants now edit their own tier
 * rules" — so these specs are not filling a gap. They are the withdrawal of a
 * capability that worked, and several of them are the mirror image of specs that
 * used to assert the opposite.
 *
 * WHY THIS SUITE IS DATABASE-BACKED RATHER THAN PURE. Non-negotiable #7: "Every
 * gated endpoint needs a test that calls it directly with the permission off."
 * `perms.loyalty` and `sections.salons` are COLUMNS, read from the row on every
 * request — never from a claim — so the only way to call an endpoint with a
 * permission off is to have a real session over a real row. `vitest.config.ts`
 * points `DATABASE_URL` at port 1 on purpose, so a spec that has to prove
 * something about authority cannot live under it. `vitest.int.config.ts` also
 * sets `AVO_TEST_PRINCIPALS: '0'`, so every credential below is a real signed
 * session rather than the test shim.
 *
 * THE TWO ASSERTIONS THAT ARE THE POINT OF THE SLICE:
 *
 *   1. A merchant WITH `perms.loyalty` — every chip on, nothing to grant her —
 *      is refused the publish. The permission being ON is what makes the spec
 *      mean anything; with it off, the old gate would have refused her too and
 *      the spec would pass against the unchanged code.
 *
 *   2. The audit row the console's publish leaves is READABLE BY THE MERCHANT,
 *      through her own `GET /salons/{id}/audit`. That is the assertion that
 *      catches `salonId: null` — the natural-looking repair, which compiles,
 *      publishes correctly, writes a complete-looking platform row, and silently
 *      empties the one log a merchant would open to find out who moved Gold.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
/** The second seeded salon. Cross-tenant, and the console's second target. */
const OTHER = 'SAL-LUMIERE';

/** Noura — manager, EVERY permission, so `perms.loyalty` is ON. */
const STAFF_FULL = 'ST-001';
/** Hessa — frontdesk, `permLoyalty: false`. The read gate's other half. */
const STAFF_NO_PERM = 'ST-002';

/** Yousef — platform owner, `perm_salons: true`. The new authority. */
const PLT_OWNER = 'PLT-001';
/** Mariam K. — analyst, `perm_salons: false`. The console's own refusal. */
const PLT_ANALYST = 'PLT-002';

const MEMBER = '8842';

/** A valid four-rung ladder, distinguishable from the seed at a glance. */
const LADDER = [
  { name: 'bronze', minVisits: 0, bonusPercent: 0 },
  { name: 'silver', minVisits: 6, bonusPercent: 12 },
  { name: 'gold', minVisits: 14, bonusPercent: 22 },
  { name: 'black', minVisits: 30, bonusPercent: 35 },
];

suite('loyalty authority — AVO writes, the merchant reads', () => {
  let app: FastifyInstance;

  let db: (typeof import('../db/client'))['db'];
  let salon: (typeof import('../db/schema/salon'))['salon'];
  let auditLog: (typeof import('../db/schema/audit'))['auditLog'];
  let staffUser: (typeof import('../db/schema/staff'))['staffUser'];
  let orm: typeof import('drizzle-orm');
  let issueSession: (typeof import('../auth/sessions'))['issueSession'];

  let manager = '';
  let frontdesk = '';
  let owner = '';
  let analyst = '';
  let customer = '';

  /** The seeded loyalty columns, restored after every spec that writes. */
  let SEEDED: Record<string, unknown> = {};

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    salon = (await import('../db/schema/salon')).salon;
    auditLog = (await import('../db/schema/audit')).auditLog;
    staffUser = (await import('../db/schema/staff')).staffUser;
    orm = await import('drizzle-orm');
    issueSession = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    const staff = async (staffId: string) =>
      (
        await issueSession(db, {
          principalKind: 'staff',
          staffId,
          salonId: SALON,
          scope: 'dashboard',
        })
      ).accessToken;

    const platform = async (adminId: string) =>
      (
        await issueSession(db, {
          principalKind: 'platform_admin',
          platformAdminId: adminId,
          // NULL, and required to be — `session_salon_matches_principal`.
          salonId: null,
          scope: 'platform',
        })
      ).accessToken;

    manager = await staff(STAFF_FULL);
    frontdesk = await staff(STAFF_NO_PERM);
    owner = await platform(PLT_OWNER);
    analyst = await platform(PLT_ANALYST);
    customer = (
      await issueSession(db, {
        principalKind: 'member',
        memberId: MEMBER,
        salonId: SALON,
        scope: 'wallet',
      })
    ).accessToken;

    const [row] = await db
      .select({
        loyaltyMode: salon.loyaltyMode,
        tiers: salon.tiers,
        stampTarget: salon.stampTarget,
        stampReward: salon.stampReward,
        stampRewardAr: salon.stampRewardAr,
      })
      .from(salon)
      .where(orm.eq(salon.id, SALON));
    SEEDED = row as Record<string, unknown>;
  });

  afterAll(async () => {
    await app?.close();
  });

  /**
   * THE MANAGER'S `perms.loyalty` IS ASSERTED ON, NOT ASSUMED, before each spec.
   * The whole slice turns on "a merchant WITH the permission is still refused",
   * and a fixture that had drifted to `false` would make every refusal below pass
   * for the wrong reason — the exact shape of a test that cannot fail.
   */
  beforeEach(async () => {
    await db
      .update(staffUser)
      .set({ permLoyalty: true })
      .where(orm.eq(staffUser.id, STAFF_FULL));
    const [n] = await db
      .select({ perm: staffUser.permLoyalty })
      .from(staffUser)
      .where(orm.eq(staffUser.id, STAFF_FULL));
    expect(n?.perm, 'the manager must hold perms.loyalty for these specs to mean anything').toBe(
      true,
    );
  });

  afterEach(async () => {
    await db.update(salon).set(SEEDED).where(orm.eq(salon.id, SALON));
  });

  const get = (id: string, bearer: string) =>
    app.inject({
      method: 'GET',
      url: `/salons/${id}/loyalty`,
      headers: { authorization: `Bearer ${bearer}` },
    });

  const put = (id: string, bearer: string, payload: unknown) =>
    app.inject({
      method: 'PUT',
      url: `/salons/${id}/loyalty`,
      headers: { authorization: `Bearer ${bearer}` },
      payload: payload as Record<string, unknown>,
    });

  async function storedLoyalty(id: string) {
    const [row] = await db
      .select({ mode: salon.loyaltyMode, tiers: salon.tiers, stampTarget: salon.stampTarget })
      .from(salon)
      .where(orm.eq(salon.id, id));
    return row;
  }

  async function latestRulesRow(id: string) {
    const [row] = await db
      .select()
      .from(auditLog)
      .where(orm.and(orm.eq(auditLog.salonId, id), orm.eq(auditLog.kind, 'rules')))
      .orderBy(orm.desc(auditLog.seq))
      .limit(1);
    return row;
  }

  // ====================================================================
  // 1 · THE MERCHANT PUT IS REFUSED — with the permission ON
  // ====================================================================
  describe('the merchant may no longer publish', () => {
    it('refuses a manager holding perms.loyalty, as loyalty_read_only', async () => {
      const res = await put(SALON, manager, { loyaltyMode: 'tiers', tiers: LADDER });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      // NOT `forbidden`. The client has to be able to tell a WITHDRAWN capability
      // from a missing permission — a merchant mid-edit is holding a draft and a
      // Publish button, and "ask your manager" would send her to the one person
      // who cannot help.
      expect(body.error).toBe('loyalty_read_only');
      expect(body.message).not.toContain('manager');
      expect(body.message).toContain('AVO');
    });

    it('changes nothing and writes no audit row when it refuses', async () => {
      const before = await storedLoyalty(SALON);
      const beforeSeq = (await latestRulesRow(SALON))?.seq ?? 0;

      await put(SALON, manager, { loyaltyMode: 'tiers', tiers: LADDER });

      // A refusal that had already written would be worse than no refusal: the
      // merchant would be told she cannot publish, by a server that just did.
      expect(await storedLoyalty(SALON)).toEqual(before);
      expect((await latestRulesRow(SALON))?.seq ?? 0).toBe(beforeSeq);
    });

    it('refuses a frontdesk without the permission the same way', async () => {
      // She was refused before this change too, by the permission gate. She is
      // refused now by AUTHORITY, one step earlier — so the code she sees is the
      // withdrawal, not `forbidden`. Both merchants get one answer.
      const res = await put(SALON, frontdesk, { loyaltyMode: 'tiers', tiers: LADDER });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toBe('loyalty_read_only');
    });

    it('refuses a merchant aiming at ANOTHER salon without leaking whether it is hers', async () => {
      const res = await put(OTHER, manager, { loyaltyMode: 'tiers', tiers: LADDER });
      expect(res.statusCode).toBe(403);
      // `loyalty_read_only`, NOT "That salon is not yours." The refusal is on
      // principal KIND alone, before any lookup, so she learns nothing about
      // SAL-LUMIERE — not whether it exists, not whether she is inside it. She
      // may not write either salon, and one answer says so.
      expect(JSON.parse(res.body).error).toBe('loyalty_read_only');
      expect(JSON.parse(res.body).message).not.toContain('not yours');
    });

    it('refuses a customer', async () => {
      const res = await put(SALON, customer, { loyaltyMode: 'tiers', tiers: LADDER });
      expect(res.statusCode).toBe(403);
      // By SURFACE, not by withdrawal. A customer here is confused, not demoted.
      expect(JSON.parse(res.body).message).toContain('owner console');
    });

    it('closes the second door — PATCH /salons/{id} cannot carry the ladder either', async () => {
      // The endpoint everyone forgets. Refusing only the PUT would be decorative:
      // the same session could publish the same ladder one route over.
      const res = await app.inject({
        method: 'PATCH',
        url: `/salons/${SALON}`,
        headers: { authorization: `Bearer ${manager}` },
        payload: { tiers: LADDER },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toBe('loyalty_read_only');
      expect((await storedLoyalty(SALON))?.tiers).toEqual(SEEDED.tiers);
    });

    it('leaves the rest of the Settings screen working — the permission survives', async () => {
      // `perms.loyalty` is narrowed, not retired. If this went red the change
      // would have taken the whole screen out with the ladder.
      //
      // IT PUTS THE COLOUR BACK. This spec used to PATCH `brandColor` to
      // `#8A7CB0` and leave it there, so any lane database drifted off the seed
      // after a single int run and stayed there until the next `lane-db.sh`
      // reset. Nothing was red, which is what made it worth fixing: the next
      // spec to assert anything about a salon's brand colour would have been
      // mysteriously order-dependent, passing alone and failing in the suite.
      // The proof here is the 200, not the value, so the value need not survive.
      const before = await app.inject({
        method: 'GET',
        url: `/salons/${SALON}`,
        headers: { authorization: `Bearer ${manager}` },
      });
      const original = JSON.parse(before.body).brandColor as string;

      const res = await app.inject({
        method: 'PATCH',
        url: `/salons/${SALON}`,
        headers: { authorization: `Bearer ${manager}` },
        payload: { brandColor: '#8A7CB0' },
      });
      expect(res.statusCode).toBe(200);

      const restored = await app.inject({
        method: 'PATCH',
        url: `/salons/${SALON}`,
        headers: { authorization: `Bearer ${manager}` },
        payload: { brandColor: original },
      });
      expect(restored.statusCode).toBe(200);
      expect(JSON.parse(restored.body).brandColor).toBe(original);
    });
  });

  // ====================================================================
  // 2 · THE MERCHANT GET STILL WORKS — read-only is the point
  // ====================================================================
  describe('the merchant still reads her ladder', () => {
    it('serves the live config and the server-computed preview', async () => {
      const res = await get(SALON, manager);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.loyaltyMode).toBe('tiers');
      expect(Array.isArray(body.tiers)).toBe(true);
      // The "10 → 11 KD" line, priced by the same `percentOf` a real top-up uses.
      expect(body.preview).not.toBeNull();
    });

    it('still refuses a merchant without perms.loyalty', async () => {
      const res = await get(SALON, frontdesk);
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).message).toContain('A manager can grant it.');
    });

    it('still refuses a merchant reading another salon — requireSameSalon holds', async () => {
      const res = await get(OTHER, manager);
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).message).toContain('not yours');
    });
  });

  // ====================================================================
  // 3 · THE CONSOLE WRITES IT
  // ====================================================================
  describe('the platform console publishes', () => {
    it('refuses a console account without sections.salons', async () => {
      const res = await put(SALON, analyst, { loyaltyMode: 'tiers', tiers: LADDER });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).message).toContain('Salons');
      // And it moved nothing.
      expect((await storedLoyalty(SALON))?.tiers).toEqual(SEEDED.tiers);
    });

    it('refuses that same account the READ, for the same section', async () => {
      const res = await get(SALON, analyst);
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).message).toContain('Salons');
    });

    it('lets sections.salons read any salon, with no requireSameSalon to satisfy', async () => {
      // A platform admin has no salon, so tenancy is not a question she can fail.
      for (const id of [SALON, OTHER]) {
        const res = await get(id, owner);
        expect(res.statusCode, `console must read ${id}`).toBe(200);
      }
    });

    it('publishes a real ladder and returns the design copy', async () => {
      const res = await put(SALON, owner, { loyaltyMode: 'tiers', tiers: LADDER });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.tiers).toEqual(LADDER);
      expect(body.publishedBy).toBe('Yousef');
      expect(body.message).toBe('Tier rules published — customers see them now.');
      // Nobody is promoted or demoted at publish time.
      expect(body.appliesAt).toBe('next_visit');

      const stored = await storedLoyalty(SALON);
      expect(stored?.tiers).toEqual(LADDER);
    });

    it('still validates — an out-of-order ladder is refused before anything opens', async () => {
      const broken = [
        { name: 'bronze', minVisits: 0, bonusPercent: 0 },
        { name: 'silver', minVisits: 9, bonusPercent: 10 },
        { name: 'gold', minVisits: 3, bonusPercent: 20 },
        { name: 'black', minVisits: 30, bonusPercent: 30 },
      ];
      const res = await put(SALON, owner, { loyaltyMode: 'tiers', tiers: broken });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('threshold_not_above_tier_below');
      expect((await storedLoyalty(SALON))?.tiers).toEqual(SEEDED.tiers);
    });

    /**
     * THE ATOMICITY PROPERTY, PRESERVED. `salon_loyalty_config_complete` requires
     * the configuration for whichever mode is active, so mode and its
     * configuration must move in ONE statement — Postgres checks a CHECK per
     * statement, so "briefly illegal" would mean "the statement fails". Switching
     * mechanic is the case that exercises it, and it is the reason the handler
     * sets every loyalty column rather than only the changed ones.
     */
    it('switches mechanic in one statement, ladder and mode together', async () => {
      const res = await put(SALON, owner, {
        loyaltyMode: 'stamps',
        stampTarget: 8,
        stampReward: 'A free blow-dry',
        stampRewardAr: 'تصفيف شعر مجاني',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.loyaltyMode).toBe('stamps');
      // No top-up bonus to preview in stamps mode.
      expect(body.preview).toBeNull();
      expect(body.message).toBe('Stamp rules published — customers see them now.');

      const stored = await storedLoyalty(SALON);
      expect(stored?.mode).toBe('stamps');
      expect(stored?.stampTarget).toBe(8);
    });

    it('publishes to the OTHER salon too — the console is above tenancy', async () => {
      const res = await put(OTHER, owner, { loyaltyMode: 'tiers', tiers: LADDER });
      expect(res.statusCode).toBe(200);
      const row = await latestRulesRow(OTHER);
      // The row belongs to the salon that changed, not to the one in some earlier
      // request — the property `salonId: p.salonId` could not have expressed.
      expect(row?.salonId).toBe(OTHER);
      // Put SAL-LUMIERE back; `afterEach` only restores SAL-AMARA.
      await db
        .update(salon)
        .set({ loyaltyMode: 'tiers', tiers: SEEDED.tiers as never })
        .where(orm.eq(salon.id, OTHER));
    });
  });

  // ====================================================================
  // 4 · THE AUDIT ROW — the part most likely to be quietly wrong
  // ====================================================================
  describe('the audit row names AVO, in the salon\'s own log', () => {
    it('records the platform actor legibly', async () => {
      await put(SALON, owner, { loyaltyMode: 'tiers', tiers: LADDER });
      const row = await latestRulesRow(SALON);

      expect(row?.action).toBe('Tier rules published');
      // `actorOf`'s platform branch — unreachable until a platform principal
      // existed, and this is a caller that reaches it.
      expect(row?.actorKind).toBe('platform_admin');
      expect(row?.actorId).toBe(PLT_OWNER);
      expect(row?.actorName).toBe('Yousef');
      // "on whose authority" — the answer a salon is owed is AVO's, not the
      // internal console seniority of an AVO employee.
      expect(row?.actorRole).toBe('AVO platform');
      // The distinction between an AVO publish and a merchant publish is SOURCE,
      // not a second action string.
      expect(row?.source).toBe('owner_console');
      // The diff a merchant actually reads.
      expect(row?.detail).toContain('→');
    });

    /**
     * THE ASSERTION THAT CATCHES `salonId: null`.
     *
     * The row is written by a principal with NO salon. `salonId: null` compiles,
     * publishes correctly, and produces a platform-log row that looks complete —
     * and `routes/audit.ts` filters the merchant's own read on
     * `eq(auditLog.salonId, p.salonId)`, whose header states the consequence:
     * "Platform actions belonging to NO salon have a null `salon_id` and are
     * therefore invisible here." So the merchant would open her Loyalty screen,
     * find Gold moved from 10 visits to 14, open her audit log to find out who
     * did it, and see nothing at all.
     *
     * Asserted through the HTTP endpoint she actually uses, not against the
     * column, because the column being right is not the claim — her being able to
     * READ it is.
     */
    it('is visible to the merchant through her own audit log', async () => {
      /**
       * PINNED TO `seq`, AND THE FIRST DRAFT OF THIS SPEC WAS VACUOUS WITHOUT IT.
       *
       * It matched on `action === 'Tier rules published'` and passed under fault
       * injection — `salonId: null` in the handler, the whole point of the spec,
       * and it stayed green. `audit_log` is append-only (`UPDATE`/`DELETE` are
       * revoked from `avo_app` in migration 0001), so earlier specs in this same
       * file leave correctly-filed rows behind, and the search found one of those
       * instead of the row this spec just caused.
       *
       * A test that asserts on a row it did not write is asserting on the
       * fixture. `seq` is monotonic and on the wire, so reading it first makes
       * the assertion "the row THIS publish produced", which is the claim.
       * Verified by re-running the injection: with the pin, it fails.
       */
      const priorSeq = (await latestRulesRow(SALON))?.seq ?? 0;

      await put(SALON, owner, { loyaltyMode: 'tiers', tiers: LADDER });

      const res = await app.inject({
        method: 'GET',
        url: `/salons/${SALON}/audit`,
        headers: { authorization: `Bearer ${manager}` },
      });
      expect(res.statusCode).toBe(200);

      const items = JSON.parse(res.body).items as Array<Record<string, unknown>>;
      const published = items.find(
        (i) => i.action === 'Tier rules published' && (i.seq as number) > priorSeq,
      );

      expect(published, 'the merchant must be able to see who changed her rules').toBeDefined();
      // The wire shape is the design's four columns: Who / What / Detail / Source.
      expect(published?.who).toBe('Yousef');
      expect(published?.role).toBe('AVO platform');
      // "AVO platform staff actions on your salon appear here too, marked
      // **Owner console**" — routes/audit.ts. This is that mark, on the wire.
      expect(published?.sourceLabel).toBe('Owner console');
      expect(published?.isPlatformAction).toBe(true);
      // And the diff itself, so the row answers "what changed" as well as "who".
      expect(published?.detail).toContain('→');
    });

    /**
     * The same claim from the database side, and SCOPED BY `seq` FOR A REASON
     * LEARNED THE HARD WAY.
     *
     * It was written as a global count — "no ladder publish anywhere may be filed
     * with a null salon" — which is the truer-sounding invariant and the wrong
     * assertion. `audit_log` is append-only, so the ONE fault-injection run that
     * proved these specs work left a permanent null-salon row in the lane
     * database, and the spec then failed for every future run against a
     * historical row rather than against the code. An append-only table makes
     * "no such row has ever existed" unmaintainable as a test; "this publish did
     * not write one" is the claim that is actually about the handler.
     */
    it('lands in the target salon and not in the platform-wide bucket', async () => {
      const priorSeq = (await latestRulesRow(SALON))?.seq ?? 0;

      await put(SALON, owner, { loyaltyMode: 'tiers', tiers: LADDER });

      const [nulls] = await db
        .select({ n: orm.sql<number>`count(*)::int` })
        .from(auditLog)
        .where(
          orm.and(
            orm.isNull(auditLog.salonId),
            orm.eq(auditLog.action, 'Tier rules published'),
            orm.gt(auditLog.seq, priorSeq),
          ),
        );
      expect(nulls?.n, 'this publish must not be filed with a null salon').toBe(0);
    });
  });
});
