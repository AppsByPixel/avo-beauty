/**
 * Images on products and services. The first image capability in this product.
 *
 *   POST   /v1/salons/{id}/products/{pid}/image   perms.shop
 *   DELETE /v1/salons/{id}/products/{pid}/image   perms.shop
 *   POST   /v1/salons/{id}/services/{sid}/image   perms.appointments
 *   DELETE /v1/salons/{id}/services/{sid}/image   perms.appointments
 *   GET    /v1/images/{imageId}                   any principal of that salon
 *
 * `/v1`, because none of this is in `api-contract.md` — the prefix this codebase
 * uses for capabilities added after it (`/v1/salons/{id}/social/{linkId}`,
 * `/v1/salons/{id}/promotions`, `/v1/salons/{id}/campaigns`).
 *
 * ============================================================================
 * THE BODY IS RAW BYTES, NOT MULTIPART AND NOT BASE64
 * ============================================================================
 * `POST … /image` takes the file itself as the request body, with the file's own
 * media type in `Content-Type`. Three reasons, in order of weight:
 *
 *   NO NEW DEPENDENCY. Multipart needs `@fastify/multipart` + `busboy`, and
 *   adding one means editing `pnpm-lock.yaml` at the repository root — outside
 *   `api/`, which is this lane's whole column (CLAUDE.md § Lanes). A slice that
 *   cannot be built inside its column is a slice that should be reported, and
 *   this one does not need to be: a single-file upload has nothing to gain from
 *   a format designed to carry several fields at once.
 *
 *   ONE FEWER PARSER ON THE ATTACK PATH. Multipart boundary parsing is its own
 *   CVE genre. The body here is a Buffer that Fastify collected and nothing
 *   interpreted.
 *
 *   IT IS SIMPLER AT BOTH CALLERS. The dashboard sends the `File` straight from
 *   the input — `fetch(url, { method: 'POST', body: file, headers: { 'content-type':
 *   file.type, authorization } })` — and the wallet, if it ever uploads, sends a
 *   blob the same way. Neither has to build a form.
 *
 * The parsers are registered on the whole instance, because Fastify content-type
 * parsers are per-instance and not per-route. That means `POST /charges` with
 * `Content-Type: image/png` now parses to a Buffer instead of returning 415 —
 * harmless, since that handler reads named fields off the body and a Buffer has
 * none, so it 400s exactly as it did. Written down because it is a real, if
 * small, blast radius outside this file.
 *
 * ============================================================================
 * WHO MAY UPLOAD — AND THE SERVICE ANSWER IS A CHOICE TRUNK SHOULD CONFIRM
 * ============================================================================
 * PRODUCTS: `perms.shop`. Not a judgement call — it is the permission on all
 * three existing writes in `routes/salons.ts` (`POST`, `PATCH`, `DELETE` on
 * `/salons/{id}/products`), the Shop editor is where the merchant would drop the
 * picture, and an image write is a catalog write.
 *
 * SERVICES: `perms.appointments`, AND THE DASHBOARD HAS NO SERVICE EDITOR AT ALL.
 * That is the finding, not the ruling: `design/AVO Merchant Dashboard.dc.html`
 * draws no Services section — services appear only as data inside appointments,
 * reports and the customer drawer — and this API has no service write endpoint
 * either. So there is no designed permission to inherit, and one had to be
 * chosen.
 *
 * `perms.appointments` is chosen on LEAST PRIVILEGE. A service is the thing an
 * appointment is made of; `GET /salons/{id}/bookings` is already gated on that
 * permission and the Book flow's service list is the screen a service photo
 * would appear on. The alternative, `perms.loyalty`, gates `PATCH /salons/{id}`
 * — the tier ladder, the deposit, the brand colour — where a wrong grant is a
 * MONEY bug (build-plan.md calls a half-published ladder exactly that). Nobody
 * should need the authority to rewrite the tier ladder in order to put a picture
 * on a blow-dry.
 *
 * ESCALATED: when the service editor slice lands and the design says which chip
 * it sits under, this is one line. It is called out here rather than buried
 * because the dashboard lane will build a button against it.
 *
 * ============================================================================
 * WHO MAY READ — AUTHENTICATED, AND THE ARGUMENT AGAINST PUBLIC URLS
 * ============================================================================
 * `GET /v1/images/{id}` requires a salon-scoped principal and the image's
 * `salon_id` must be his or hers. It is NOT a public URL, and the reason is not
 * that a product photo is a secret.
 *
 * IT IS THAT THE CATALOG IT BELONGS TO IS NOT PUBLIC EITHER. `GET
 * /salons/{id}/products` refuses a member of another salon and refuses a staff
 * member without `perms.shop`; `routes/salons.ts` spends thirty lines on exactly
 * who may read a shopfront and why it is two different answers. If the pictures
 * in that list were fetchable by anyone holding an id, that gate would be
 * decorative for the half of the catalog that has photos — non-negotiable #7
 * says the UI hiding a button is a courtesy and not a control, and the same
 * sentence applies to a route hiding a list whose contents are individually
 * public.
 *
 * THE COST IS REAL AND IS PAID BY THE CALLERS, NOT WISHED AWAY. An `<img src>`
 * cannot send an `Authorization` header. `routes/reports.ts` hit this exact wall
 * for CSV downloads and solved it with a stored, single-use, sixty-second token
 * in the path — deliberately NOT a stateless signed URL. THAT PATTERN DOES NOT
 * TRANSFER HERE and it is worth saying why, because reaching for it would look
 * like consistency: an `<img>` is re-fetched on scroll, on cache eviction, on
 * retry and on a second render, so single-use is wrong; and a shop list paints
 * forty pictures at once, so a sixty-second mint-per-click is wrong twice.
 *
 * What the two callers do instead, and both are ordinary:
 *   DASHBOARD  `fetch(url, { headers })` → `URL.createObjectURL(blob)`. The
 *              reports comment notes this "re-buffers the file and loses the
 *              server's filename cross-origin" — for an image neither cost
 *              exists: it IS a blob, and it has no filename to lose.
 *   WALLET     React Native `<Image source={{ uri, headers: { Authorization } }} />`,
 *              which is a first-class prop, not a workaround.
 *
 * NO TOKEN IN THE QUERY STRING, ever. It would land in access logs, in the
 * `Referer` of anything the page loads, and in a browser's history — the precise
 * defect `routes/reports.ts` had to fix with `logLevel: 'silent'` once a
 * credential moved into a path.
 *
 * WHEN A CDN LANDS the answer changes shape without changing this route:
 * `ImageStore.presignedUrl` (images/types.ts) is checked below, and a driver that
 * returns one turns this handler into "authorise, then 302". The authority check
 * happens BEFORE that branch, so a presigning driver cannot quietly make a
 * tenant-scoped read public.
 *
 * ============================================================================
 * WHAT THIS DOES NOT DO
 * ============================================================================
 * NO THUMBNAILS, NO RESIZING, NO RE-ENCODING, NO EXIF STRIPPING. Bytes go in and
 * the same bytes come out. That is what keeps an image decoder out of this
 * process entirely (images/inspect.ts § rule 2), and it is a trade with two
 * named costs: the wallet downloads the full-size file on a phone, and a JPEG
 * straight off a camera can carry GPS coordinates in EXIF that this API will
 * serve to every customer of that salon. Neither is closed here. EXIF in
 * particular deserves its own decision — a merchant photographing stock in her
 * own salon is publishing that salon's location, which she is publishing anyway,
 * but she may also be photographing at home. REPORTED, not smuggled in: stripping
 * it means parsing and rewriting the container, which is the decoder this design
 * exists to avoid, or a metadata-only rewriter that is a new dependency.
 */

