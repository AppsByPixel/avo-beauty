-- ---------------------------------------------------------------------------
-- A CUSTOM AMOUNT: A PRICE A MANAGER TYPED, RECORDED AS ONE.
--
-- `POST /charges` prices a basket from `service.price_fils`. The scanner can
-- therefore only ring up what is on the menu, and a salon that does something
-- the menu does not name — a half-treatment, a bridal package assembled on the
-- day, a goodwill adjustment to a price — has no way to take the money through
-- AVO at all.
--
-- The authority to type a figure is ruled to managers. That ruling is enforced
-- in `auth/principal.ts` on `perms.void` and it is not what this migration is
-- about. This migration is about the OTHER half, which is that the resulting row
-- must not be indistinguishable from a priced one.
--
-- WHY A STORED COLUMN, WHEN 0027 AND 0042 BOTH REFUSED ONE
-- -------------------------------------------------------
-- 0027 refused to store the basket's service ids a second time, because
-- `basket_hash` already answered "what was this for". 0042 refused a
-- `transaction.deposit_applied_fils` column, because the ledger already
-- determined the number and a stored copy could disagree with it.
--
-- Neither argument applies here, and the difference is the whole justification.
-- WHO DECIDED THIS PRICE IS NOT RECORDED ANYWHERE. `amount_fils` says what
-- moved; `basket_hash` says what it was for; `created_by_staff_id` says who was
-- standing at the till — and a 25.000 KD charge is byte-identical whether it
-- came off the menu or out of somebody's head. It cannot be derived, so it is
-- stored, and `branch_assumed` (migration 0012) is the precedent for storing
-- exactly this class of fact: "per-branch revenue is a figure a merchant acts
-- on... without this, a defaulted row is indistinguishable from a real one
-- forever". Per-artist revenue is a figure a merchant pays a BONUS on.
--
-- THE THREE CONSTRAINTS, AND WHY EACH IS AT THE DATABASE
-- -----------------------------------------------------
--   `..._is_charge_only`      A typed price is a charge and nothing else. A
--                             `shop` row is priced from `product.price_fils`
--                             exactly as a charge is priced from
--                             `service.price_fils`, so "a custom shop order" is
--                             a separate authority nobody has asked for. An
--                             endpoint that quietly acquired one is caught here
--                             rather than in a report.
--
--   `..._has_basket_hash`     A custom charge carries its hash, so the
--                             near-duplicate guard (0031, DECISIONS.md item 3)
--                             stays reachable on the riskiest path in the
--                             product. `services/charge.ts § basketHashFor`
--                             hashes the sorted service ids for a menu charge
--                             and the AMOUNT for a typed one, so the column
--                             keeps one meaning — "what this charge was for,
--                             canonically" — in both cases. A NULL hash is what
--                             the guard treats as un-comparable history, and a
--                             double-tapped 40.000 KD with nothing to compare
--                             against is the failure this prevents.
--                             ONE-DIRECTIONAL: a MENU charge may still be NULL,
--                             because every charge written before 0031 is.
--
--   `..._has_note`            A typed price says what it was for. A menu charge
--                             is self-describing — its hash names rows in
--                             `service` that have names and prices. A custom
--                             charge has no such row anywhere: `basket_hash` is
--                             a sha256 of a number, and
--                             `best-selling-services` cannot attribute it. The
--                             note is the ONLY thing that will ever answer "what
--                             was this 25.000 KD", which is the question the
--                             feature has to survive in a dispute. `POST /voids`
--                             already requires a reason and already carries it
--                             into this column.
--
-- NO BACKFILL AND NOTHING AMBIGUOUS ABOUT THE DEFAULT. A custom amount could not
-- be taken before this column existed, so `false` on an existing row is a fact
-- rather than an absence of information — which is the opposite of `basket_hash`,
-- whose NULL history forced the guard to treat NULL as un-comparable.
--
-- THE VIEW IS UNAFFECTED. `transaction_revenue` (0042) selects named columns, and
-- that migration's own cost note says adding columns does not touch it. A custom
-- charge is a settled `charge`, so it appears in the view and in `sales` gross
-- exactly as a walk-in does — which is correct: it is money the salon took.
--
-- THE INDEX is partial, on the true rows only. They are the rare case, so it is a
-- few pages rather than a second copy of the table, and "show me every typed price
-- this salon took" is the query a merchant reviewing the month actually runs.
-- ---------------------------------------------------------------------------
ALTER TABLE "transaction"
  ADD COLUMN "custom_amount" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "transaction"
  ADD CONSTRAINT "transaction_custom_amount_is_charge_only"
  CHECK ("custom_amount" = false OR "kind" = 'charge');
--> statement-breakpoint
ALTER TABLE "transaction"
  ADD CONSTRAINT "transaction_custom_amount_has_basket_hash"
  CHECK ("custom_amount" = false OR "basket_hash" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "transaction"
  ADD CONSTRAINT "transaction_custom_amount_has_note"
  CHECK ("custom_amount" = false OR ("note" IS NOT NULL AND length(btrim("note")) > 0));
--> statement-breakpoint
CREATE INDEX "transaction_custom_amount_idx"
  ON "transaction" ("salon_id", "created_at" DESC)
  WHERE "custom_amount";
