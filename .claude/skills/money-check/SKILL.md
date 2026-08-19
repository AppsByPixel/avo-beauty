---
name: money-check
description: Audit code that touches money, balances, charges, top-ups, refunds, commission or loyalty bonuses against the AVO non-negotiables. Use before committing anything under api/, before merging a lane into dev, and whenever a diff touches balanceFils, amountFils, a ledger, a charge, a top-up, a void, or a deposit. Catches floats reaching money, missing idempotency keys, non-atomic charge paths, client-side balance mutation, and money columns typed as anything but bigint.
---

# money-check

Money bugs in this product are not recoverable by a patch — a customer's balance is
already wrong and a salon has already taken a payment. This runs on the diff, not the
whole repo, and every finding is a defect rather than a suggestion.

## Scope

**FIRST, stage intent — or this whole skill audits nothing.** `git diff` does **not** show
untracked files, and a new slice is usually mostly new files. A lane ran this skill over a
three-new-file slice, every grep below came back clean, and the audit had inspected an **empty
diff**:

```bash
git add -N .                 # intent-to-add: makes new files visible to `git diff`
git diff --name-only         # <- confirm this is NOT empty before trusting anything below
git diff --stat              # and that the line counts match the slice you think you audited
```

**If `--name-only` prints nothing, you have not audited anything.** Stop and work out why before
reporting "no findings" — that is a pass bought by looking at the wrong thing, which is the same
defect class as a green typecheck bought with a cast. Every grep in this file inherits this
problem, so fixing it here fixes it once.

Then run against the working diff:

```bash
git diff
```

If the user named a path or branch, use that instead. Only report on lines the diff
touches unless asked for a full sweep.

## What to look for

### 1 · A float reaching money (non-negotiable #1)

Money is `Fils` from `@avo/types` — a branded integer. Format to 3 decimals only at the
display boundary.

Scope this to money-bearing code. `packages/tokens` does legitimate floating-point maths
for contrast ratios and lightness — it never touches money, and including it buries the
real hits:

```bash
git diff -U0 -- api apps packages/types ':!*.test.ts' \
  | grep -E '^\+' \
  | grep -nE 'toFixed|parseFloat|Number\(|\* *0\.|/ *100|/ *1000|Math\.(round|floor|ceil)'
```

Judge each hit — these are signals, not verdicts:

- **Defect:** `amountFils * 0.025` for commission. Use `commissionFor()`.
- **Defect:** `balance / 1000` to get KWD anywhere except a formatter. Use `formatFils()`.
- **Defect:** `parseFloat(input)` on an amount. Use `parseKwdInput()`.
- **Defect:** `toFixed(3)` building a money string by hand. Use `formatMoney()`.
- **Fine:** `Math.round` *inside* `percentOf`, which is the one place rounding is decided.

`packages/types/src/money.ts` is the sanctioned home for money arithmetic and the display
boundary — `percentOf`, `formatFils` and `parseKwdInput` all legitimately divide and
round there. Hits **inside that file** are expected. A hit anywhere else is the finding:
it means someone reimplemented money maths instead of importing it. `rules.ts` does
minute arithmetic on clock times, which is not money either.

Also flag money typed as bare `number` where `Fils` is available:

```bash
git diff -U0 | grep -E '^\+' | grep -nE '(balance|amount|price|deposit|fee|bonus|credit|total|shortfall)[A-Za-z]*\s*:\s*number'
```

A field named `*Fils` typed `number` in a **schema** is expected — zod cannot carry the
brand. Anywhere else, it should be `Fils`.

### 2 · Money in the database as anything but bigint

```bash
git diff -U0 -- '*.sql' 'api/**' | grep -E '^\+' | grep -inE 'real|double|float|numeric|decimal|money'
```

Every money column is `bigint` fils. `numeric` is still wrong — it invites arithmetic in
the query layer that no longer round-trips through `Fils`.

Also confirm new money columns carry their constraint. A balance must be unable to go
negative **at the database level**, not in application code:

```sql
balance_fils bigint NOT NULL DEFAULT 0 CHECK (balance_fils >= 0)
```

### 3 · A money-moving POST without an idempotency key (#4)

Top-ups, charges, orders and voids all need one.

```bash
git diff -U0 | grep -E '^\+' | grep -nE "post\(['\"]/(topups|charges|orders|voids)"
```

For each, verify the handler:

- reads an `Idempotency-Key` header and **rejects the request without one**,
- looks the key up before doing any work,
- returns the stored result on a replay rather than re-executing,
- stores the key in the **same transaction** as the effect. A key written afterwards
  leaves a window where a retry double-charges.

### 4 · `POST /charges` not being one transaction (#3)

The charge does six things: consume the token, apply any held deposit, debit the wallet,
increment visits or stamps, evaluate the tier climb, queue the receipt. Partial
application is not acceptable.

Read the whole handler. Flag:

- any `await` on an external service **inside** the transaction — a WhatsApp or email
  send belongs on a queue, and a failed send must never roll back a charge,
- a balance read outside the transaction that is then written inside it, without
  `SELECT … FOR UPDATE` or an equivalent lock,
- a loyalty increment, receipt enqueue or audit write that could survive a failed debit,
- an early `return` between steps.

The failure case has its own requirement: if the debit fails, **nothing else happened**,
and the response carries the exact shortfall.

### 5 · A client deciding something the server owns (#2)

```bash
git diff -U0 -- 'apps/**' | grep -E '^\+' | grep -nE 'balance\s*[-+]?=|setBalance|creditFils|mintToken|isLive|happyHour'
```

Clients never add credit locally, never mint a QR token, and never decide whether a happy
hour is live **for the purpose of a charge**. A client may render a countdown from
`isHappyHourLive()`; it may not send the result to the server as an input to a charge.

Balance after a top-up comes from a server read, never from adding `creditFils` locally.

### 6 · Refunds leaving the wallet (#5)

```bash
git diff -U0 | grep -E '^\+' | grep -inE 'refund|reversal|chargeback|payout|withdraw'
```

Every refund path — deposit auto-return, the 15-minute void, merchant reimbursement —
lands as wallet credit. No cash, no card reversal, on any surface.

### 7 · Commission shown to a customer

`feeFils` is merchant-visible and customer-never. Flag any render of a fee, commission or
gateway cost inside `apps/wallet/`.

## Report

Group by severity. For each finding give the file and line, the rule number, what breaks,
and the fix.

```
DEFECT  api/src/topups.ts:44  (#1)
  Commission computed as `amount * 0.025 + 50` — floating point on money.
  Fix: commissionFor(amount, method) from @avo/types.

DEFECT  api/src/charges.ts:81  (#3)
  WhatsApp send awaited inside the charge transaction. A gateway timeout
  rolls back a completed charge.
  Fix: enqueue after commit.
```

If nothing is found, say so plainly and name what you checked. Do not invent findings to
look thorough — a false positive on this skill costs more than it saves, because the next
person starts skimming the output.

## Reference

- `CLAUDE.md` — the twelve non-negotiables
- `design/api-contract.md` § Charging, § Commission
- `packages/types/src/money.ts` — the only money arithmetic in the codebase
