-- ===========================================================================
-- 0041 — the first image capability in this product
--
-- THE GAP: nothing in this system has ever stored a byte of image data. The
-- merchant dashboard draws an `image-slot` for "App icon & logo" and trunk
-- deferred it (`api/src/services/salonOnboarding.ts` § NOT BUILT, "a gap of the
-- same class trunk already deferred for logo and typography storage"). Products
-- and services are now asked to carry a picture, so this is the primitive rather
-- than a column.
--
-- TWO TABLES, AND THE ARGUMENT IS IN `src/db/schema/image.ts`'s header in full.
-- The short version: `image` is a blob registry, `image_attachment` says what a
-- blob is ON. Adding the logo later is one `CHECK` widening on `owner_type`;
-- adding a gallery later is one `CHECK` widening on `role` plus the `position`
-- column that is already here. Neither is a redesign, which is the property this
-- shape was chosen for.
--
-- REPORTED AS CONTRACT ADDITIONS. `packages/types` is trunk-owned and carries
-- neither `ImageRef` nor an `image` field on `ProductSchema`/`ServiceSchema`.
-- Zod STRIPS an undeclared key rather than failing, so the API emitting `image`
-- today is additive in both directions — a client validating through the current
-- schema silently drops it, which is the safe direction and is exactly why the
-- types must land before the dashboard and wallet are dispatched.
--
-- NO DATA CHANGES. Two new tables; nothing existing is touched, and every
-- product and service keeps working with no image attached.
--
-- PRIVILEGES: migration 0001's `ALTER DEFAULT PRIVILEGES` grants `avo_app`
-- SELECT/INSERT/UPDATE/DELETE on tables added later, and that baseline is what
-- these two want — the reaper DELETEs `image` rows as the application role, and
-- `detached_at` is an UPDATE. So there is NO explicit REVOKE here, and that is a
-- decision rather than the omission 0040 was written about: neither table is
-- append-only, neither is a counter, and neither holds a credential. Said out
-- loud because 0001 asks a later table to state which of the two it is.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS image (
  id                 text PRIMARY KEY,
  -- The tenancy root. Every read is scoped by this and nothing else.
  salon_id           text NOT NULL REFERENCES salon(id) ON DELETE RESTRICT,

  -- The driver's own address for the bytes, and which driver minted it.
  storage_key        text NOT NULL,
  driver             text NOT NULL,

  content_type       text NOT NULL,
  byte_size          bigint NOT NULL,
  width              integer NOT NULL,
  height             integer NOT NULL,
  checksum_sha256    text NOT NULL,

  -- Soft references, like audit_log's actor: seven years outlives staff turnover.
  uploaded_by_kind   text,
  uploaded_by_id     text,

  -- NULL means live. Set when the LAST attachment goes; the reaper reads it.
  detached_at        timestamptz,

  created_at         timestamptz NOT NULL DEFAULT now(),

  -- The three the boundary accepts. SVG is absent on purpose and the reasoning
  -- is in `src/images/inspect.ts` § SVG IS REFUSED: it is an XML document with a
  -- script host in it, served from an origin the wallet trusts.
  CONSTRAINT image_content_type_allowed
    CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  CONSTRAINT image_dimensions_positive CHECK (width > 0 AND height > 0),
  CONSTRAINT image_byte_size_positive CHECK (byte_size > 0),
  -- 64 lowercase hex characters or it is not a sha256, and a checksum that is
  -- not one is a checksum nothing can ever verify against.
  CONSTRAINT image_checksum_is_sha256 CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS image_salon_idx ON image (salon_id);

-- The reaper's only scan, and it is partial so it never walks the live rows.
CREATE INDEX IF NOT EXISTS image_detached_idx
  ON image (detached_at) WHERE detached_at IS NOT NULL;

-- DEDUPE IS PER SALON AND NEVER ACROSS THEM. Two products in one salon uploaded
-- from the same file share a row. Two SALONS with the same stock photo get two
-- rows and two copies: sharing across tenants would tell salon A that salon B
-- holds that exact file, and would give A a deletion path into B's bytes.
CREATE UNIQUE INDEX IF NOT EXISTS image_salon_checksum_key
  ON image (salon_id, checksum_sha256);

CREATE UNIQUE INDEX IF NOT EXISTS image_storage_key_key ON image (storage_key);

CREATE TABLE IF NOT EXISTS image_attachment (
  id           text PRIMARY KEY,
  -- RESTRICT, deliberately: a cascade would let a DELETE on `image` strip
  -- pictures off live products. The reaper must find zero attachments before it
  -- may remove a row, and this is what makes that a database fact.
  image_id     text NOT NULL REFERENCES image(id) ON DELETE RESTRICT,
  salon_id     text NOT NULL REFERENCES salon(id) ON DELETE RESTRICT,

  -- No FK on (owner_type, owner_id) — a polymorphic owner cannot have one. What
  -- replaces it is salon_id, which IS a foreign key and is the only thing tenancy
  -- is ever decided from. See src/db/schema/image.ts § THE COST.
  owner_type   text NOT NULL,
  owner_id     text NOT NULL,
  role         text NOT NULL,
  position     integer NOT NULL DEFAULT 0,

  created_at   timestamptz NOT NULL DEFAULT now(),

  -- THE TWO WIDENING POINTS. Adding the salon logo is one ALTER on the first;
  -- adding a product gallery is one ALTER on the second.
  CONSTRAINT image_attachment_owner_type_allowed
    CHECK (owner_type IN ('product', 'service')),
  CONSTRAINT image_attachment_role_allowed CHECK (role IN ('primary')),
  CONSTRAINT image_attachment_position_nonnegative CHECK (position >= 0)
);

CREATE INDEX IF NOT EXISTS image_attachment_owner_idx
  ON image_attachment (salon_id, owner_type, owner_id);

CREATE INDEX IF NOT EXISTS image_attachment_image_idx ON image_attachment (image_id);

-- One image per slot.
CREATE UNIQUE INDEX IF NOT EXISTS image_attachment_slot_key
  ON image_attachment (owner_type, owner_id, role, position);

-- EXACTLY ONE PRIMARY PER OWNER, in the database. The slot key above would permit
-- primary/0 and primary/1, which for a gallery role is right and for `primary` is
-- a shop tile that renders a different picture depending on which row sorts first.
CREATE UNIQUE INDEX IF NOT EXISTS image_attachment_one_primary_key
  ON image_attachment (owner_type, owner_id) WHERE role = 'primary';
