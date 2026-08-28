/**
 * The image capability end to end, against a real database and the real store.
 *
 * `images/inspect.test.ts` covers the pure half and runs in `pnpm check`. This
 * file exists for the four claims nothing pure can support, and for the two the
 * brief calls mandatory:
 *
 *   THE ROUND TRIP. Bytes go in over HTTP; the SAME bytes come back over HTTP,
 *   compared byte for byte and by sha256. A unit test with a mocked store proves
 *   that a mock returns what it was given.
 *   TENANCY. A merchant cannot attach to, or read, another salon's image. This
 *   is the class of bug `resolveBranchFilter` guards, and it is asserted here in
 *   both directions and on both routes.
 *   AUTHORITY. Every gated endpoint is called DIRECTLY with the permission off —
 *   non-negotiable #7, "the UI hiding a button is a courtesy, not a control".
 *   LIFECYCLE. Replace, detach, dedupe, resurrect, reap. All of them are claims
 *   about rows and about bytes on a disk, and all of them are about what happens
 *   to storage that nobody is looking at.
 *
 * `e2e/` is Lane D's column and is the durable home for the ones worth keeping.
 * This is Lane A proving the behaviour before handing it over; the argument is
 * `vitest.int.config.ts`'s in full.
 *
 * RUN IT AGAINST YOUR OWN LANE DATABASE:
 *   /abs/path/to/scripts/lane-db.sh a
 *   export AVO_INT_DATABASE_URL="postgres://avo_app:avo_app_dev_password@localhost:5433/avo_lane_a"
 *   pnpm --dir=/abs/path/to/api run test:int
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  makeJpeg,
  makePng,
  makeWebpLossy,
  makeDeclaredBomb,
  SVG_BYTES,
} from '../images/inspect.test';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

/**
 * THE STORE IS REDIRECTED INTO A PER-RUN TEMPORARY DIRECTORY, BEFORE ANY IMPORT.
 *
 * `env.ts` parses at module load, and `images/index.ts` builds the driver at
 * module load off that. So this has to happen at the top of the file, before the
 * dynamic imports in `beforeAll` — which is also why every import below is
 * dynamic, the pattern `socialLink.int.test.ts` uses for the same reason.
 *
 * A per-run directory rather than the developer's `api/.image-store`, because
 * LANES.md's whole § "Every lane isolates its own resources" applies to a
 * filesystem path exactly as it does to a database: a suite that reaps blobs out
 * of a shared directory is a suite that can delete a running lane's bytes.
 */
const STORE_ROOT = mkdtempSync(join(tmpdir(), 'avo-lane-a-imagestore-'));
process.env.IMAGE_STORE_PATH = STORE_ROOT;

const SALON = 'SAL-AMARA';
const OTHER_SALON = 'SAL-LUMIERE';
/** Noura — manager, every permission. */
const STAFF = 'ST-001';
/** Hessa — front desk. `permShop: false`, `permAppointments: true`. */
const STAFF_NO_SHOP = 'ST-002';
const PRODUCT = 'PR-01';
const SERVICE = 'SV-01';

/** Created here, because the seed gives SAL-LUMIERE no staff and no catalog. */
const OTHER_STAFF = 'ST-INT-LUMIERE';
const OTHER_PRODUCT = 'PR-INT-LUMIERE';
/** SAL-AMARA, `permAppointments: false` — nothing seeded has it off. */
const STAFF_NO_APPTS = 'ST-INT-NOAPPTS';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

