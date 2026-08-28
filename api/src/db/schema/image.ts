/**
 * Images — the first image capability in this product, and deliberately a
 * PRIMITIVE rather than a column on `product`.
 *
 * ============================================================================
 * WHY TWO TABLES AND NOT `product.image_id`
 * ============================================================================
 * A single `image_id` column on `product` and another on `service` would ship
 * this slice in half the code and be a dead end three times over, each one
 * already visible in the design bundle:
 *
 *   THE SALON LOGO IS TWO IMAGES, NOT ONE. `design/AVO Merchant Dashboard.dc.html`
 *   draws one `image-slot` captioned "App icon & logo" — that is an app icon AND
 *   a logo, two roles on one owner. A column per role is a column per role for
 *   ever: `logo_image_id`, `app_icon_image_id`, `cover_image_id`.
 *
 *   A SHOP TILE WANTS MORE THAN ONE PICTURE EVENTUALLY. Every catalog does. With
 *   a column, the second picture is a schema change plus a migration plus four
 *   surfaces; with a row, it is a `position`.
 *
 *   THE OWNER SET IS ALREADY WIDER THAN THIS SLICE. Salon (deferred —
 *   services/salonOnboarding.ts records "logo and typography storage" as trunk's
 *   own deferral), and artist head-shots are drawn in the Book flow.
 *
 * So: `image` is a BLOB REGISTRY — what these bytes are, how big, whose. And
 * `image_attachment` is WHAT THEY ARE ON — owner kind, owner id, role, position.
 * Widening either dimension is a CHECK constraint edit, which is a one-statement
 * migration, not a redesign. That is the whole claim being made here, and it is
 * the answer to "if your design only works for one image per product, say so":
 * it does not, and this is why.
 *
 * ============================================================================
 * THE COST OF THE POLYMORPHIC OWNER, STATED RATHER THAN HIDDEN
 * ============================================================================
 * `owner_type` + `owner_id` cannot carry a foreign key. That is a real loss and
 * it is bought deliberately: the alternative is one nullable FK column per owner
 * kind (`product_id`, `service_id`, `salon_id`, `artist_id`, …) plus a CHECK that
 * exactly one is non-null, which keeps referential integrity and reintroduces the
 * column-per-kind growth this design exists to avoid.
 *
 * What replaces the FK is `salon_id`, which IS a foreign key, is NOT NULL on both
 * tables, and is the only thing tenancy is ever decided from. An attachment can
 * name a product id that does not exist; it cannot name one belonging to another
 * salon and be read, because every read is `WHERE salon_id = <the principal's>`.
 * The dangling-owner case is a wasted row, not a leak — and `services/imageAttachment.ts`
 * only ever writes one after reading the owner inside the same salon scope.
 *
 * ============================================================================
 * BYTES ARE IMMUTABLE. `image` ROWS ARE NEVER UPDATED IN PLACE.
 * ============================================================================
 * There is no "replace the bytes of IM-XXXX". A replacement mints a new row, new
 * key, new id, and repoints the attachment. Three things fall out of that and all
 * three are worth having: `GET /v1/images/{id}` can be cached `immutable` for a
 * year; a checksum written once is a checksum that stays true; and a half-failed
 * replacement can never leave a row describing bytes that are no longer there.
 *
 * `detached_at` is the ONLY mutable column, and it is the orphan story. See
 * services/imageReaper.ts.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { timestamptz } from './_shared';
import { salon } from './salon';

/** The three the boundary accepts. Mirrors images/inspect.ts § ACCEPTED_IMAGE_TYPES. */
export const IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** The owner kinds THIS SLICE registers. Widened by migration, not by code. */
export const IMAGE_OWNER_TYPES = ['product', 'service'] as const;

/** The roles THIS SLICE registers. `logo` and `app_icon` are the next two. */
export const IMAGE_ROLES = ['primary'] as const;

