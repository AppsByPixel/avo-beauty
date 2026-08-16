---
name: states-check
description: Verify a screen has its loading, empty, error and offline states built to the AVO rules before calling it done. Use when finishing any screen in apps/wallet or apps/dashboard, when reviewing a lane's diff, and during go-live prep. Catches missing skeletons, a rendered 0.000 balance, a QR left visible offline, blanked screens on a failed refresh, and empty states that name nothing.
---

# states-check

A screen without its four states is not done — `CLAUDE.md`, and `go-live-checklist.md`
§ Product completeness. These are not error handling bolted on afterwards; they are part
of the screen.

Take the screen name or file path from the user. If none is given, work from the diff.

## The four states

### Loading

- Skeletons that **match the real layout's shape**. Never a centred spinner on a full page.
- **Money fields skeleton as a bar.** Never render `0.000` before data arrives — a
  customer seeing a zero balance for 200ms will call the salon. This is the single most
  common failure here; check it specifically.

```bash
grep -rnE '0\.000|balanceFils \|\| 0|\?\? 0' apps/ --include='*.tsx'
```

Every hit needs justification. A real zero balance is fine; a zero *placeholder* is not.

- Verify against the mock: `x-avo-scenario: loading` delays 3s, which is long enough to
  actually look at.

### Empty

- Every empty state **names the thing** and offers the one action that fills it.
- **No illustrations.**
- Different causes get different copy. The designed example is Appointments: *nothing
  booked yet* vs *the Booking module is switched off* — never the same words. If a screen
  has two ways of being empty, it needs two empty states.
- Check `x-avo-scenario: empty`, and the combinations: `empty,stamps` is a brand-new
  member at a stamps salon, which is a different card from an empty tiers member.

### Error

- Distinguish **we failed** (offer retry) from **you can't do that** (explain, no retry).
  A 403 with a Retry button is a defect.
- **Stale, not blank.** When a refresh fails, keep the previous figures on screen behind a
  timestamped banner. Never blank a screen someone is reading.
- Error copy explains what went wrong and what to do. No apologies, no "Oops".
- Check `x-avo-scenario: error`.

### Offline

- The wallet card **stays visible** with the last-known balance and a clear "last updated"
  stamp.
- **The QR must be hidden.** A stale token fails at the counter, and that failure looks
  like the salon's fault. This is the highest-consequence rule in this file.

```bash
grep -rn "offline" apps/wallet/src --include='*.tsx' -l
```

For any screen rendering the QR, confirm the offline branch hides it rather than dimming
or disabling it.

- Check `x-avo-scenario: offline` (503).

## Also verify, per screen

**Reduced motion removes, it does not shorten** (`interaction-spec.md` §3):

- Scanner line → **removed entirely**, replaced with a static frame and "Point at the
  customer's code". A looping line is the exact motion that triggers people.
- Pending dots → static "Waiting for the bank…".
- Sheets → cross-fade in place instead of sliding.
- Never remove a *state change*, only the animation carrying it.

```bash
grep -rn "prefers-reduced-motion" apps/ packages/ui/
```

**Tap targets ≥ 44px** on mobile surfaces. **Focus rings** on web via `:focus-visible`,
never `:focus`, and never `outline: none` without a replacement.

**Money accessibility:** `18.000` needs an `aria-label` so it reads as "eighteen point
zero zero zero Kuwaiti dinars", not "eighteen thousand". Use `moneyAriaLabel()`.

**Status pills** carry meaning as text, not colour alone.

## Report

Go state by state for the named screen:

```
Home · loading    ✓ skeleton matches layout, balance skeletons as a bar
Home · empty      ✗ new member renders "0.000" for 200ms before data lands
                    apps/wallet/src/screens/Home.tsx:34
Home · error      ✓ stale-not-blank with timestamp
Home · offline    ✗ QR still rendered — a stale token fails at the counter
                    apps/wallet/src/components/WalletCard.tsx:78
Reduced motion    ✓
Tap targets       ✓
```

A screen with any ✗ is not done. Say that plainly rather than softening it.

## Reference

- `design/AVO States.dc.html` — the designed states, side by side
- `design/interaction-spec.md` §3 motion, §4 empty/loading/error
- `packages/mock/src/server.ts` — the scenario list and how to combine them
