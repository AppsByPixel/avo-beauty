---
name: perms-check
description: Verify every permission-gated endpoint is enforced server-side and covered by a test that calls it directly with the permission off. Use when adding or changing an endpoint that reads perms, when wiring the Accounts → Team authority chips, before merging a lane, and as part of go-live prep. Catches endpoints gated only in the UI, void granted without charges, and PIN scopes reaching dashboard endpoints.
---

# perms-check

Non-negotiable #7: **the UI hiding a button is a courtesy, not a control.** A staff phone
is a shared device in a salon; a scanner with `charges: false` that merely hides the
button is one devtools call away from reading the day's takings.

The test that matters is the one that calls the endpoint **directly** with the permission
off. A test that drives the UI proves nothing about the server.

## The nine permissions

From `packages/types/src/entities.ts` → `StaffPermsSchema`:

| Permission | Gates |
|---|---|
| `dashboard` | merchant dashboard access at all |
| `appointments` | the bookings section |
| `shop` | the catalogue editor |
| `loyalty` | the tier / stamp rules editor |
| `team` | the team + hours editor, and granting permissions |
| `scanner` | scan and charge |
| `charges` | Today's charges on the scanner — **senior** |
| `void` | reverse a charge within 15 minutes — **implies `charges`** |
| `marketing` | submit a campaign for AVO approval — *not* send it |

Plus the owner console's per-section admin permissions: `analytics`, `activity`,
`reports`, `salons`, `accounts`, `admins`, `approvals`, `billing`, `audit`, `controls`.

## Procedure

### 1 · Enumerate what should be gated

```bash
grep -rnE "perms\.|requirePerm|StaffPerms" api/src --include='*.ts'
grep -rnE "app\.(get|post|patch|put|delete)\(" api/src --include='*.ts'
```

Build the list of endpoints and the permission each should require. Anything money-moving
or authority-changing needs one. Cross-check against `design/api-contract.md`
§ StaffUser and the operations table.

### 2 · Confirm enforcement is server-side

For each gated endpoint, the check must run **in the handler, before any work**, reading
the permission from the authenticated session — not from the request body, a header, or a
client-supplied role.

Flag as a defect:

- a permission read from `req.body` or a query parameter,
- a check that happens after the effect,
- an endpoint gated only by not being linked in the UI,
- a staff PIN session reaching a `dashboard`-scoped endpoint. A PIN is not a password: it
  must not reach dashboard scopes at all.

### 3 · Confirm the dependent pair

`void` without `charges` is meaningless. Verify:

- granting `void` while `charges` is false is either rejected or auto-grants `charges`,
- `POST /voids` checks **both**,
- revoking `charges` also revokes `void`.

### 4 · Confirm a direct-call test exists

For every gated endpoint there must be a test that:

1. authenticates as a principal with that permission **off**,
2. calls the endpoint directly — not through a UI driver,
3. asserts **403**,
4. asserts **no side effect** — nothing written, no audit row implying success.

```bash
grep -rn "403" --include='*.test.ts' .
```

The mock has a ready-made restricted principal: `x-avo-scenario: noperms` returns Hessa,
who has `scanner: true, charges: false, void: false`. Lane A's real API should have an
equivalent fixture.

### 5 · Confirm the change is audited

Every grant and revoke writes an audit row — who changed what, for whom, when. A
permission change that leaves no trace is a defect in its own right.

Also confirm the scanner **re-reads** `GET /staff/me` after a change, and that a stale
client cannot act on a revoked permission — the server rejects regardless.

## Report

```
DEFECT  api/src/charges.ts:12
  GET /charges has no server-side check. The scanner hides the button when
  perms.charges is false, but the endpoint answers anyone with a valid
  staff session.
  Fix: require perms.charges in the handler; return 403.

GAP     api/src/voids.ts
  POST /voids checks perms.void but not perms.charges. A principal with
  void:true and charges:false can reverse a charge it cannot see.

MISSING test — POST /voids with perms.void off
  No direct-call test. Add one asserting 403 and that the transaction is
  unchanged.
```

End with a coverage line: how many gated endpoints found, how many enforced, how many
have a direct-call test. Those three numbers should be equal, and the gap is the work.

## Reference

- `CLAUDE.md` — non-negotiable #7
- `design/api-contract.md` § StaffUser
- `design/go-live-checklist.md` § Security — "every permission enforced server-side and
  covered by a test that calls the endpoint directly with the permission off"