import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/client';
import { image } from '../db/schema/image';
import { env } from '../env';
import { imageStore } from '../images';
import {
  ACCEPTED_IMAGE_TYPES,
  familyOf,
  familyWithArticle,
  inspectImage,
  isAcceptedImageType,
} from '../images/inspect';
import { ImageStoreNotConfiguredError, ImageStoreUnavailableError } from '../images/types';
import {
  requireDashboardPerm,
  requireSalonScoped,
  requireSameSalon,
  type StaffPrincipal,
} from '../auth/principal';
import { ApiError, badRequest, notFound, serviceUnavailable } from '../http/errors';
import { writeAudit } from '../services/audit';
import {
  attachImage,
  detachImage,
  requireOwnerInSalon,
  type ImageOwnerType,
} from '../services/imageAttachment';

/**
 * The media types the body parser will collect.
 *
 * WIDER THAN THE ACCEPTED LIST, ON PURPOSE. Without a parser registered, Fastify
 * answers a `Content-Type: image/svg+xml` upload with its own generic 415 and the
 * merchant is told "that request could not be read" — which is true, useless, and
 * indistinguishable from a bug. Collecting them means the handler can answer
 * "SVG is not accepted; PNG, JPEG or WebP" and the refusal can be tested.
 */
const COLLECTED_TYPES = [
  ...ACCEPTED_IMAGE_TYPES,
  'image/svg+xml',
  'image/gif',
  'image/avif',
  'image/heic',
  'image/heif',
  'image/bmp',
  'image/tiff',
  'application/octet-stream',
] as const;