export const image = pgTable(
  'image',
  {
    id: text('id').primaryKey(),
    /**
     * THE TENANCY ROOT. Not derived from the attachment, because an image with no
     * attachment still belongs to somebody — and the moment a detached row's
     * owner became unknowable, the reaper would be deleting bytes it could not
     * attribute and `GET /v1/images/{id}` would have nothing to check against.
     */
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),

    /** The driver's own address for the bytes. Opaque above images/. */
    storageKey: text('storage_key').notNull(),
    /** Which driver wrote them. A store swap has to be able to find its own. */
    driver: text('driver').notNull(),

    contentType: text('content_type').notNull(),
    /**
     * bigint, and NOT because an image is ever that big. `_shared.ts` reserves
     * `filsColumn` for money and this is not money — but `integer` would cap at
     * 2 GB and the honest type for a byte count is the wide one. Read as a JS
     * number; every value is far inside MAX_SAFE_INTEGER.
     */
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    /** Lowercase hex sha256 of the exact bytes. Dedupe key and integrity check. */
    checksumSha256: text('checksum_sha256').notNull(),

    /** Who uploaded it — a soft reference, like audit_log's actor. */
    uploadedByKind: text('uploaded_by_kind'),
    uploadedById: text('uploaded_by_id'),

    /**
     * Set when the LAST attachment goes, cleared if one comes back. NULL means
     * live. The reaper reads this and nothing else; see services/imageReaper.ts.
     */
    detachedAt: timestamptz('detached_at'),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('image_salon_idx').on(t.salonId),
    /** The reaper's only scan. Partial, so it never walks the live rows. */
    index('image_detached_idx').on(t.detachedAt).where(sql`${t.detachedAt} IS NOT NULL`),
    /**
     * DEDUPE IS PER SALON AND NEVER ACROSS THEM.
     *
     * Two products in one salon uploaded from the same file share a row, which is
     * the storage saving and the reason `detached_at` is "last attachment gone"
     * rather than "an attachment went".
     *
     * ACROSS salons it would be a cross-tenant fact leak AND a shared deletion
     * path: salon A uploading a file and getting back salon B's existing image id
     * tells A that B holds that exact file, and A retiring the product would then
     * be reasoning about bytes B is still serving. Two salons with the same stock
     * photo get two rows and two copies. That is the correct amount of waste.
     */
    uniqueIndex('image_salon_checksum_key').on(t.salonId, t.checksumSha256),
    uniqueIndex('image_storage_key_key').on(t.storageKey),
    check(
      'image_content_type_allowed',
      sql`${t.contentType} IN ('image/png', 'image/jpeg', 'image/webp')`,
    ),
    check('image_dimensions_positive', sql`${t.width} > 0 AND ${t.height} > 0`),
    check('image_byte_size_positive', sql`${t.byteSize} > 0`),
    // 64 lowercase hex characters or it is not a sha256, and a checksum that is
    // not one is a checksum nothing can verify against.
    check('image_checksum_is_sha256', sql`${t.checksumSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const imageAttachment = pgTable(
  'image_attachment',
  {
    id: text('id').primaryKey(),
    imageId: text('image_id')
      .notNull()
      /**
       * `restrict`, deliberately. A cascade would let `DELETE FROM image` quietly
       * strip pictures off live products; the reaper must find zero attachments
       * BEFORE it may remove a row, and this constraint is what makes that a
       * database fact rather than a promise in the reaper.
       */
      .references(() => image.id, { onDelete: 'restrict' }),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),

    /** 'product' | 'service' today. See IMAGE_OWNER_TYPES. */
    ownerType: text('owner_type').notNull(),
    /** No FK — see the file header for what is bought and what is paid. */
    ownerId: text('owner_id').notNull(),
    /** 'primary' today. See IMAGE_ROLES. */
    role: text('role').notNull(),
    /** Ordering within a role. Always 0 while the only role is `primary`. */
    position: integer('position').notNull().default(0),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('image_attachment_owner_idx').on(t.salonId, t.ownerType, t.ownerId),
    index('image_attachment_image_idx').on(t.imageId),
    /** One image per slot. A gallery is distinct positions under one role. */
    uniqueIndex('image_attachment_slot_key').on(t.ownerType, t.ownerId, t.role, t.position),
    /**
     * EXACTLY ONE PRIMARY PER OWNER, in the database.
     *
     * The slot key above permits `primary/0` and `primary/1`, which for a gallery
     * role is right and for `primary` is a shop tile that renders two different
     * pictures depending on which row sorts first. Partial unique index, so
     * widening `IMAGE_ROLES` to add `gallery` does not touch it.
     */
    uniqueIndex('image_attachment_one_primary_key')
      .on(t.ownerType, t.ownerId)
      .where(sql`${t.role} = 'primary'`),
    check('image_attachment_owner_type_allowed', sql`${t.ownerType} IN ('product', 'service')`),
    check('image_attachment_role_allowed', sql`${t.role} IN ('primary')`),
    check('image_attachment_position_nonnegative', sql`${t.position} >= 0`),
  ],
);
