/**
 * `PATCH /v1/salons/{id}/social/{linkId}` end to end, against a real database.
 *
 * `services/socialLinks.test.ts` covers the pure half and runs in `pnpm check`.
 * This file exists for the one claim that file names as OWED, because it is the
 * endpoint's headline property and it is a concurrency property:
 *
 *   TWO MANAGERS EDITING DIFFERENT LINKS AT THE SAME INSTANT DO NOT OVERWRITE
 *   EACH OTHER.
 *
 * Nothing pure can prove that. `applySocialPatch` copies the other links through
 * untouched, which is necessary and not sufficient: without `SELECT … FOR UPDATE`
 * on the salon row, two requests read the SAME array, each applies its own link to
 * its own copy, and whichever commits second puts the other's channel back — the
 * read-modify-write clobber the endpoint exists to eliminate, performed by the
 * endpoint. The lock is the fix, and a lock is only observable under a race.
 *
 * `e2e/support/race.ts` is the workspace's proper home for this and belongs to
 * Lane D. This is Lane A proving the behaviour before handing it over;
 * `vitest.int.config.ts` carries the rest.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SocialLink } from '@avo/types';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
/** Noura — manager, every permission, so `perms.loyalty` is present. */
const STAFF = 'ST-001';
/** Hessa — frontdesk, `permLoyalty: false`. The authority half of the endpoint. */
const STAFF_NO_PERM = 'ST-002';

