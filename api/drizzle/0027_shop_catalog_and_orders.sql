-- ===========================================================================
-- 0027 — the shop: a catalog, and orders as lines against a `shop` transaction
--
-- Phase 6's second half. `GET /salons/{id}/products` has returned a hardcoded
-- `{ items: [] }` since the ninth permission needed a server-side gate to hang
-- off, and nothing else in the shop existed: no table, no write endpoint, no
-- checkout. `packages/types` has carried `ProductSchema` and
-- `transaction_kind = 'shop'` the whole time, so this migration adds the storage
-- the contract already describes rather than anything new.
--
-- WHAT `transaction_kind = 'shop'` ALREADY PROMISED, AND WHAT WAS MISSING
-- ---------------------------------------------------------------------
-- The sign CHECK on `transaction` reads, in its own comment:
--
--     "`shop` cannot [be zero] because `service_price_positive` refuses a free
--      line."
--
-- A shop line is priced from a PRODUCT, not from a service, so that sentence
-- named a constraint which did not govern the kind it was explaining. The
-- conclusion was right — a `shop` row is `< 0`, and it should be — and the
-- reason was wrong, which is the harder half to notice, because everything it
-- implied was true anyway. `product_price_positive` below is the constraint the
-- comment was reaching for. Nothing about `transaction` changes here; the claim
-- simply becomes true.
--
-- TWO TABLES, AND WHY NOT THREE
-- -----------------------------
-- There is no `shop_order`. The `shop` transaction IS the order: it already
-- carries the member, the salon, the branch, whether that branch was
-- established, the signed total, the method, the status, the `AVO-SH-…`
-- reference and the instant. An order table beside it would restate all of that
-- and add a second money column able to disagree with `transaction.amount_fils`
-- — which is the defect `member.balance_fils` needs an entire ledger to defend
-- against. So the order's identity is its transaction id, and `shop_order_line`
-- holds only what the transaction cannot: what was bought, and how many.
--
-- WHY LINES EXIST AT ALL, when a charge stores no service rows: a basket of
-- services has no quantities, so ids plus prices reconstruct the total, and
-- `services/charge.ts` puts them in the audit metadata and the receipt payload.
-- A cart does have quantities — `design/AVO Wallet Home.dc.html` is a
-- `{[productId]: qty}` map with − / + steppers — so `Σ qty × price` is not
-- recoverable from a list of ids, and "two of this, one of that" is a different
-- bag to hand over from "one of each".
--
-- SNAPSHOTS, NOT JOINS. `name` and `unit_price_fils` are copied in at the moment
-- of sale, because the Shop editor saves as you type: joining `product` would
-- rewrite the history of every past order the next time a merchant corrected a
-- price, and the receipt she was sent said 8.500. Same instinct as
-- `support_ticket.route` and the actor columns on `audit_log`.
--
-- `line_total_fils` LOOKS REDUNDANT AND IS THE POINT. The CHECK makes
-- `qty × unit_price_fils` a database fact, so a handler that multiplied money
-- with a float, or dropped a quantity, does not commit — non-negotiable #1 made
-- structural on the only money path in this schema that multiplies at all. It
-- also turns "do the lines add up to what she was debited" into one SELECT,
-- which is what invariant 11 in `scripts/verify-constraints.sql` runs.
--
-- LOCKING: two CREATE TABLEs. Neither exists, so there is nothing to lock and no
-- table is rewritten. The GRANT/REVOKE pair touches only the new table.
--
-- GRANTS: migration 0001 set ALTER DEFAULT PRIVILEGES for `avo_app` on tables in
-- `public`, so both tables are readable and writable on creation. `product` stays
-- that way — a catalog is state that legitimately changes, and the dashboard edits
-- it. `shop_order_line` does NOT: a settled purchase is money evidence, so UPDATE
-- and DELETE are revoked exactly as they are on `ledger_entry`, and an order
-- cannot be quietly re-itemised afterwards.
--
-- NO TRUNCATE TRIGGER, and the asymmetry with 0024 is deliberate rather than an
-- omission. `TRUNCATE` requires table ownership; `avo_app` owns nothing, so it
-- cannot truncate either table. 0024 added triggers to `ledger_entry`,
-- `gateway_event` and `audit_log` because those three are the ones whose loss
-- would be unrecoverable and undetectable, and a trigger refuses even the owner.
-- Order lines are reconstructible from the receipt payload and the transaction
-- total; the ledger is not reconstructible from anything.
--
-- Idempotent and safe to re-run.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS product (
  id          text PRIMARY KEY NOT NULL,
  salon_id    text NOT NULL REFERENCES salon(id) ON DELETE restrict,
  name        text NOT NULL,
  -- bigint fils. Non-negotiable #1: there is no other money type in this schema.
  price_fils  bigint NOT NULL,
  -- Retired products stay for old orders to reference; they just cannot be sold.
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- A free product is the same argument at the same counter as a free service.
  -- This is also the constraint `transaction_amount_sign_matches_kind`'s comment
  -- was reaching for. See the header.
  CONSTRAINT product_price_positive CHECK (price_fils > 0),
  -- Whitespace paints an empty row in the shop list and on the receipt.
  CONSTRAINT product_name_not_blank CHECK (length(btrim(name)) > 0)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS product_salon_idx ON product (salon_id);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS shop_order_line (
  transaction_id  text NOT NULL REFERENCES transaction(id) ON DELETE restrict,
  -- `ON DELETE restrict` is why the Shop editor's ✕ retires a product instead of
  -- deleting it: a product removed from under the orders it was sold in leaves a
  -- dangling id in a receipt.
  product_id      text NOT NULL REFERENCES product(id) ON DELETE restrict,

  -- Snapshots, taken at the moment of sale. See the header.
  name            text NOT NULL,
  qty             integer NOT NULL,
  unit_price_fils bigint NOT NULL,
  line_total_fils bigint NOT NULL,

  -- One line per product; the quantity lives in `qty`, which is the cart's own
  -- shape. Two rows for one bottle would make `qty` a number nobody could read
  -- without summing.
  CONSTRAINT shop_order_line_pk PRIMARY KEY (transaction_id, product_id),

  CONSTRAINT shop_order_line_qty_positive CHECK (qty > 0 AND qty <= 99),
  CONSTRAINT shop_order_line_unit_price_positive CHECK (unit_price_fils > 0),
  -- The multiplication, enforced. See the header.
  CONSTRAINT shop_order_line_total_matches_qty CHECK (line_total_fils = qty * unit_price_fils),
  CONSTRAINT shop_order_line_name_not_blank CHECK (length(btrim(name)) > 0)
);--> statement-breakpoint

-- "Which orders has this product ever appeared in" — asked whenever a merchant
-- tries to delete one, and answered without a scan.
CREATE INDEX IF NOT EXISTS shop_order_line_product_idx ON shop_order_line (product_id);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Privileges. Append-only for the application role, like `ledger_entry`.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON shop_order_line TO avo_app;--> statement-breakpoint
REVOKE UPDATE, DELETE ON shop_order_line FROM avo_app;
