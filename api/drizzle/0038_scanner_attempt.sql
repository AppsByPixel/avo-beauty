-- ===========================================================================
-- 0038 — a budget for the till: POST /scans, POST /charges, POST /voids
--
-- The three scanner endpoints that read a customer's card or move her money had
-- no rate limit of any kind, and there is no global limiter to fall back on:
-- `api/src/app.ts` registers no rate-limit plugin and `api/package.json` carries
-- no such package. Auth is limited (0026, 0034), the support queue is limited,
-- the customer directory is limited. The money was not.
--
-- WHY A TABLE, AND NOT AN IN-PROCESS COUNTER
-- -----------------------------------------
-- Migration 0026's answer, unchanged: a counter in one Node process is a limit
-- per replica that resets on every deploy, so the real ceiling is N times what
-- the number says and it disappears exactly during a rolling restart.
--
-- WHY A NEW TABLE AND NOT AN EXISTING ONE
-- ---------------------------------------
-- Two of the four limiters already here count rows that exist for their own
-- reasons — `services/supportLimit.ts` counts `support_ticket`, and
-- `services/memberSearch.ts` counts `audit_log` — and both say why that is right:
-- the thing being rationed IS the row. Neither works here.
--
--   `transaction` only gets a row when a charge SUCCEEDS. A 402, a 410 on a dead
--   token, a rolled-back near-duplicate — none of them writes anything, and a
--   flood of refusals is precisely the traffic worth bounding.
--
--   `audit_log` is merchant-facing. `POST /scans` writes no audit row at all, and
--   filling that table with one row per QR read would train the people who read
--   it to skim — the separation 0026 already drew for `signup_attempt`.
--
--   `pin_attempt` counts FAILED sign-ins only, deliberately (routes/auth.ts writes
--   `succeeded`), so it is silent about everything that happens after sign-in.
--
-- So this is the third member of the `pin_attempt` / `signup_attempt` family:
-- a counter table, keyed on the credential rather than on the connection.
--
-- KEYED ON (salon_id, device_id), NEVER ON `req.ip`
-- ------------------------------------------------
-- A salon is one NAT. Every tablet, phone and back-office browser in the building
-- leaves through one address, so an IP-keyed budget at a salon is a salon-wide
-- budget that the busiest till spends on behalf of the others. And `req.ip` is not
-- even reliably the caller: `app.ts` sets `trustProxy: env.trustProxy`, which is
-- OFF until `TRUST_PROXY` names the real proxy, so today `req.ip` behind a load
-- balancer is the balancer.
--
-- The device is the right key because on this surface it is part of the
-- CREDENTIAL, not telemetry: a staff PIN is scoped to device+salon, and
-- `session_scanner_is_device_scoped` (migration 0028) refuses a scanner session
-- with no device id. `pin_attempt` already indexes exactly this pair for exactly
-- this reason, one table up in `db/schema/session.ts`.
--
-- NOT KEYED ON THE STAFF MEMBER, and that is a deliberate difference from
-- `services/memberSearch.ts`, which keys its ceiling on `audit_log.actor_id`
-- precisely so re-authenticating cannot reset it. The thing being protected there
-- is the customer directory — a disclosure, attributable to a person. The thing
-- being protected here is a till: a physical position with a queue in front of it,
-- where three staff members share one tablet across a shift and any one of them
-- may legitimately be the one holding it. Keying on the person would give one
-- tablet three budgets and would refuse a receptionist who moved to the second
-- till, which is the opposite of what the shape of the work asks for.
--
-- WHAT IS AND IS NOT RECORDED
-- ---------------------------
-- The salon, the device, which of the three endpoints, and the time. NO MEMBER ID,
-- no token, no amount. The limit is keyed on the till, so the customer is not
-- needed to enforce it, and a table recording which customers were scanned would
-- be a second copy of the counter's traffic sitting outside `audit_log` and
-- outside its retention rules. `audit_log` already answers "who was charged".
--
-- AND NOT WHETHER IT WORKED, for 0026's reason, which applies here with more
-- force. The row is written BEFORE the work — a burst of simultaneous requests
-- that all read a count of zero and all proceed is a thundering herd straight
-- through the limiter — so at insert time the outcome is not known. Recording it
-- later would need an UPDATE, which the privileges below refuse.
--
-- The consequence, stated rather than left to be discovered: a request refused
-- after this row is written has still spent budget. Over-counting in that
-- direction is correct. A refused scan LEARNED something — whether that QR
-- resolves in this salon — and a refused charge learned whether a balance covers
-- a basket. Both are exactly what a limiter on this surface is for.
--
-- `action` HAS A CHECK AND NOT AN ENUM. The three values are a closed set and a
-- CHECK says so, but a pgEnum would put a type in the schema whose only consumer
-- is one `count(*)`; `topup_status` is an enum because the state machine's
-- transitions are enforced against it, and nothing here is.
--
-- Idempotent and safe to re-run.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS scanner_attempt (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id    text NOT NULL REFERENCES salon(id) ON DELETE restrict,
  -- Nullable, and it should be unreachable in production: every principal that
  -- can reach these three endpoints holds a `scanner` session, and
  -- `session_scanner_is_device_scoped` refuses one without a device. It is
  -- nullable anyway for the reason `signup_attempt.ip_address` is — a caller the
  -- server cannot attribute must still be COUNTED rather than exempted, and every
  -- such caller shares this one bucket, so being unattributable is not a way past
  -- the limit. Today the only producer is an `AVO_TEST_PRINCIPALS` build, which
  -- has no session row to read a device from.
  device_id   text,
  action      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT scanner_attempt_action_known
    CHECK (action IN ('scan', 'charge', 'void'))
);

-- The limiter's only query: two counts over one window for one till. Mirrors
-- `pin_attempt_device_idx`, which indexes the same pair for the same reason.
CREATE INDEX IF NOT EXISTS scanner_attempt_device_idx
  ON scanner_attempt (salon_id, device_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Privileges. INSERT and SELECT, and nothing else — 0026's rule and its reason:
-- a row the application can UPDATE or DELETE is a counter that can be reset by
-- whatever gets compromised next, and a limiter whose own rows the application
-- can remove is not a limit. Retention is an operator's job, with the owner role.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON scanner_attempt TO avo_app;
REVOKE UPDATE, DELETE ON scanner_attempt FROM avo_app;