/**
 * Per-owner-kind copy for the audit row's `subject_type`.
 *
 * THE PERMISSION IS DELIBERATELY NOT IN THIS TABLE. It was, and a table lookup is
 * exactly what made `e2e/support/perm-census.ts` unable to name which permission
 * to switch off. The permission now appears as a literal at each of the four
 * registration sites; see the comment above `performUpload`.
 */
const OWNER: Record<ImageOwnerType, { subject: string }> = {
  product: { subject: 'product' },
  service: { subject: 'service' },
};

/** A store failure, turned into the status code that describes it. */
function storeError(err: unknown): ApiError {
  if (err instanceof ImageStoreNotConfiguredError) {
    return serviceUnavailable('image_store_unconfigured', err.message);
  }
  if (err instanceof ImageStoreUnavailableError) {
    return new ApiError(
      502,
      'image_store_unavailable',
      'We could not save that image. Try again in a moment.',
      {},
      { cause: err },
    );
  }
  return new ApiError(500, 'server_error', 'Something went wrong on our side.', {}, { cause: err });
}

export async function registerImageRoutes(app: FastifyInstance): Promise<void> {
  /**
   * `parseAs: 'buffer'` and an identity parser. Fastify collects the body against
   * the route's `bodyLimit` and hands it over untouched — nothing here decodes,
   * transcodes or inspects during collection.
   */
  app.addContentTypeParser(
    [...COLLECTED_TYPES],
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  /**
   * TWO CEILINGS, AND THEY ARE DIFFERENT CONTROLS.
   *
   * Fastify's `bodyLimit` is the DoS backstop: it stops a hostile client streaming
   * gigabytes into this process's memory, and it produces Fastify's own blunt 413.
   * It is set to twice the product limit so it is not the thing an honest merchant
   * with a 3 MB photo hits.
   *
   * `IMAGE_MAX_BYTES` is the product rule, checked on the collected buffer, and it
   * produces a named error carrying the limit so the dashboard can say "2 MB max"
   * with a number it did not hard-code.
   */
  const routeOptions = { bodyLimit: env.imageMaxBytes * 2 };

  /**
   * THE GUARD IS INLINE AT EVERY REGISTRATION SITE, AND THAT IS NOT STYLE.
   *
   * These two functions do the work and take an ALREADY-RESOLVED principal. They
   * contain no `require*` call, and each of the four `app.post` / `app.delete`
   * calls below opens with a literal `requireDashboardPerm(req, '<permission>')`.
   *
   * This file did it the other way first — `uploadHandler('product')`, a curried
   * factory holding the guard, with the permission looked up from a table keyed
   * on the owner kind. It was correct at runtime and INVISIBLE TO THE CENSUS.
   * `e2e/support/perm-census.ts` reads route registrations from source, resolves
   * one level of wrapper, and reported all four of these as authenticating
   * NOBODY:
   *
   *     these endpoints authenticate NOBODY and are not in the ANONYMOUS ledger.
   *       POST /v1/salons/:id/products/:oid/image  (images.ts:427)
   *       DELETE /v1/salons/:id/products/:oid/image  (images.ts:432)
   *       POST /v1/salons/:id/services/:oid/image  (images.ts:436)
   *       DELETE /v1/salons/:id/services/:oid/image  (images.ts:441)
   *
   * Two separate defeats, both mine: a curried factory is not the one level of
   * wrapper that census resolves, and a permission read out of `OWNER[kind].perm`
   * has no name for it to switch off even if it had been.
   *
   * `routes/reports.ts` already records this lesson from the other direction — it
   * split `GET /report-downloads/:token` into its own route because a `?dl=`
   * branch made the census "record that route as `requireDashboardPerm` … blind
   * to the token path, so an endpoint reachable with NO header read as gated" —
   * and concludes: "Splitting it makes the security shape visible to the tool
   * built to see it, instead of hiding a capability behind a conditional."
   *
   * A gate the census cannot see is a gate that gets no runtime permission-off
   * probe, which is the second half of non-negotiable #7. So the four extra lines
   * below buy four automated `#7` probes that four elegant ones did not.
   */
  async function performUpload(
    req: FastifyRequest<{ Params: { id: string; oid: string } }>,
    reply: FastifyReply,
    p: StaffPrincipal,
    ownerType: ImageOwnerType,
  ) {
    const { subject } = OWNER[ownerType];

    const declared = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      ?.trim()
      .toLowerCase();

    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
      throw badRequest(
        'empty_body',
        'Send the image file as the request body, with its type in Content-Type.',
      );
    }

    /**
     * THE PRODUCT SIZE RULE. `413`, not `400`: the request was well formed and
     * too big, which is the one thing that status code means. The limit is in the
     * body so a client can render it without a second source of truth.
     */
    if (bytes.byteLength > env.imageMaxBytes) {
      throw new ApiError(
        413,
        'image_too_large',
        `That image is ${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MB. ` +
          `The limit is ${(env.imageMaxBytes / (1024 * 1024)).toFixed(0)} MB.`,
        { maxBytes: env.imageMaxBytes, byteSize: bytes.byteLength },
      );
    }

    /**
     * THE CLAIMED TYPE AND THE ACTUAL BYTES, CHECKED SEPARATELY AND IN THAT ORDER
     * — see images/inspect.ts § rule 1 for why a disagreement is refused rather
     * than resolved in either direction.
     */
    if (!isAcceptedImageType(declared)) {
      const looksLike = familyOf(bytes);
      throw new ApiError(
        415,
        'unsupported_image_type',
        `${declared || 'That'} is not an image type we accept. Send a PNG, JPEG or WebP.` +
          (looksLike === 'svg'
            ? ' An SVG can carry script and is never accepted for a catalog image.'
            : ''),
        { accepted: [...ACCEPTED_IMAGE_TYPES], declared: declared || null },
      );
    }

    const facts = inspectImage(bytes);
    if (!facts) {
      throw badRequest(
        'not_an_image',
        `That file is not a readable ${declared.replace('image/', '').toUpperCase()}. ` +
          `It looks like ${familyWithArticle(familyOf(bytes))}.`,
        { declared },
      );
    }
    if (facts.format !== declared) {
      /**
       * THE CONTENT-TYPE BYPASS, REFUSED BY NAME. A `.svg` renamed `.png` and sent
       * as `image/png` dies at the check above; this one catches a real image
       * carrying the wrong label, which is the same fact from this endpoint's
       * point of view — we would be storing one type and serving a header claiming
       * another.
       */
      throw badRequest(
        'content_type_mismatch',
        `You sent ${declared} but the file is ${familyWithArticle(familyOf(bytes))}. ` +
          'Send the file with its own type.',
        { declared, actual: facts.format },
      );
    }

    /** THE DIMENSION AND PIXEL CEILINGS. env.ts § IMAGE_MAX_PIXELS carries why. */
    const longest = Math.max(facts.width, facts.height);
    if (longest > env.imageMaxDimension) {
      throw badRequest(
        'image_too_large_dimensions',
        `That image is ${facts.width}×${facts.height}. The longest side may be ` +
          `${env.imageMaxDimension} pixels.`,
        { maxDimension: env.imageMaxDimension, width: facts.width, height: facts.height },
      );
    }
    if (facts.width * facts.height > env.imageMaxPixels) {
      throw badRequest(
        'image_too_many_pixels',
        `That image is ${facts.width}×${facts.height}, which is more than this app can ` +
          'open on a phone. Crop it and try again.',
        { maxPixels: env.imageMaxPixels, width: facts.width, height: facts.height },
      );
    }

    // Scoped read, in the WHERE. See services/imageAttachment.ts § RULE 1.
    const owner = await requireOwnerInSalon(db, ownerType, req.params.oid, p.salonId);

    let result;
    try {
      result = await attachImage(db, {
        salonId: p.salonId,
        ownerType,
        ownerId: owner.id,
        bytes,
        contentType: facts.format,
        width: facts.width,
        height: facts.height,
        uploadedByKind: p.kind,
        uploadedById: p.id,
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw storeError(err);
    }

    /**
     * NOT IN A TRANSACTION WITH THE ATTACH ABOVE, AND THAT IS A RECORDED GAP
     * RATHER THAN AN OVERSIGHT. `performDetach` was the same shape and was fixed;
     * this one cannot be fixed the same way, and the reason is worth writing down
     * so the next reader does not "just" wrap it.
     *
     * `attachImage` writes THE BYTES TO THE STORE BEFORE it opens its transaction
     * — RULE 2, `services/imageAttachment.ts`, and the order is what makes an
     * upload idempotent across retries and racers. Handing it a caller-owned `tx`
     * would put an S3 `put` inside an open database transaction, which trades a
     * missing audit row for a database connection held across a network call on
     * the one route that is hit once per tile per scroll. Doing it properly means
     * splitting the put out of `attachImage` so the route can do
     * put-then-transaction, and that is a slice of its own with the RULE 2
     * argument to re-examine.
     *
     * WHAT IT COSTS MEANWHILE, stated plainly: an audit insert that fails after a
     * successful attach leaves the image attached with no log line naming who
     * uploaded it. That is a missing record of an addition the merchant can see
     * on her own screen — strictly less dangerous than the detach case, where the
     * unlogged act also schedules the bytes for deletion.
     */
    await writeAudit(db, p, {
      salonId: p.salonId,
      /**
       * `rules`, matching what `routes/salons.ts` writes for a product edit:
       * nothing moved, what changed is what the salon offers and how it looks.
       */
      kind: 'rules',
      action: result.created ? 'Image added' : 'Image replaced',
      detail:
        `${owner.name} · ${facts.width}×${facts.height} ` +
        `${facts.format.replace('image/', '').toUpperCase()}`,
      source: 'merchant',
      subjectType: subject,
      subjectId: owner.id,
      metadata: {
        imageId: result.ref.id,
        replacedImageId: result.replacedImageId,
        deduplicated: result.deduplicated,
        contentType: facts.format,
        width: facts.width,
        height: facts.height,
        byteSize: bytes.byteLength,
      },
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });

    /**
     * 201 when the slot was empty, 200 when it was replaced. The distinction is
     * the one HTTP actually makes — something new exists, versus something that
     * existed now says something else — and the dashboard needs it to choose
     * between "added" and "changed" in its own toast.
     */
    return reply.code(result.created ? 201 : 200).send(result.ref);
  }

  async function performDetach(
    req: FastifyRequest<{ Params: { id: string; oid: string } }>,
    reply: FastifyReply,
    p: StaffPrincipal,
    ownerType: ImageOwnerType,
  ) {
    const { subject } = OWNER[ownerType];
    /**
     * OUTSIDE THE TRANSACTION, deliberately: it is a read, and its 404 is about
     * the URL rather than about anything this request would change.
     */
    const owner = await requireOwnerInSalon(db, ownerType, req.params.oid, p.salonId);

    /**
     * ONE TRANSACTION AROUND THE DETACH AND THE RECORD OF THE DETACH.
     *
     * These were two separate statements on the pool — `detachImage` committed a
     * transaction of its own and `writeAudit` then ran as a second, independent
     * write. So the two could disagree: an audit insert that failed for any
     * reason left the image detached, the row marked for the reaper, and NOTHING
     * in the log saying who removed it or when. To a merchant asking why her
     * photo vanished that is indistinguishable from the reaper misfiring or from
     * a bug, and it is the one question an audit log exists to answer.
     *
     * The audit row is not money, so this is not non-negotiable #3 — but it is
     * #3's reasoning ("if the debit fails, nothing else happened") applied to a
     * row that is EVIDENCE. `services/imageReaper.ts` is what makes it matter
     * beyond tidiness: the mark is what schedules the bytes for deletion, so an
     * unlogged detach becomes an unlogged permanent loss some hours later.
     *
     * The bytes are untouched either way — a detach never reads or writes the
     * store — so there is no store-side effect stranded by a rollback. That is
     * exactly why THIS half could be fixed and the upload half could not: see the
     * note on `performUpload`.
     */
    await db.transaction(async (tx) => {
      const removed = await detachImage(tx, p.salonId, ownerType, owner.id);

      await writeAudit(tx, p, {
        salonId: p.salonId,
        kind: 'rules',
        action: 'Image removed',
        // "Detached", because that is what happened. The bytes survive the grace
        // window (services/imageReaper.ts) and a merchant asking why the old one
        // came back after an undo deserves the true word in the log.
        detail: `${owner.name} · image detached`,
        source: 'merchant',
        subjectType: subject,
        subjectId: owner.id,
        metadata: { imageId: removed.imageId, detached: true },
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });
    });

    return reply.code(204).send();
  }

  app.post<{ Params: { id: string; oid: string } }>(
    '/v1/salons/:id/products/:oid/image',
    routeOptions,
    async (req, reply) => {
      /**
       * AUTHORITY FIRST, BEFORE THE OWNER IS LOOKED UP AND BEFORE A SINGLE BYTE IS
       * INSPECTED. `auth/principal.ts` § requirePerm states the rule and Lane D's
       * probe is the reason: "an endpoint that looks the token up first and only
       * then checks authority has already told an unauthorised caller whether that
       * token exists." Here it is stronger than usual — validating first would let
       * an unauthorised caller use this endpoint as a free image-format oracle.
       */
      const p = requireDashboardPerm(req, 'shop');
      requireSameSalon(p, req.params.id);
      return performUpload(req, reply, p, 'product');
    },
  );

  app.delete<{ Params: { id: string; oid: string } }>(
    '/v1/salons/:id/products/:oid/image',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'shop');
      requireSameSalon(p, req.params.id);
      return performDetach(req, reply, p, 'product');
    },
  );

  app.post<{ Params: { id: string; oid: string } }>(
    '/v1/salons/:id/services/:oid/image',
    routeOptions,
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'appointments');
      requireSameSalon(p, req.params.id);
      return performUpload(req, reply, p, 'service');
    },
  );

  app.delete<{ Params: { id: string; oid: string } }>(
    '/v1/salons/:id/services/:oid/image',
    async (req, reply) => {
      const p = requireDashboardPerm(req, 'appointments');
      requireSameSalon(p, req.params.id);
      return performDetach(req, reply, p, 'service');
    },
  );

  /**
   * The bytes.
   *
   * `requireSalonScoped` — a member OR a staff member, and then the image's own
   * salon. NOT `requireDashboardPerm`, and the split is the one `routes/salons.ts`
   * already makes for the shop catalog: "Two callers with different rights are two
   * checks." A customer's wallet must render the shop tile she is being sold; a
   * scanner PIN session reads the service list it prices a basket from. Requiring
   * `perms.shop` here would 403 the customer, and requiring nothing would make the
   * catalog gate decorative.
   *
   * NO PERMISSION BEYOND THE TENANCY CHECK, and that is deliberate rather than
   * lax: the picture is not more sensitive than the row it hangs on, and a staff
   * member without `perms.shop` who somehow holds an image id learns that a
   * picture exists — she cannot list them, cannot map one to a product, and cannot
   * reach another salon's at all. Gating this on the owner's permission would mean
   * resolving the attachment on every byte fetch to find out which permission
   * applies, on a route that is hit once per tile per scroll.
   */
  app.get<{ Params: { imageId: string } }>('/v1/images/:imageId', async (req, reply) => {
    const p = requireSalonScoped(req);

    /**
     * ONE UNIFORM 404 for unknown, another salon's, and detached-then-reaped. The
     * caller's remedy is identical in all three and the alternative is an oracle:
     * a 403 for "exists but not yours" tells a merchant that a given id is live in
     * some other salon. `routes/reports.ts` § ONE UNIFORM `invalid_download` makes
     * the same call for the same reason.
     */
    const [row] = await db
      .select({
        id: image.id,
        storageKey: image.storageKey,
        contentType: image.contentType,
        byteSize: image.byteSize,
        checksum: image.checksumSha256,
      })
      .from(image)
      .where(and(eq(image.id, req.params.imageId), eq(image.salonId, p.salonId)))
      .limit(1);
    if (!row) throw notFound('unknown_image', 'No such image.');

    /**
     * THE CDN SEAM. A driver that can presign gets the read redirected to it; the
     * authority check above has already happened, so this cannot widen access.
     * `disk` does not implement it and the bytes are streamed below.
     */
    const presigned = await imageStore.presignedUrl?.(row.storageKey);
    if (presigned) return reply.redirect(presigned, 302);

    let stored;
    try {
      stored = await imageStore.get(row.storageKey);
    } catch (err) {
      throw storeError(err);
    }
    /**
     * A ROW WITH NO BYTES IS A 404 AND AN ERROR-LEVEL LOG LINE, not a 500 and not
     * silence. To the caller it is indistinguishable from an unknown id, which is
     * correct — there is nothing to serve. To an operator it is the one symptom of
     * the failure mode images/disk.ts warns about (a store that did not keep what
     * it was given) and of a reaper that removed bytes it should not have, so it
     * must not be lost in a 404 counter.
     */
    if (!stored) {
      req.log.error(
        { imageId: row.id, storageKey: row.storageKey, driver: imageStore.name },
        'image row has no bytes in the store',
      );
      throw notFound('unknown_image', 'No such image.');
    }

    return reply
      /** The stored type, from the row — never the uploader's header. */
      .header('content-type', row.contentType)
      /**
       * `nosniff` — the single most important header here. Without it a browser
       * may content-sniff a response and decide it is HTML, which turns "we only
       * store PNG/JPEG/WebP" into a claim the browser is free to ignore.
       */
      .header('x-content-type-options', 'nosniff')
      /**
       * DEFENCE IN DEPTH, NOT THE DECISION (images/inspect.ts § SVG). If a future
       * driver, migration or bug ever let a scriptable document through, an empty
       * `default-src` plus `sandbox` means it renders inert rather than executing
       * with AVO's origin.
       */
      .header('content-security-policy', "default-src 'none'; sandbox")
      /** `inline` — this is a picture in a page, not a download. */
      .header('content-disposition', `inline; filename="${row.id}"`)
      /**
       * A YEAR AND `immutable`, WHICH IS ONLY TRUE BECAUSE OF THE SCHEMA. Bytes
       * are never rewritten under an id (db/schema/image.ts § BYTES ARE
       * IMMUTABLE); a replacement mints a new id and the product row points
       * somewhere else. `private`, because the response is tenant-scoped and a
       * shared cache must not hold it.
       */
      .header('cache-control', 'private, max-age=31536000, immutable')
      /** The checksum, which is what an ETag is supposed to be. */
      .header('etag', `"${row.checksum}"`)
      .send(stored.bytes);
  });
}
