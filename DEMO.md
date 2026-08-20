# Running the demo

Verified working 2026-08-20 19:25 PKT on `dev`. Two processes, one database.

```bash
docker start avo-postgres            # if not already up

export DATABASE_URL="postgres://avo:avo_dev_password@localhost:5433/avo"
export APP_DATABASE_URL="postgres://avo_app:avo_app_dev_password@localhost:5433/avo"

pnpm --filter @avo/api run db:migrate
pnpm --filter @avo/api run db:seed    # prints every credential below

cd api && PORT=4000 pnpm run start    # API on :4000
cd apps/dashboard && pnpm run dev     # dashboard on :5173
```

## Credentials the seed prints

| Surface | Sign in with |
|---|---|
| Merchant dashboard | workspace `SAL-AMARA`, username `noura`, `noura-dev-password` |
| Owner console | username `yousef`, `yousef-dev-password` (every section) |
| Owner console — analyst | `mariam.k` / `yousef-dev-password` (no approvals, no policies) |
| Scanner PIN | `noura` 2468, `hessa` 1357, device `DEV-SCANNER-01` |
| Wallet member | `8843` / `dana-dev-password` |

**The workspace field is a departure from the drawn design**, forced by `staff_user` being
unique on `(salon_id, handle)`. Queued for Aftab as #7 — mention it before someone asks.

## What demos well, and why each is worth showing

- **Reports** (`/reports`) — the newest screen. Four cards, branch and period segments, CSV
  export. The two lower cards **skeleton their money as bars, never `0.000`**, which is the
  states rule visible on screen.
- **Overview** — the "Upcoming today" tile counts in the **salon's** timezone, not the host's
  (this machine runs PKT, two hours ahead of Kuwait).
- **Audit log** — filters compose, and a filtered empty state **names what it filtered**;
  "no entries" against an invisible filter would read as *nothing ever happened*.
- **Permission gating** — sign in as `mariam.k` and console sections refuse **in place**,
  rendering the server's own sentence. Refused cards keep their titles, because a vanished
  card reads as *does not exist* rather than *not allowed*.
- **Owner console** (`/console/...`) — Admins, Approvals, Policies, Analytics, Controls, Audit.

## What is NOT in the demo, and should be said out loud

- **No real money.** MyFatoorah is the confirmed PSP; the gateway driver is `sandbox`.
- **Receipts do not send.** Worker, queue and retry all exist behind a `logging` driver;
  real sending needs WhatsApp template approval and a transactional email domain — both
  client-owned.
- **No charge from a real QR on real hardware.** The simulator has no camera.
- **The wallet and scanner are Expo apps** — not part of this two-process web demo.
