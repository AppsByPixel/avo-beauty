-- ===========================================================================
-- 0031 — a charge records WHAT it was for, so a near-duplicate is answerable
--
-- DECISIONS.md § "Five calls made without asking", item 3, decided and until now
-- not implemented:
--
--   "Near-duplicate charge: refuse, name the prior charge, require an explicit
--    confirm. A second charge for the same member and the same basket inside 120
--    seconds answers `possible_duplicate` carrying the earlier transaction, and
--    proceeds only with an explicit confirm flag. A flag-after-the-fact cannot
--    work — the triggering condition is a response the client could not read."
--
-- THE OBSTACLE WAS THAT A CHARGE DID NOT RECORD ITS BASKET ANYWHERE QUERYABLE.
-- `transaction` holds the total and nothing about what produced it; the service
-- ids live in `audit_log.metadata` and in the receipt payload. Neither is a place
-- to make a money decision from: `audit_log` is the merchant's record of authority
-- and is deliberately a soft-referenced, append-only log, not an index — and
-- reading it to decide whether to take money would make a log load-bearing.
--
-- WHY A HASH AND NOT A `charge_line` TABLE
-- ----------------------------------------
-- `shop_order_line` exists because a cart has QUANTITIES, so `Σ qty × price` is
-- not recoverable from a list of ids. A service basket has no quantities — the
-- scanner builds `serviceIds` from a Set (`MemberScreen.tsx:136`) and duplicates
-- are now refused at the boundary — so the ids plus the priced rows reconstruct
-- the total exactly. What this guard needs is not the lines but an ANSWER to "is
-- this the same basket as a moment ago", which is one equality test.
--
-- A `charge_line` table is still the better long-term shape, for the reason the
-- shop's is: a receipt that names what was charged survives a service being
-- renamed or repriced. That is a bigger change than this guard needs and it is
-- reported rather than smuggled in here.
--
-- THE HASH IS ORDER-INDEPENDENT. `[SV-01, SV-02]` and `[SV-02, SV-01]` are the
-- same basket to a human at a counter, so they must be the same to this guard;
-- the ids are sorted before hashing. Sorting is the whole of the canonicalisation
-- because duplicates cannot occur — the boundary refuses them by name.
--
-- CONSTRAINED TO CHARGES. A `topup` or an `adjustment` has no basket, and a
-- column that could quietly hold one for them would be a column nobody could
-- interpret. `shop` rows are excluded too: an order's contents live in
-- `shop_order_line`, and two answers to "what was this for" is exactly the
-- redundancy 0027 refused to create.
--
-- LOCKING: ADD COLUMN, nullable, no default — catalog-only from PG 11, no
-- rewrite. The index is created on a table whose charge rows are few.
--
-- GRANTS: none needed. `transaction` is already writable by `avo_app`.
--
-- Idempotent and safe to re-run.
-- ===========================================================================

ALTER TABLE transaction ADD COLUMN IF NOT EXISTS basket_hash text;--> statement-breakpoint

ALTER TABLE transaction DROP CONSTRAINT IF EXISTS transaction_basket_hash_is_charge_only;--> statement-breakpoint
ALTER TABLE transaction ADD CONSTRAINT transaction_basket_hash_is_charge_only
  CHECK (basket_hash IS NULL OR kind = 'charge');--> statement-breakpoint

-- THE GUARD'S ONLY QUERY: "has this member been charged for this basket recently".
-- Partial, because only charges carry a hash, and descending on `created_at`
-- because the window is always the recent end.
CREATE INDEX IF NOT EXISTS transaction_member_basket_recent_idx
  ON transaction (member_id, basket_hash, created_at DESC)
  WHERE kind = 'charge' AND basket_hash IS NOT NULL;
