-- ---------------------------------------------------------------------------
-- ONE DEFINITION OF WHAT A VISIT WAS WORTH.            (DECISIONS.md #81)
--
-- `transaction.amount_fils` is a movement of the CUSTOMER'S WALLET, and for a
-- booked appointment it is only PART of the visit: services/charge.ts § 4 caps
-- the held deposit at the basket and writes
--
--     amount_fils = -(gross - applied)
--
-- The applied half left her wallet earlier, as the booking's `deposit_hold`, and
-- became salon revenue at charge time through `depositAppliedPosting` — a
-- `deposit_held` DEBIT on the charge's own ledger entries.
--
-- Three places needed that arithmetic and only one of them had it:
--
--   routes/charges.ts   a void's refund     |amount_fils| + the deposit leg   OK
--   reports `sales`     "Gross KD"          sum(-amount_fils)                 NET
--   reports `best-…`    "Revenue KD"        sum(-amount_fils)                 NET
--
-- So a 6.000 service against a 5.000 deposit was exported as 1.000, and an
-- appointment a deposit covered outright as 0.000, under a column the merchant
-- reads as gross. Measured across a driven window: 23.5% of takings missing.
--
-- The fix is not a fourth copy of the expression. It is this view, and every
-- caller reads it — the aggregates, and the void that has to hand back exactly
-- what was earned. "What the salon must give back if this is voided" and "what
-- the salon earned" are one quantity, so they are now one relation.
--
-- WHY A VIEW AND NOT A `transaction.deposit_applied_fils` COLUMN
-- --------------------------------------------------------------
-- A column would be a stored copy of a number the ledger already determines,
-- and nothing would reconcile the two except recomputing from the ledger — which
-- is the read the column was meant to avoid. Money that can disagree with its
-- own ledger is worse than money that takes a join. Migration 0027 refused to
-- store basket service ids a second time for the same reason, and DECISIONS #64
-- is what a second opinion about a deposit actually costs. A view is derived by
-- construction: it cannot drift, and there is no backfill because there is
-- nothing to fill.
--
-- WHAT IS IN THE DEFINITION, AND WHY EACH PREDICATE IS HERE RATHER THAN IN FOUR
-- CALLERS
-- ---------------------------------------------------------------------------
--   `kind IN ('charge','shop')` — the two kinds that are revenue. NOT `topup`
--       (the customer loading her own wallet is a liability, not a sale), NOT
--       `deposit_hold` (escrow, which settles later as part of the charge and
--       would bill the same service twice), NOT `deposit_return` (money going
--       BACK to her — and this is the predicate that also fixes a second defect:
--       `best-selling-services` joined a no-show booking to its `deposit_return`,
--       whose `amount_fils` is POSITIVE, so `sum(-amount_fils)` printed NEGATIVE
--       revenue for it. Out of the view, it contributes 0, which is what that
--       aggregate's own comment always claimed happened), NOT `adjustment` (the
--       void mechanism itself).
--   `status = 'settled'` — nothing unsettled has earned anything.
--   the `deposit_held`/`debit` leg — read from the LEDGER, already net of any
--       remainder handed straight back at charge time (services/charge.ts § 7a
--       writes the remainder as its own `deposit_return` transaction, so a charge
--       carries at most one apply leg). `sum()` rather than a `LIMIT 1` row:
--       nothing in the schema makes that leg unique per transaction, and the sum
--       is right whether there is one or two while a `LIMIT 1` silently keeps
--       whichever the planner reached first.
--
-- WHAT IS DELIBERATELY *NOT* IN IT: the void exclusion. A report must not count
-- money that has been handed back, but the void handler itself has to read the
-- charge it is about to reverse. So `NOT EXISTS (… reverses_transaction_id …)`
-- stays at the four call sites, where it means something different in each.
--
-- `security_invoker = true`: the view is owned by the migration role, and
-- without this it would read `transaction` and `ledger_entry` with the OWNER's
-- privileges. `avo_app` holds SELECT on both today, so nothing changes now — but
-- a view is a permanent hole in any REVOKE somebody writes later, and this
-- product has one append-only REVOKE on `ledger_entry` already.
--
-- COST, STATED: `ALTER TABLE transaction DROP COLUMN amount_fils` (or the same
-- on `ledger_entry.amount_fils`/`account`/`direction`) now fails until this view
-- is dropped and recreated. Adding columns is unaffected.
--
-- GRANTS: 0001's `ALTER DEFAULT PRIVILEGES … ON TABLES` covers views as well as
-- tables, so `avo_app` already has SELECT. Named anyway, idempotently, so the
-- privilege is legible from this file alone — 0040's precedent.
-- ---------------------------------------------------------------------------
CREATE VIEW transaction_revenue WITH (security_invoker = true) AS
SELECT t.id                                                        AS transaction_id,
       t.salon_id                                                  AS salon_id,
       t.branch_id                                                 AS branch_id,
       t.kind                                                      AS kind,
       t.created_at                                                AS created_at,
       -- Non-negative by `transaction_amount_sign_matches_kind`: a `charge` is
       -- <= 0 and a `shop` row is < 0. The negation is VISIBLE rather than an
       -- abs(), so a row whose sign was wrong for some other reason surfaces
       -- instead of being laundered — services/reports.ts § THE SIGN CONVENTION.
       (-t.amount_fils)::bigint                                    AS charged_fils,
       coalesce(d.applied_fils, 0)::bigint                         AS deposit_applied_fils,
       ((-t.amount_fils) + coalesce(d.applied_fils, 0))::bigint     AS earned_fils
  FROM "transaction" t
  LEFT JOIN (
        SELECT le.transaction_id,
               sum(le.amount_fils)::bigint AS applied_fils
          FROM ledger_entry le
         WHERE le.account = 'deposit_held'
           AND le.direction = 'debit'
         GROUP BY le.transaction_id
       ) d ON d.transaction_id = t.id
 WHERE t.kind IN ('charge', 'shop')
   AND t.status = 'settled';
--> statement-breakpoint
GRANT SELECT ON transaction_revenue TO avo_app;
