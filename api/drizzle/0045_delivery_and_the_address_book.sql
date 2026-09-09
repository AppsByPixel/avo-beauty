-- ---------------------------------------------------------------------------
-- THE SHOP IS DELIVERY-BASED.        (item 7, PRIOR-ART.md § Lean's shop)
--
-- Read out of the Lean codebase rather than invented, and four decisions come
-- free from an app that has served ten tenants for years:
--
--   PICKUP IS A FORK, NOT A CASUALTY. `deliveryOption` is "pickup" or "address"
--       and both paths are live, so "delivery-based" means delivery is available
--       and chosen. The design bundle's Pickup copy stays.
--   THREE STATUSES, NOT A WORKFLOW ENGINE. preparing → ready → closed. Anything
--       richer would be us inventing rather than following.
--   A SAVED ADDRESS BOOK, keyed to the MEMBER and not to an order, named so it
--       can be reused, with coordinates riding along.
--   NO DELIVERY FEE. There is no `deliveryCharge`, `deliveryFee` or `shippingFee
--       anywhere in Lean's source, and this is the most consequential finding:
--       following it keeps the shop ENTIRELY OFF THE MONEY PATH. No new
--       idempotency key, no atomic multi-table money write, no refund case. A fee
--       would be its own slice with its own decision.
--
-- SO NOTHING HERE TOUCHES `transaction`, `ledger_entry` OR AN AMOUNT. `shop_order`
-- hangs off a transaction that already exists and settled; deciding where a
-- bottle goes cannot change what it cost. That is the property to preserve if
-- this is ever extended.
--
-- =========================================================================
-- THE ONE THING NOT COPIED, AND IT IS THE REASON THESE COLUMNS LOOK LIKE THIS
-- =========================================================================
-- Lean's `addressDetail.js:110-140` collects TWO inputs and sends one of them as
-- FOUR different address fields — `houseNo` into `block`, `buildingNumber`,
-- `floor` AND `apartment`, with the landmark written where the street belongs,
-- `areaId`/`regionId` hardcoded to 1, and two fields shipping the literal text
-- `'string'`.
--
-- Kuwaiti addresses are genuinely BLOCK, STREET, BUILDING. So a driver receives a
-- house number in the block field and a landmark in the street field, and that
-- costs somebody real time on the day it matters.
--
-- What this does instead: collect the fields we actually intend to store, store
-- exactly those, and LET A FIELD BE NULL rather than filling it with a copy of
-- another field or a placeholder. Every optional component below is nullable and
-- there is no default anywhere — if Places cannot resolve a component, it is
-- absent, and absent is a fact a driver can act on.
--
-- `area` and `governorate` are free TEXT, not ids into tables we do not have.
-- Lean's hardcoded `areaId: 1` is what an id column with nothing behind it
-- becomes.
-- ---------------------------------------------------------------------------
CREATE TYPE "order_fulfilment" AS ENUM ('pickup', 'delivery');
--> statement-breakpoint
CREATE TYPE "order_status" AS ENUM ('preparing', 'ready', 'closed');
--> statement-breakpoint
CREATE TABLE "member_address" (
  "id" text PRIMARY KEY NOT NULL,
  "member_id" text NOT NULL,
  -- What she calls it: "Home", "Mum's". Lean's `saveAs`, and the reason an
  -- address book is reusable rather than retyped.
  "label" text NOT NULL,

  -- The parts a Kuwaiti address actually has. `block`, `street` and `building`
  -- are required because an address missing any of them cannot be delivered to;
  -- everything below them is genuinely optional in a real address.
  "block" text NOT NULL,
  "street" text NOT NULL,
  "building" text NOT NULL,
  "floor" text,
  "apartment" text,
  "area" text,
  "governorate" text,
  -- Free text from the customer: "the green door", "call on arrival". NEVER a
  -- placeholder — see the header on Lean's `'string'`.
  "instructions" text,

  -- ---------------------------------------------------------------------
  -- COORDINATES ARE `text`, AND THE REASON IS AN INVARIANT RATHER THAN TASTE.
  --
  -- `scripts/verify-constraints.sql` § 4 bans the whole float family — "`numeric`
  -- is refused with the floats" — and it is a BLANKET ban on purpose: its own
  -- comment explains that the `%_fils` naming rule "only catches money that was
  -- NAMED correctly", so a `legacy_price real` would pass every other check and
  -- still put a float one join away from a total. Written first as
  -- `numeric(9,6)`, this tripped it, which is the invariant doing exactly its job.
  --
  -- The right answer is the column, not the rule. Nothing in this build does
  -- ARITHMETIC on a coordinate — it is handed to a map — so text loses nothing,
  -- is exact, and needs no opinion about which numerics are safe. Carving an
  -- exception into a deliberately blanket check would spend the rule's whole
  -- value on a feature that does not need it.
  --
  -- Still VALIDATED, so `text` is not a licence to store anything: the shape and
  -- the range are CHECKed below, casting inside the expression rather than in the
  -- column type.
  -- ---------------------------------------------------------------------
  "latitude" text,
  "longitude" text,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Soft-deleted, so an order placed to an address she later removes still has
  -- something to point at. Same reasoning as `product.active`.
  "deleted_at" timestamp with time zone,

  CONSTRAINT "member_address_member_id_member_id_fk"
    FOREIGN KEY ("member_id") REFERENCES "member"("id") ON DELETE restrict,
  -- The required parts cannot be blank OR whitespace. A blank `block` is the
  -- same defect as a placeholder one, arriving through a different door.
  CONSTRAINT "member_address_label_not_blank" CHECK (length(btrim("label")) > 0),
  CONSTRAINT "member_address_block_not_blank" CHECK (length(btrim("block")) > 0),
  CONSTRAINT "member_address_street_not_blank" CHECK (length(btrim("street")) > 0),
  CONSTRAINT "member_address_building_not_blank" CHECK (length(btrim("building")) > 0),
  -- Both or neither. A latitude with no longitude is not half a location, it is
  -- a bug that renders as the Gulf of Guinea.
  CONSTRAINT "member_address_coordinates_are_a_pair"
    CHECK (("latitude" IS NULL) = ("longitude" IS NULL)),
  -- A decimal string, up to six places — the precision Places gives and about
  -- 0.1m at this latitude. The shape is checked BEFORE the cast, so a value that
  -- is not a number is refused rather than raising inside the range test.
  CONSTRAINT "member_address_latitude_in_range" CHECK (
    "latitude" IS NULL OR (
      "latitude" ~ '^-?[0-9]{1,3}(\.[0-9]{1,6})?$'
      AND "latitude"::numeric >= -90 AND "latitude"::numeric <= 90)),
  CONSTRAINT "member_address_longitude_in_range" CHECK (
    "longitude" IS NULL OR (
      "longitude" ~ '^-?[0-9]{1,3}(\.[0-9]{1,6})?$'
      AND "longitude"::numeric >= -180 AND "longitude"::numeric <= 180))
);
--> statement-breakpoint
CREATE INDEX "member_address_member_idx" ON "member_address" ("member_id", "created_at" DESC);
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- `shop_order` — the FULFILMENT of an order that has already been paid for.
--
-- ONE ROW PER SHOP TRANSACTION, and `transaction_id` is the primary key rather
-- than a surrogate with a unique index: an order has exactly one fulfilment, and
-- making that the key means a second one cannot be written at all.
--
-- THE ADDRESS IS SNAPSHOTTED, NOT ONLY REFERENCED, and this is deliberate.
-- `shop_order_line` already snapshots `name` and `unit_price_fils` for the same
-- reason its own header gives: joining to the catalogue for a name meant "a salon
-- that renamed a bottle would have seen last month's export silently
-- relabelled". An address is worse — she can edit or delete it, and a driver
-- needs what she typed when she ordered. `address_id` rides along for provenance
-- and is nullable, because the row it names may be gone.
--
-- EVERY DELIVERY COLUMN IS NULL FOR A PICKUP, enforced by
-- `shop_order_delivery_has_an_address`, so "pickup" is not a delivery with empty
-- fields.
-- ---------------------------------------------------------------------------
CREATE TABLE "shop_order" (
  "transaction_id" text PRIMARY KEY NOT NULL,
  "salon_id" text NOT NULL,
  "member_id" text NOT NULL,
  "fulfilment" "order_fulfilment" NOT NULL,
  "status" "order_status" DEFAULT 'preparing' NOT NULL,

  -- Provenance only. Nullable: she may delete the address afterwards.
  "address_id" text,
  -- The snapshot. Present exactly when `fulfilment = 'delivery'`.
  "address_label" text,
  "block" text,
  "street" text,
  "building" text,
  "floor" text,
  "apartment" text,
  "area" text,
  "governorate" text,
  "instructions" text,
  -- `text`, matching `member_address` — see the note there on § 4's float ban.
  "latitude" text,
  "longitude" text,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ready_at" timestamp with time zone,
  "closed_at" timestamp with time zone,

  CONSTRAINT "shop_order_transaction_id_transaction_id_fk"
    FOREIGN KEY ("transaction_id") REFERENCES "transaction"("id") ON DELETE restrict,
  CONSTRAINT "shop_order_salon_id_salon_id_fk"
    FOREIGN KEY ("salon_id") REFERENCES "salon"("id") ON DELETE restrict,
  CONSTRAINT "shop_order_member_id_member_id_fk"
    FOREIGN KEY ("member_id") REFERENCES "member"("id") ON DELETE restrict,
  CONSTRAINT "shop_order_address_id_member_address_id_fk"
    FOREIGN KEY ("address_id") REFERENCES "member_address"("id") ON DELETE restrict,

  -- A delivery has the three required parts; a pickup has NONE of them. One
  -- CHECK rather than three, so "pickup with a street" is not storable.
  CONSTRAINT "shop_order_delivery_has_an_address" CHECK (
    ("fulfilment" = 'delivery'
       AND "block" IS NOT NULL AND "street" IS NOT NULL AND "building" IS NOT NULL)
    OR
    ("fulfilment" = 'pickup'
       AND "address_id" IS NULL AND "address_label" IS NULL
       AND "block" IS NULL AND "street" IS NULL AND "building" IS NULL
       AND "floor" IS NULL AND "apartment" IS NULL AND "area" IS NULL
       AND "governorate" IS NULL AND "instructions" IS NULL
       AND "latitude" IS NULL AND "longitude" IS NULL)
  ),
  CONSTRAINT "shop_order_coordinates_are_a_pair"
    CHECK (("latitude" IS NULL) = ("longitude" IS NULL)),
  -- The clock columns and the status are one fact. `ready_at` is set on the way
  -- to ready and KEPT when it closes, so a closed order still records when it
  -- was ready — which is why this is not `(status = 'ready') = (ready_at IS NOT NULL)`.
  CONSTRAINT "shop_order_ready_at_matches_status" CHECK (
    ("status" = 'preparing' AND "ready_at" IS NULL AND "closed_at" IS NULL)
    OR ("status" = 'ready' AND "ready_at" IS NOT NULL AND "closed_at" IS NULL)
    OR ("status" = 'closed' AND "closed_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX "shop_order_salon_status_idx"
  ON "shop_order" ("salon_id", "status", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "shop_order_member_idx" ON "shop_order" ("member_id", "created_at" DESC);
