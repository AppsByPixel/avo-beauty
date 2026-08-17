-- ===========================================================================
-- 0016 - a branch can be closed, and closing one is not a DELETE
--
-- build-plan.md phase 4: "an owner can configure a salon end to end without an
-- engineer". A salon that opens a second location, or shuts one, could not be
-- told about it by anybody without database access.
--
-- WHY `closed_at` AND NOT `DROP ROW`
--
-- Both `transaction.branch_id` and `booking.branch_id` are NOT NULL and
-- `ON DELETE restrict`. A hard delete of any branch that has ever taken money is
-- therefore refused by the database as a foreign-key violation, which reaches
-- the merchant as a 500 — the same shape of defect as the fractional deposit
-- fixed alongside this. And the refusal is RIGHT: per-branch revenue, a
-- customer's receipt and an appointment history all name the branch, and the
-- record of where money moved must outlive the merchant's interest in operating
-- there. This is the rule `happy_hour` already states in
-- routes/platform.ts — "the receipts refer to it. Switch it off instead."
--
-- So a close is a state, and every historic row keeps pointing at a branch that
-- still exists and still has a name to render.
--
-- WHAT A CLOSED BRANCH IS EXCLUDED FROM, and where that is enforced:
--
--   - `services/branch.ts § resolveBranch` — a closed branch is never chosen to
--     attribute a NEW charge, top-up or booking to. This is the load-bearing
--     one: without it a closed branch keeps collecting money.
--   - `routes/platform.ts § branchIdsOf` — a new happy hour or boost cannot be
--     scoped to it.
--   - `GET /salons/{id}` § branches — the Settings list and the dashboard's
--     branch pickers.
--
-- The partial index is what makes "the last open branch" a cheap question.
-- `resolveBranch` asks it on every money path, and a salon with no open branch
-- can take no money at all, which is why the route refuses to close the last
-- one rather than discovering it at the next charge.
-- ===========================================================================

ALTER TABLE branch ADD COLUMN closed_at timestamptz;

CREATE INDEX branch_salon_open_idx ON branch (salon_id) WHERE closed_at IS NULL;

-- `branch_salon_name_uq` is unchanged and still spans closed branches. Reusing a
-- closed branch's name for a new one would make two rows indistinguishable in
-- every historic report that renders a name rather than an id, and the merchant
-- re-opening the same location wants the SAME row back, not a second one with
-- the same label. Re-opening is what clearing `closed_at` is for.

-- GRANTS: none needed. Migration 0001 set ALTER DEFAULT PRIVILEGES for avo_app
-- on this schema, and this adds no table.