suite('images on products and services', () => {
  let app: FastifyInstance;
  let db: (typeof import('../db/client'))['db'];
  let image: (typeof import('../db/schema/image'))['image'];
  let imageAttachment: (typeof import('../db/schema/image'))['imageAttachment'];
  let auditLog: (typeof import('../db/schema/audit'))['auditLog'];
  let staffUser: (typeof import('../db/schema/staff'))['staffUser'];
  let product: (typeof import('../db/schema/product'))['product'];
  let orm: typeof import('drizzle-orm');
  let issueSession: (typeof import('../auth/sessions'))['issueSession'];
  let runImageReapOnce: (typeof import('../services/imageReaper'))['runImageReapOnce'];

  let manager = '';
  let noShop = '';
  let noAppts = '';
  let otherManager = '';

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    const schema = await import('../db/schema/image');
    image = schema.image;
    imageAttachment = schema.imageAttachment;
    auditLog = (await import('../db/schema/audit')).auditLog;
    staffUser = (await import('../db/schema/staff')).staffUser;
    product = (await import('../db/schema/product')).product;
    orm = await import('drizzle-orm');
    issueSession = (await import('../auth/sessions')).issueSession;
    runImageReapOnce = (await import('../services/imageReaper')).runImageReapOnce;
    app = await (await import('../app')).buildApp();

    // A second tenant with a catalog and a manager, so "another salon's" is a
    // real row and not a 404 that would have happened anyway.
    await db
      .insert(staffUser)
      .values({
        id: OTHER_STAFF,
        salonId: OTHER_SALON,
        name: 'Lumiere manager',
        handle: 'int-lumiere',
        role: 'manager',
        branchAccessAll: true,
        permDashboard: true,
        permAppointments: true,
        permShop: true,
        permLoyalty: true,
        permTeam: true,
      })
      .onConflictDoNothing();
    await db
      .insert(product)
      .values({
        id: OTHER_PRODUCT,
        salonId: OTHER_SALON,
        name: 'Lumiere serum',
        priceFils: 9000 as never,
      })
      .onConflictDoNothing();
    // The authority fixture the seed does not provide: appointments OFF.
    await db
      .insert(staffUser)
      .values({
        id: STAFF_NO_APPTS,
        salonId: SALON,
        name: 'No appointments',
        handle: 'int-noappts',
        role: 'frontdesk',
        branchAccessAll: true,
        permDashboard: true,
        permAppointments: false,
        permShop: true,
      })
      .onConflictDoNothing();

    const mint = async (staffId: string, salonId: string) =>
      (await issueSession(db, { principalKind: 'staff', staffId, salonId, scope: 'dashboard' }))
        .accessToken;

    manager = await mint(STAFF, SALON);
    noShop = await mint(STAFF_NO_SHOP, SALON);
    noAppts = await mint(STAFF_NO_APPTS, SALON);
    otherManager = await mint(OTHER_STAFF, OTHER_SALON);
  });

  afterAll(async () => {
    await app?.close();
    rmSync(STORE_ROOT, { recursive: true, force: true });
  });

  /**
   * Every image row this suite made, removed between specs.
   *
   * UNSCOPED, and that is safe only because of two facts worth stating rather
   * than assuming: `vitest.int.config.ts` sets `fileParallelism: false`, so no
   * other suite is mid-run; and no other int suite touches these two tables.
   * If either stops being true this needs a salon predicate. It is also why the
   * suite must never be pointed at anything but a lane database — LANES.md
   * § "Every lane isolates its own resources".
   */
  beforeEach(async () => {
    await db.delete(imageAttachment);
    await db.delete(image);
  });

  const upload = (
    kind: 'products' | 'services',
    ownerId: string,
    bytes: Buffer,
    contentType: string,
    bearer = manager,
    salonId = SALON,
  ) =>
    app.inject({
      method: 'POST',
      url: `/v1/salons/${salonId}/${kind}/${ownerId}/image`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': contentType },
      payload: bytes,
    });

  const fetchImage = (imageId: string, bearer = manager) =>
    app.inject({
      method: 'GET',
      url: `/v1/images/${imageId}`,
      headers: { authorization: `Bearer ${bearer}` },
    });

  // =========================================================================
  describe('the round trip', () => {
    it('takes a real PNG and gives the same bytes back', async () => {
      const png = makePng(600, 400);

      const res = await upload('products', PRODUCT, png, 'image/png');
      expect(res.statusCode).toBe(201);
      const ref = JSON.parse(res.body);
      expect(ref).toMatchObject({
        contentType: 'image/png',
        width: 600,
        height: 400,
        byteSize: png.byteLength,
      });
      expect(ref.id).toMatch(/^IM-[A-Z2-9]{10}$/);
      expect(ref.url).toBe(`http://localhost:3000/v1/images/${ref.id}`);

      /**
       * THE ROW SAYS WHAT THE BYTES ARE, asserted in SQL against this lane's own
       * database rather than read back out of the API's own reply. LANES.md:
       * "a server that answers plausibly is not evidence that it is your server."
       */
      const [row] = await db.select().from(image).where(orm.eq(image.id, ref.id));
      expect(row?.salonId).toBe(SALON);
      expect(row?.checksumSha256).toBe(sha(png));
      expect(row?.byteSize).toBe(png.byteLength);
      expect(row?.driver).toBe('disk');
      expect(row?.detachedAt).toBeNull();
      expect(row?.uploadedById).toBe(STAFF);

      const back = await fetchImage(ref.id);
      expect(back.statusCode).toBe(200);
      // BYTE FOR BYTE. Not "a 200", not "some bytes" — the same file.
      expect(back.rawPayload.equals(png)).toBe(true);
      expect(sha(back.rawPayload)).toBe(sha(png));
    });

    it('serves it with the headers that make a stored file safe to render', async () => {
      const res = await upload('products', PRODUCT, makePng(40, 40), 'image/png');
      const ref = JSON.parse(res.body);
      const back = await fetchImage(ref.id);

      expect(back.headers['content-type']).toBe('image/png');
      // The one that stops a browser deciding this is HTML.
      expect(back.headers['x-content-type-options']).toBe('nosniff');
      expect(back.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(back.headers['content-disposition']).toBe(`inline; filename="${ref.id}"`);
      // `immutable` is only honest because a replacement mints a NEW id.
      expect(back.headers['cache-control']).toBe('private, max-age=31536000, immutable');
      expect(back.headers.etag).toBe(`"${sha(makePng(40, 40))}"`);
    });

    it('takes a JPEG and a WebP too, and reads their real dimensions', async () => {
      const jpeg = makeJpeg(1200, 800);
      const a = await upload('products', PRODUCT, jpeg, 'image/jpeg');
      expect(a.statusCode).toBe(201);
      expect(JSON.parse(a.body)).toMatchObject({
        contentType: 'image/jpeg',
        width: 1200,
        height: 800,
      });

      const webp = makeWebpLossy(320, 240);
      const b = await upload('services', SERVICE, webp, 'image/webp');
      expect(b.statusCode).toBe(201);
      expect(JSON.parse(b.body)).toMatchObject({
        contentType: 'image/webp',
        width: 320,
        height: 240,
      });
      expect((await fetchImage(JSON.parse(b.body).id)).rawPayload.equals(webp)).toBe(true);
    });

    it('shows up on the catalog the wallet and the dashboard actually read', async () => {
      const res = await upload('products', PRODUCT, makePng(80, 80), 'image/png');
      const ref = JSON.parse(res.body);

      const list = await app.inject({
        method: 'GET',
        url: `/salons/${SALON}/products`,
        headers: { authorization: `Bearer ${manager}` },
      });
      expect(list.statusCode).toBe(200);
      const items = JSON.parse(list.body).items as Array<Record<string, unknown>>;
      const mine = items.find((i) => i.id === PRODUCT);
      expect(mine?.image).toEqual(ref);
      // Every OTHER product carries an explicit null rather than a missing key —
      // a client must not have to tell "no image" apart from "field not sent".
      expect(items.filter((i) => i.id !== PRODUCT).every((i) => i.image === null)).toBe(true);
    });

    it('writes one audit row, of the kind a rule change gets', async () => {
      const before = await db.select().from(auditLog);
      const res = await upload('products', PRODUCT, makePng(50, 50), 'image/png');
      const ref = JSON.parse(res.body);

      const rows = await db
        .select()
        .from(auditLog)
        .where(orm.eq(auditLog.subjectId, PRODUCT))
        .orderBy(orm.desc(auditLog.createdAt))
        .limit(1);
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({
        salonId: SALON,
        kind: 'rules',
        action: 'Image added',
        source: 'merchant',
        subjectType: 'product',
        actorId: STAFF,
      });
      expect((rows[0]?.metadata as Record<string, unknown>).imageId).toBe(ref.id);
      expect((await db.select().from(auditLog)).length).toBe(before.length + 1);
    });
  });

  // =========================================================================
  describe('what is refused', () => {
    it('refuses an SVG by content type, and says why', async () => {
      const res = await upload('products', PRODUCT, SVG_BYTES, 'image/svg+xml');
      expect(res.statusCode).toBe(415);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('unsupported_image_type');
      expect(body.message).toContain('SVG can carry script');
      expect(body.accepted).toEqual(['image/png', 'image/jpeg', 'image/webp']);
      expect(await db.select().from(image)).toEqual([]);
    });

    it('refuses an SVG RENAMED AND RELABELLED as a PNG — the bypass', async () => {
      /**
       * The whole reason the magic bytes are checked. A merchant (or whoever has
       * her password) sends `Content-Type: image/png` with an SVG behind it; if
       * the header were believed, this API would store a script document and
       * serve it under `Content-Type: image/png` — which `nosniff` would then be
       * the only thing standing in front of.
       */
      const res = await upload('products', PRODUCT, SVG_BYTES, 'image/png');
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('not_an_image');
      // "an SVG", not "a SVG" — images/inspect.ts § FAMILY_ARTICLE.
      expect(body.message).toContain('It looks like an SVG.');
      expect(await db.select().from(image)).toEqual([]);
    });

    it('refuses a PNG mislabelled as a JPEG — a mismatch either way is a refusal', async () => {
      /**
       * A DIFFERENT CODE FROM THE SVG CASE ABOVE, and the difference is real
       * rather than cosmetic. There the bytes were not a readable image of any
       * accepted kind, so the answer is `not_an_image`. Here they are a perfectly
       * good PNG and the HEADER is the thing that is wrong, so the answer names
       * that: we would otherwise be storing one type and serving a header
       * claiming another.
       */
      const res = await upload('products', PRODUCT, makePng(30, 30), 'image/jpeg');
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('content_type_mismatch');
      expect(body).toMatchObject({ declared: 'image/jpeg', actual: 'image/png' });
      expect(body.message).toContain('the file is a PNG');
      expect(await db.select().from(image)).toEqual([]);
    });

    it('refuses a GIF, an octet-stream and plain garbage', async () => {
      const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64)]);
      expect((await upload('products', PRODUCT, gif, 'image/gif')).statusCode).toBe(415);
      expect(
        (await upload('products', PRODUCT, makePng(10, 10), 'application/octet-stream')).statusCode,
      ).toBe(415);
      const garbage = Buffer.alloc(200, 0xab);
      expect((await upload('products', PRODUCT, garbage, 'image/png')).statusCode).toBe(400);
      expect(await db.select().from(image)).toEqual([]);
    });

    it('refuses an oversized file with the limit in the body', async () => {
      // Just over 2 MiB of incompressible noise inside a real PNG container.
      const big = Buffer.alloc(2 * 1024 * 1024 + 4096);
      makePng(4, 4).copy(big);
      const res = await upload('products', PRODUCT, big, 'image/png');
      expect(res.statusCode).toBe(413);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('image_too_large');
      expect(body.maxBytes).toBe(2 * 1024 * 1024);
      // The limit is in the response so a client can render it without a second
      // source of truth for the same number.
      expect(body.message).toContain('2 MB');
      expect(await db.select().from(image)).toEqual([]);
    });

    it('refuses a decompression bomb on its declared size, having decoded nothing', async () => {
      const bomb = makeDeclaredBomb(30000, 30000);
      // Sixty-nine bytes. If this API decoded, that would be 2.7 GB of RGB.
      expect(bomb.byteLength).toBeLessThan(1000);
      const res = await upload('products', PRODUCT, bomb, 'image/png');
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      // The DIMENSION ceiling fires first because 30000 > 4096. The pixel ceiling
      // below is what catches the shapes that slip under it.
      expect(body.error).toBe('image_too_large_dimensions');
      expect(body.width).toBe(30000);
      expect(await db.select().from(image)).toEqual([]);
    });

    it('refuses a shape that passes the dimension ceiling and blows the pixel one', async () => {
      /**
       * 4096x4096 is 16.8 megapixels — at IMAGE_MAX_DIMENSION on both sides and
       * over IMAGE_MAX_PIXELS. This is the case the second ceiling exists for,
       * and without it a merchant could publish a picture that stalls the wallet
       * on every customer's phone.
       *
       * IT IS ALSO THE SPEC THAT CAUGHT THE CEILING BEING DEAD. With the original
       * default of `16 * 1024 * 1024` this exact shape returned 201, because
       * 4096 x 4096 IS 16,777,216 — the two ceilings coincided exactly and `>`
       * could never be true. See env.ts § IMAGE_MAX_PIXELS.
       */
      const wide = makeDeclaredBomb(4096, 4096);
      const res = await upload('products', PRODUCT, wide, 'image/png');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('image_too_many_pixels');
      expect(await db.select().from(image)).toEqual([]);
    });

    it('refuses an empty body', async () => {
      const res = await upload('products', PRODUCT, Buffer.alloc(0), 'image/png');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('empty_body');
    });
  });

  // =========================================================================
  describe('authority — the endpoint is called directly with the permission off', () => {
    it('refuses a product image to a staff member without perms.shop', async () => {
      // Hessa. `permShop: false` in the seed, `permAppointments: true` — so this
      // is the permission and not the session.
      const res = await upload('products', PRODUCT, makePng(20, 20), 'image/png', noShop);
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toBe('forbidden');
      expect(await db.select().from(image)).toEqual([]);
    });

    it('refuses the DELETE to the same caller', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/salons/${SALON}/products/${PRODUCT}/image`,
        headers: { authorization: `Bearer ${noShop}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('refuses a service image to a staff member without perms.appointments', async () => {
      const res = await upload('services', SERVICE, makePng(20, 20), 'image/png', noAppts);
      expect(res.statusCode).toBe(403);
      expect(await db.select().from(image)).toEqual([]);
    });

    it('allows exactly the caller with the permission, so the 403 is the gate and not the route', async () => {
      // The control. Hessa HAS `permAppointments`, so she may put a picture on a
      // service and still may not put one on a product — which is the whole
      // reason the two routes carry two permissions.
      expect((await upload('services', SERVICE, makePng(20, 20), 'image/png', noShop)).statusCode)
        .toBe(201);
      // And the appointments-off account HAS `permShop`.
      expect((await upload('products', PRODUCT, makePng(21, 21), 'image/png', noAppts)).statusCode)
        .toBe(201);
    });

    it('refuses an anonymous caller on every route, including the bytes', async () => {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/salons/${SALON}/products/${PRODUCT}/image`,
            headers: { 'content-type': 'image/png' },
            payload: makePng(10, 10),
          })
        ).statusCode,
      ).toBe(401);

      const ref = JSON.parse(
        (await upload('products', PRODUCT, makePng(11, 11), 'image/png')).body,
      );
      const anon = await app.inject({ method: 'GET', url: `/v1/images/${ref.id}` });
      expect(anon.statusCode).toBe(401);
    });

    it('refuses a SCANNER session on the write, because this is a dashboard endpoint', async () => {
      const scanner = (
        await issueSession(db, {
          principalKind: 'staff',
          staffId: STAFF,
          salonId: SALON,
          scope: 'scanner',
          deviceId: `DEV-INT-${randomUUID()}`,
        })
      ).accessToken;
      const res = await upload('products', PRODUCT, makePng(12, 12), 'image/png', scanner);
      expect(res.statusCode).toBe(403);
    });
  });

  // =========================================================================
  describe('tenancy — the mandatory cross-tenant case, in both directions', () => {
    it('refuses a merchant reaching into another salon by path', async () => {
      const res = await upload(
        'products',
        OTHER_PRODUCT,
        makePng(30, 30),
        'image/png',
        manager,
        OTHER_SALON,
      );
      // `requireSameSalon` — 403, before anything is looked up.
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).message).toBe('That salon is not yours.');
      expect(await db.select().from(image)).toEqual([]);
    });

    it('refuses another salon`s owner id under her OWN salon in the path — a 404, not a 403', async () => {
      /**
       * THE ENUMERATION CASE, and the reason the owner is read inside the salon
       * scope IN THE WHERE. A 403 here would confirm that `PR-INT-LUMIERE` is a
       * live product SOMEWHERE, which is a fact about another tenant's catalog.
       */
      const res = await upload('products', OTHER_PRODUCT, makePng(30, 30), 'image/png');
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toBe('unknown_product');
      expect(await db.select().from(image)).toEqual([]);
    });

    it('refuses another salon`s IMAGE ID to the byte route, with the same 404 as an unknown one', async () => {
      const mine = JSON.parse(
        (await upload('products', PRODUCT, makePng(64, 64), 'image/png')).body,
      );

      const stolen = await fetchImage(mine.id, otherManager);
      expect(stolen.statusCode).toBe(404);
      expect(JSON.parse(stolen.body).error).toBe('unknown_image');

      // Byte-identical to the answer for an id that does not exist at all: the
      // refusal must not be an oracle.
      const nonexistent = await fetchImage('IM-ZZZZZZZZZZ', otherManager);
      expect(nonexistent.statusCode).toBe(404);
      expect(stolen.body).toBe(nonexistent.body);
    });

    it('lets a MEMBER of the salon read it, because the wallet has to paint the shop', async () => {
      const ref = JSON.parse(
        (await upload('products', PRODUCT, makePng(70, 70), 'image/png')).body,
      );
      const memberRow = await db.execute(
        orm.sql`select id from member where salon_id = ${SALON} limit 1`,
      );
      const memberId = (memberRow as unknown as Array<{ id: string }>)[0]?.id as string;
      const memberToken = (
        await issueSession(db, {
          principalKind: 'member',
          memberId,
          salonId: SALON,
          scope: 'wallet',
        })
      ).accessToken;

      const res = await fetchImage(ref.id, memberToken);
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(makePng(70, 70))).toBe(true);
    });

    it('does not leak an image across salons through the CATALOG either', async () => {
      await upload('products', PRODUCT, makePng(90, 90), 'image/png');
      const list = await app.inject({
        method: 'GET',
        url: `/salons/${OTHER_SALON}/products`,
        headers: { authorization: `Bearer ${otherManager}` },
      });
      expect(list.statusCode).toBe(200);
      const items = JSON.parse(list.body).items as Array<Record<string, unknown>>;
      expect(items.every((i) => i.image === null)).toBe(true);
    });
  });

  // =========================================================================
  describe('replacement, deletion and the bytes nobody is looking at', () => {
    it('replaces rather than mutating: a new id, a 200, and the old one marked', async () => {
      const first = JSON.parse(
        (await upload('products', PRODUCT, makePng(100, 100), 'image/png')).body,
      );
      const res = await upload('products', PRODUCT, makePng(200, 150), 'image/png');
      expect(res.statusCode).toBe(200); // 200, not 201: the slot existed.
      const second = JSON.parse(res.body);
      expect(second.id).not.toBe(first.id);
      expect(second.width).toBe(200);

      // Exactly one attachment, pointing at the new one.
      const links = await db.select().from(imageAttachment);
      expect(links.length).toBe(1);
      expect(links[0]?.imageId).toBe(second.id);

      // The displaced row is MARKED, not deleted — the grace window.
      const [old] = await db.select().from(image).where(orm.eq(image.id, first.id));
      expect(old?.detachedAt).toBeInstanceOf(Date);
      // And its bytes are still there, which is what makes an undo possible.
      expect((await fetchImage(first.id)).statusCode).toBe(200);
    });

    it('detaches on DELETE, marks, and answers 404 to a second DELETE', async () => {
      const ref = JSON.parse(
        (await upload('services', SERVICE, makePng(60, 60), 'image/png')).body,
      );
      const del = () =>
        app.inject({
          method: 'DELETE',
          url: `/v1/salons/${SALON}/services/${SERVICE}/image`,
          headers: { authorization: `Bearer ${manager}` },
        });

      expect((await del()).statusCode).toBe(204);
      expect(await db.select().from(imageAttachment)).toEqual([]);
      const [row] = await db.select().from(image).where(orm.eq(image.id, ref.id));
      expect(row?.detachedAt).toBeInstanceOf(Date);

      // A true statement — there is no image on that — rather than a 204 implying
      // it removed something. The argument is `DELETE .../products/{pid}`'s.
      const second = await del();
      expect(second.statusCode).toBe(404);
      expect(JSON.parse(second.body).error).toBe('no_image');
    });

    it('deduplicates the same bytes inside one salon, and never across two', async () => {
      const same = makePng(128, 128);
      const a = JSON.parse((await upload('products', PRODUCT, same, 'image/png')).body);
      const b = JSON.parse((await upload('services', SERVICE, same, 'image/png')).body);
      expect(b.id).toBe(a.id); // one row, two attachments
      expect((await db.select().from(image)).length).toBe(1);
      expect((await db.select().from(imageAttachment)).length).toBe(2);

      // The other salon uploading the identical file gets its OWN row and its own
      // copy of the bytes. Sharing would tell Lumiere that Amara holds this file.
      const c = JSON.parse(
        (
          await upload('products', OTHER_PRODUCT, same, 'image/png', otherManager, OTHER_SALON)
        ).body,
      );
      expect(c.id).not.toBe(a.id);
      const rows = await db.select().from(image);
      expect(rows.length).toBe(2);
      expect(new Set(rows.map((r) => r.salonId))).toEqual(new Set([SALON, OTHER_SALON]));
    });

    it('survives two identical uploads racing, with no stranded blob', async () => {
      /**
       * A MERCHANT DOUBLE-CLICKING SAVE. Both requests hash to the same digest,
       * find no row, and try to insert one — and `image_salon_checksum_key` can
       * only admit one of them.
       *
       * The first version of `attachImage` read first and inserted second, and it
       * also derived the storage key from the freshly minted image ID. So the
       * loser got a 500 from a constraint violation AND left an object under a key
       * no row named — a stranded blob the reaper cannot collect, because the
       * reaper scans `image`. Both halves are fixed: the key is content-addressed
       * so both racers write the same object, and the insert is
       * `onConflictDoNothing` followed by reading the winner.
       */
      const same = makePng(133, 133);
      const [a, b] = await Promise.all([
        upload('products', PRODUCT, same, 'image/png'),
        upload('services', SERVICE, same, 'image/png'),
      ]);
      expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
      expect(JSON.parse(a.body).id).toBe(JSON.parse(b.body).id);

      const rows = await db.select().from(image);
      expect(rows.length).toBe(1);
      // One object, named by the one row, addressed by the digest of its bytes.
      expect(rows[0]?.storageKey).toBe(`${SALON}/${sha(same)}.png`);
      expect((await db.select().from(imageAttachment)).length).toBe(2);
    });

    it('does not mark a shared image detached while the other owner still holds it', async () => {
      const same = makePng(140, 140);
      const ref = JSON.parse((await upload('products', PRODUCT, same, 'image/png')).body);
      await upload('services', SERVICE, same, 'image/png');

      await app.inject({
        method: 'DELETE',
        url: `/v1/salons/${SALON}/products/${PRODUCT}/image`,
        headers: { authorization: `Bearer ${manager}` },
      });

      const [row] = await db.select().from(image).where(orm.eq(image.id, ref.id));
      // One attachment gone, one left. Marking here would have the reaper delete
      // bytes the service is still serving.
      expect(row?.detachedAt).toBeNull();
      expect((await db.select().from(imageAttachment)).length).toBe(1);
    });

    it('resurrects a detached row when the same file is uploaded again', async () => {
      const same = makePng(150, 150);
      const ref = JSON.parse((await upload('products', PRODUCT, same, 'image/png')).body);
      await app.inject({
        method: 'DELETE',
        url: `/v1/salons/${SALON}/products/${PRODUCT}/image`,
        headers: { authorization: `Bearer ${manager}` },
      });
      expect((await db.select().from(image).where(orm.eq(image.id, ref.id)))[0]?.detachedAt)
        .toBeInstanceOf(Date);

      // The merchant changes her mind and re-uploads the same file.
      const again = JSON.parse((await upload('products', PRODUCT, same, 'image/png')).body);
      expect(again.id).toBe(ref.id);
      /**
       * THE SILENT DATA LOSS THIS PREVENTS: without the clear, the row stays
       * marked, the reaper deletes the bytes some hours later, and every read
       * after that is a 404 under a LIVE attachment with nothing in any log
       * saying why.
       */
      expect((await db.select().from(image).where(orm.eq(image.id, ref.id)))[0]?.detachedAt)
        .toBeNull();
    });

    it('reaps a detached image past the grace window — bytes first, then the row', async () => {
      const ref = JSON.parse(
        (await upload('products', PRODUCT, makePng(160, 160), 'image/png')).body,
      );
      await app.inject({
        method: 'DELETE',
        url: `/v1/salons/${SALON}/products/${PRODUCT}/image`,
        headers: { authorization: `Bearer ${manager}` },
      });

      // Inside the window: nothing is taken, which is the undo.
      expect(await runImageReapOnce(db)).toMatchObject({ candidates: 0, reaped: 0 });
      expect((await fetchImage(ref.id)).statusCode).toBe(200);

      // Age it past IMAGE_DETACHED_GRACE_HOURS.
      await db
        .update(image)
        .set({ detachedAt: new Date(Date.now() - 48 * 3_600_000) })
        .where(orm.eq(image.id, ref.id));

      const result = await runImageReapOnce(db);
      expect(result).toMatchObject({ candidates: 1, reaped: 1, storeFailures: 0 });
      expect(result.reapedIds).toEqual([ref.id]);
      expect(await db.select().from(image).where(orm.eq(image.id, ref.id))).toEqual([]);
      // And it is safe to run twice.
      expect(await runImageReapOnce(db)).toMatchObject({ candidates: 0, reaped: 0 });
    });

    it('never reaps an image something still points at', async () => {
      const ref = JSON.parse(
        (await upload('products', PRODUCT, makePng(170, 170), 'image/png')).body,
      );
      /**
       * The mark is forced on a LIVE row — the state a bug, or a race, could
       * produce. The delete's own WHERE re-states "still unreferenced", so the
       * pass must decline. `ON DELETE RESTRICT` on the attachment is the third
       * guard behind it, and the one that cannot be forgotten.
       */
      await db
        .update(image)
        .set({ detachedAt: new Date(Date.now() - 48 * 3_600_000) })
        .where(orm.eq(image.id, ref.id));

      const result = await runImageReapOnce(db);
      expect(result).toMatchObject({ candidates: 1, reaped: 0, reattached: 1 });
      expect((await db.select().from(image).where(orm.eq(image.id, ref.id))).length).toBe(1);
    });
  });
});