suite('PATCH /v1/salons/:id/social/:linkId', () => {
  let app: FastifyInstance;

  let db: typeof import('../db/client')['db'];
  let salon: typeof import('../db/schema/salon')['salon'];
  let auditLog: typeof import('../db/schema/audit')['auditLog'];
  let orm: typeof import('drizzle-orm');
  let issueSession: typeof import('../auth/sessions')['issueSession'];

  let manager = '';
  let frontdesk = '';

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    salon = (await import('../db/schema/salon')).salon;
    auditLog = (await import('../db/schema/audit')).auditLog;
    orm = await import('drizzle-orm');
    issueSession = (await import('../auth/sessions')).issueSession;
    app = await (await import('../app')).buildApp();

    const mint = async (staffId: string) => {
      const s = await issueSession(db, {
        principalKind: 'staff',
        staffId,
        salonId: SALON,
        // The merchant web surface, which is where Settings lives.
        scope: 'dashboard',
      });
      return s.accessToken;
    };
    manager = await mint(STAFF);
    frontdesk = await mint(STAFF_NO_PERM);
  });

  afterAll(async () => {
    await app?.close();
  });

  /** The seeded array, restored before each test so the fixture is the product's. */
  const SEEDED: SocialLink[] = [
    { id: 'instagram', label: 'Instagram', handle: '@amara.kw', on: true },
    { id: 'tiktok', label: 'TikTok', handle: '@amara.kw', on: true },
    { id: 'snapchat', label: 'Snapchat', handle: '', on: false },
    { id: 'whatsapp', label: 'WhatsApp', handle: '+96522334455', on: true },
  ];

  beforeEach(async () => {
    await db.update(salon).set({ social: SEEDED }).where(orm.eq(salon.id, SALON));
  });

  async function storedSocial(): Promise<SocialLink[]> {
    const [row] = await db
      .select({ social: salon.social })
      .from(salon)
      .where(orm.eq(salon.id, SALON));
    return row?.social ?? [];
  }

  function patch(linkId: string, payload: unknown, bearer = manager) {
    return app.inject({
      method: 'PATCH',
      url: `/v1/salons/${SALON}/social/${linkId}`,
      headers: { authorization: `Bearer ${bearer}` },
      payload: payload as Record<string, unknown>,
    });
  }

  it('changes one handle and returns the link with its derived url', async () => {
    const res = await patch('instagram', { handle: '@amara.salon' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('instagram');
    expect(body.handle).toBe('@amara.salon');
    // Derived on read, stored nowhere — api-contract.md § SocialLink.
    expect(body.url).toBe('https://instagram.com/amara.salon');

    const stored = await storedSocial();
    expect(stored[0]?.handle).toBe('@amara.salon');
    expect(stored.slice(1)).toEqual(SEEDED.slice(1));
    // Nothing resembling a URL reached the column.
    expect(JSON.stringify(stored)).not.toContain('instagram.com');
  });

  it('turns a link off without losing its handle', async () => {
    const res = await patch('whatsapp', { on: false });
    expect(res.statusCode).toBe(200);

    const stored = await storedSocial();
    // api-contract.md: "false hides the icon without losing the handle."
    expect(stored[3]).toEqual({
      id: 'whatsapp',
      label: 'WhatsApp',
      handle: '+96522334455',
      on: false,
    });
  });

  describe('two managers, two links, one instant', () => {
    /**
     * TWO IS THE READABLE STATEMENT OF THE PROPERTY AND FOUR IS THE SENSITIVE
     * TEST, which is worth saying because the difference was measured rather than
     * assumed. With `.for('update')` deleted, the four-way case failed on the first
     * run and the two-way case PASSED — two requests are simply not enough
     * overlap to lose an update reliably on a warm local Postgres.
     *
     * A concurrency spec that passes against the broken code is worse than no
     * spec: it is a green tick over the exact defect. So the two-way case runs
     * several rounds rather than once, and the four-way case exists alongside it.
     * Both were re-run against the lock-less mutation and both went red.
     */
    it('both edits survive, round after round — this is what the row lock buys', async () => {
      for (let round = 0; round < 8; round += 1) {
        await db.update(salon).set({ social: SEEDED }).where(orm.eq(salon.id, SALON));

        const [a, b] = await Promise.all([
          patch('instagram', { handle: `@round.${round}` }),
          patch('whatsapp', { handle: `+9659999000${round}` }),
        ]);
        expect(a.statusCode).toBe(200);
        expect(b.statusCode).toBe(200);

        const stored = await storedSocial();
        // Without the lock one of these two reverts: both requests read the same
        // four-link array and the second commit puts the first's channel back.
        expect(stored.find((l) => l.id === 'instagram')?.handle, `round ${round}`).toBe(
          `@round.${round}`,
        );
        expect(stored.find((l) => l.id === 'whatsapp')?.handle, `round ${round}`).toBe(
          `+9659999000${round}`,
        );
        // And the two nobody touched are exactly as seeded.
        expect(stored.find((l) => l.id === 'tiktok')).toEqual(SEEDED[1]);
        expect(stored.find((l) => l.id === 'snapchat')).toEqual(SEEDED[2]);
      }
    });

    it('survives four simultaneous edits, one per channel', async () => {
      const results = await Promise.all([
        patch('instagram', { handle: '@four.a' }),
        patch('tiktok', { handle: '@four.b' }),
        patch('snapchat', { handle: '@four.c' }),
        patch('whatsapp', { handle: '+96511112222' }),
      ]);
      for (const r of results) expect(r.statusCode).toBe(200);

      const stored = await storedSocial();
      expect(stored.map((l) => l.handle).sort()).toEqual(
        ['+96511112222', '@four.a', '@four.b', '@four.c'].sort(),
      );
    });
  });

  describe('the authority half', () => {
    it('refuses a staff member without perms.loyalty', async () => {
      // Non-negotiable #7. The dashboard hiding the Settings tab is a courtesy.
      const res = await patch('instagram', { handle: '@hessa.was.here' }, frontdesk);
      expect(res.statusCode).toBe(403);
      expect(await storedSocial()).toEqual(SEEDED);
    });

    it('refuses another salon\'s id, and writes nothing', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/salons/SAL-LUMIERE/social/instagram',
        headers: { authorization: `Bearer ${manager}` },
        payload: { handle: '@not.mine' },
      });
      expect(res.statusCode).toBe(403);
      expect(await storedSocial()).toEqual(SEEDED);
    });

    it('refuses an anonymous caller', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/salons/${SALON}/social/instagram`,
        payload: { handle: '@anon' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('refusals leave the array exactly as it was', () => {
    it.each([
      ['a pasted URL', 'instagram', { handle: 'https://instagram.com/amara.kw' }, 'handle_is_a_url'],
      ['a local whatsapp number', 'whatsapp', { handle: '22334455' }, 'invalid_phone'],
      ['an unknown channel', 'facebook', { handle: '@a' }, 'unknown_social_link'],
      ['a field that is not editable', 'instagram', { label: 'Follow us' }, 'invalid_field'],
      ['an empty body', 'instagram', {}, 'invalid_request'],
      ['a coerced toggle', 'instagram', { on: 'false' }, 'invalid_request'],
    ])('%s → %s', async (_name, linkId, payload, code) => {
      const res = await patch(linkId, payload);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe(code);
      expect(await storedSocial()).toEqual(SEEDED);
    });
  });

  it('writes one audit row naming the channel and where it now points', async () => {
    const [before] = await db
      .select({ n: orm.sql<number>`count(*)::int` })
      .from(auditLog)
      .where(orm.eq(auditLog.action, 'Social link changed'));

    await patch('tiktok', { handle: '@amara.tiktok', on: true });

    const rows = await db
      .select({ detail: auditLog.detail, subjectId: auditLog.subjectId, kind: auditLog.kind })
      .from(auditLog)
      .where(orm.eq(auditLog.action, 'Social link changed'))
      .orderBy(orm.desc(auditLog.createdAt))
      .limit(1);

    const [after] = await db
      .select({ n: orm.sql<number>`count(*)::int` })
      .from(auditLog)
      .where(orm.eq(auditLog.action, 'Social link changed'));

    expect((after?.n ?? 0) - (before?.n ?? 0)).toBe(1);
    expect(rows[0]?.subjectId).toBe('tiktok');
    // `rules`, not `money`. Nothing moved.
    expect(rows[0]?.kind).toBe('rules');
    // WHAT IT IS NOW, the way "Product edited" spells out the new price.
    expect(rows[0]?.detail).toContain('@amara.tiktok');
    expect(rows[0]?.detail).toContain('shown');
  });

  it('creates a link a salon does not have, so a new salon can set its first handle', async () => {
    await db.update(salon).set({ social: [] }).where(orm.eq(salon.id, SALON));

    const res = await patch('snapchat', { handle: '@amara.snap', on: true });
    expect(res.statusCode).toBe(200);

    expect(await storedSocial()).toEqual([
      { id: 'snapchat', label: 'Snapchat', handle: '@amara.snap', on: true },
    ]);
  });
});
