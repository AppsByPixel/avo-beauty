import { useEffect, useRef, useState } from 'react';
import { fils, formatFils, type Salon } from '@avo/types';
import {
  Button,
  Card,
  ErrorState,
  Pill,
  Select,
  Skeleton,
  Stepper,
  TextField,
  Toggle,
  type SelectOption,
} from '@avo/ui';
import { useSalon } from '../api/salon.js';
import {
  useAddBranch,
  useBranchClosurePreview,
  useCloseBranch,
  useUpdateSalon,
  type BranchClosure,
} from '../api/settings.js';
import { useSession } from '../auth/AuthProvider.js';
import { formatReturnWindow } from './noShowWindow.js';
import { SectionError, WriteError } from './sectionState.js';
import { Tills } from './Tills.js';

/**
 * Merchant → Settings.
 *
 * Six panels, in the design's order: optional modules, booking deposit,
 * business hours, branches, and the two receipt channels — WhatsApp, and the
 * email switch the design bundle does not draw. The bundle has one channel row;
 * the API has had two fields for it since decision 88, and a merchant who cannot
 * reach the second one cannot do what Aftab's item 11 asks. See § receipt
 * channels for what the extra row may and may not say.
 *
 * NOT BUILT HERE, DELIBERATELY: the brand kit (logo upload, palette,
 * typography), social links, and Your plan & invoices. The first two are a
 * separate slice; the third has no endpoint of any kind — there is no invoice,
 * plan-price or payment-method shape in the API or in the contract, and the
 * design's figures ("45.000 KD a month plus 3%", "Next invoice 118.500 KD") are
 * prototype fixtures. Rendering them would put invented money on a merchant's
 * billing screen.
 *
 * COMMISSION IS NOT SHOWN HERE, AND IT USED TO BE — DECISION 84.
 *
 * A sixth panel, "AVO commission on top-ups", rendered the KNET and card rates on
 * this screen. It is gone. Aftab: "Hide commissions from the settings (Merchants
 * will not see anything related to commissions)." That REVERSES
 * api-contract.md's "merchant-visible, customer-never" — the contract makes the
 * merchant the one surface that MAY see a fee — so this is a capability being
 * WITHDRAWN by the client, not a defect being fixed, and that contract line is now
 * wrong rather than unimplemented. Trunk owns the contract; this column owns the
 * screen.
 *
 * DO NOT RE-ADD IT FROM THE DESIGN BUNDLE. `AVO Merchant Dashboard.dc.html` still
 * draws the panel, and CLAUDE.md says build the design faithfully — so the next
 * session to diff this screen against the artboard will find a card missing, be
 * right about the difference, and be wrong about the fix. The design predates the
 * instruction.
 *
 * REMOVING IT ALSO CLOSES A DEFECT, which is the useful half of the change. The
 * panel read the COMPILED LAUNCH DEFAULT out of @avo/types, while the rate a
 * top-up is actually priced at is a `platform_settings` row the owner console
 * edits under `controls`. This lane proved the divergence on a real payment: one
 * 20.000 KD card top-up recorded fee 550 at the compiled default and 650 after a
 * PATCH, with the compiled constant unchanged. So the panel showed a merchant a
 * figure that was correct until the owner first moved a stepper and stale
 * afterwards, and it could not do better from this column: the live row is
 * `GET /v1/platform/settings`, gated `controls`, a platform permission no merchant
 * holds. The api/ fix it asked for — serve a salon its own current rates — is no
 * longer owed to this screen, because this screen no longer asks.
 *
 * NOTHING ON THE SERVER NEEDED TO CHANGE. `feeFils` is already withheld from every
 * merchant-facing response and no report carries a fee column
 * (`api/src/routes/activity.ts`, `routes/members.ts` and `routes/topups.ts` each
 * say so in their own words), so this panel was the whole merchant-visible
 * surface. The rate leaving the SHIPPED JAVASCRIPT is a separate question from the
 * card leaving the screen — see the commit for the bundle check.
 */

const DEPOSIT_MIN = 1_000; // 1 KD, and the API's own floor
const DEPOSIT_MAX = 10_000; // 10 KD
const DEPOSIT_STEP = 1_000;

export function Settings() {
  const session = useSession('merchant');
  const salonQuery = useSalon();
  const update = useUpdateSalon();
  const salon = salonQuery.data;

  if (salonQuery.isError) {
    return (
      <SectionError
        error={salonQuery.error}
        forbiddenTitle="You don't have access to settings"
        failedTitle="Couldn't load settings"
        onRetry={() => void salonQuery.refetch()}
        retrying={salonQuery.isFetching}
      />
    );
  }

  /*
   * ==========================================================================
   * THE GATE MOVED FROM THE SCREEN TO THE PANELS, AND A SECOND PERMISSION IS WHY
   * ==========================================================================
   * THE ORIGINAL GATE AND ITS ARGUMENT, KEPT, because it is still exactly right
   * about the five panels it was written for:
   *
   *   `GET /salons/{id}` is guarded by `requirePrincipal` and `requireSameSalon`
   *   and NO permission — deliberately, because the customer wallet reads the
   *   same object for `timezone`, `businessHours` and the loyalty shape. So the
   *   read succeeds for any staff member in the salon, and this screen rendered a
   *   complete, editable Settings editor to a front-desk account with
   *   `perms.dashboard` and `perms.loyalty` both off. Every write from it then
   *   refuses. That is the inverse of the failure `sectionState.tsx` guards
   *   against: not a 403 wearing a Retry button, but NO refusal at all until she
   *   has set a deposit, toggled WhatsApp and pressed save — at which point the
   *   screen tells her the change never happened. Verified with the seeded
   *   front-desk account.
   *
   * WHAT CHANGED IS THAT THE SCREEN NOW HOLDS TWO DIFFERENT AUTHORITIES. Every
   * write the gate was written for — `PATCH /salons/{id}` and all three branch
   * routes — is `requireDashboardPerm(req, 'loyalty')`. The Tills panel's three
   * endpoints are `requirePerm(req, 'either', 'dashboard')`, argued as such in
   * `routes/devices.ts` ("`perms.dashboard` is already the authority over
   * per-branch money truth… a till is not a person").
   *
   * `loyalty` and `dashboard` are orthogonal — nothing implies either from the
   * other — so ONE screen-level gate is now wrong in both directions at once:
   *
   *   a `dashboard`-holding manager without `loyalty` was shown a refusal for the
   *   whole screen, hiding a tills editor the API would have let her use. That is
   *   precisely the error the original comment warned against ("hide the screen
   *   from somebody the API would let save"), arriving through a panel added
   *   later.
   *
   *   a `loyalty`-only account would have been handed the tills editor, whose
   *   every read 403s — the original defect, one panel over.
   *
   * So the gate is per-panel. `Tills` carries its own `perms.dashboard` check and
   * its own refusal; the five `loyalty` panels are gated here, together, because
   * they genuinely share one permission and one endpoint. Non-negotiable #7 is
   * unchanged either way: both servers refuse with both checks deleted. These are
   * courtesies.
   *
   * The copy is still the API's own sentence for `loyalty`, verbatim from
   * `PERMISSION_COPY` — and it is now scoped to the panels it describes, which it
   * was not before: it said "You don't have access to settings" over a screen
   * that also holds tills.
   */
  const canEditSalon = session.perms.loyalty;

  return (
    <div className="settings">
      {canEditSalon ? (
        <>
          <ModulesPanel salon={salon} update={update} />
          <div className="settings__pair">
            <DepositPanel salon={salon} update={update} />
            <BusinessHoursPanel salon={salon} />
          </div>
          {/*
            * `settings__stack` IS BACK, AND THE NOTE THAT REMOVED IT WAS RIGHT.
            *
            * It read: "`settings__stack` IS GONE WITH THE SECOND CARD IT EXISTED TO
            * SPACE. It was a flex column with an 18px gap holding WhatsApp above
            * Commission; with one child it renders identically to the card sitting in
            * the grid cell directly, so keeping it would leave a wrapper whose only
            * reason is a sibling that no longer exists. Its rule is out of app.css
            * too — this was its only user."
            *
            * Every word of that held while there was one card. There are two again —
            * the two receipt channels — so the wrapper has a real second child and the
            * identical rule is restored, unchanged, rather than a new class invented
            * for the same 18px. Kept rather than tidied because the reasoning is the
            * point: a wrapper is justified by its children, and both directions of
            * that decision are now on the record.
            */}
          <div className="settings__pair">
            <BranchesPanel salon={salon} />
            <div className="settings__stack">
              <WhatsAppPanel
                salon={salon}
                busy={update.isPending}
                onChange={(next) => update.mutate({ whatsappEnabled: next })}
              />
              <EmailReceiptsPanel
                salon={salon}
                busy={update.isPending}
                onChange={(next) => update.mutate({ emailEnabled: next })}
              />
            </div>
          </div>
        </>
      ) : (
        <ErrorState
          title="You don't have access to salon settings"
          body="You don't have permission to change loyalty settings. A manager can grant it."
        />
      )}

      {/*
        THE TILLS PANEL SITS BELOW THE SALON PANELS AND OUTSIDE THEIR GATE.
        Its own `perms.dashboard` courtesy check is inside it — see
        `routes/Tills.tsx`, and the argument for both above.
      */}
      <Tills salon={salon} />

      {update.isError ? (
        <WriteError error={update.error} reassurance="That setting is unchanged." />
      ) : null}
    </div>
  );
}

type Updater = ReturnType<typeof useUpdateSalon>;

/* ------------------------------------------------------------------ modules */

/**
 * THESE TOGGLES WERE DISABLED BEHIND A NOTICE, AND THE REASON HAD EXPIRED.
 *
 * The notice read "Booking and Shop can't be switched on from here yet — the
 * workspace has no endpoint for it", above a comment claiming `PATCH
 * /salons/{id}` refuses "`modules`, `moduleBooking` and `moduleShop` alike".
 *
 * ONE THIRD OF THAT WAS RIGHT, AND IT IS WHY THE OTHER TWO THIRDS WERE BELIEVED.
 * The two COLUMN spellings are refused — deliberately and permanently, so that
 * one field does not have two doors — and a verification that reached for
 * `moduleBooking` would have got a real `not_editable` 400. But `modules`, the
 * WIRE shape this screen already READS off the salon, is in `MERCHANT_EDITABLE`
 * (api/src/routes/salons.ts:57) and has been since e883330. Driven against the
 * running API before this change, and asserted in SQL rather than in the reply —
 * the full transcript, including the 403 for a staff member without the
 * permission, is in `api/settings.ts § WHAT THIS ENDPOINT WILL NOT ACCEPT`.
 *
 * ONE SWITCH SENDS ONE KEY. `{ modules: { booking } }`, not the pair: the server
 * only touches a column whose key is present, precisely so that flipping Booking
 * from a render made before someone else changed Shop cannot silently take Shop
 * with it.
 *
 * THE GATE IS `perms.loyalty`, WHICH IS THE GATE THIS WHOLE SCREEN ALREADY HAS.
 * `PATCH /salons/{id}` is one route with one guard, so the courtesy check at the
 * top of `Settings` covers these writes exactly as it covers the deposit and the
 * WhatsApp switch — nothing extra to add here. Non-negotiable #7 unchanged: with
 * that check deleted the server still answers 403 and the columns still do not
 * move, which is the state the transcript above records.
 */
function ModulesPanel({ salon, update }: { salon: Salon | undefined; update: Updater }) {
  return (
    <Card className="settings__card settings__card--rows">
      <h2 className="settings__title avo-display">Optional modules</h2>

      <ModuleRow
        name="Booking"
        body="Service → artist → slot, with a wallet deposit. Default off."
        on={salon?.modules.booking}
        busy={update.isPending}
        onChange={(next) => update.mutate({ modules: { booking: next } })}
      />
      {/*
        "PICKUP OR DELIVERY", AND THE DESIGN SAYS "pickup at salon".
        `AVO Merchant Dashboard.dc.html:1044`, verbatim: "Flat catalog, pay from
        wallet, pickup at salon. Default off." That was a complete description of
        the module when it was drawn and is no longer one — `POST /orders` takes
        `fulfilment: 'delivery'`, and Shop → Orders is the board that fulfils
        them. There is no `modules.delivery`: `SalonSchema.modules` is
        `{ booking, shop }`, so delivery arrives WITH this toggle and nothing
        else gates it. A sentence that tells an owner this switch buys collection
        only is therefore wrong about the switch she is reading it beside.

        Corrected on `Shop.tsx § the design's sentence`'s precedent — the false
        clause replaced, the true ones kept word for word, including "Default
        off." Reported to trunk as a design copy conflict rather than treated as
        settled: the same string is in the owner console's wizard
        (`console/Salons.tsx`) and it is changed there too, so the three places a
        salon is told what Shop does now agree.
      */}
      <ModuleRow
        name="Shop"
        body="Flat catalog, pay from wallet, pickup or delivery. Default off."
        on={salon?.modules.shop}
        busy={update.isPending}
        onChange={(next) => update.mutate({ modules: { shop: next } })}
      />
    </Card>
  );
}

function ModuleRow({
  name,
  body,
  on,
  busy,
  onChange,
}: {
  name: string;
  body: string;
  on: boolean | undefined;
  busy: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="settings__row">
      <div>
        <div className="settings__row-name">{name}</div>
        <div className="settings__row-body">{body}</div>
      </div>
      {on === undefined ? (
        <Skeleton width={40} height={24} radius={999} />
      ) : (
        <div className="settings__row-right">
          {/*
            The state as a word, not only as a switch position — and it follows
            the SERVER's value, never a local one. No optimistic flip: a module
            decides whether a whole surface exists in the customer's wallet, and
            a switch that reads On while the salon is still Off is the same class
            of lie as a stepper showing a deposit nobody accepted. The refusal
            path is `WriteError` at the foot of the screen; the switch simply
            never moved.
          */}
          <Pill tone={on ? 'brand' : 'quiet'}>{on ? 'On' : 'Off'}</Pill>
          <Toggle checked={on} disabled={busy} onChange={onChange} label={`${name} module`} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ deposit */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE NO-SHOW RETURN WINDOW — NEW WORK, AND A LIST RATHER THAN A STEPPER
 * ═══════════════════════════════════════════════════════════════════════════
 * Aftab's item 6: "what if they dont have enough payment (sometimes they dont
 * have money but lock the booking and they dont come) deposit health option for
 * merchants".
 *
 * NEW WORK. THE DESIGN DRAWS NO CONTROL HERE. `AVO Merchant Dashboard
 * .dc.html:1059` is a static strip — `No-show: deposit returns to the wallet
 * <b>1 hour</b> after a missed slot.` — with the hour written into the markup
 * and nothing beside it. The SENTENCE below is the designer's, verbatim and
 * unchanged; the CONTROL is invented. Said plainly so a later reader does not go
 * looking for a dropdown in the bundle.
 *
 * The gap it closes: `noShowReturnMinutes` has been in `MERCHANT_EDITABLE` since
 * the route was written and this panel READ it and only displayed it. A merchant
 * was told a rule about her own customers' money, on a card that changes the
 * deposit immediately above, and given no way to set it.
 *
 * WHAT THIS IS NOT. Forfeiture — the merchant KEEPING the money — is a different
 * thing, is not built, and is escalated. The bundle's own notification copy
 * (`AVO Merchant Dashboard.dc.html:1136`, "Deposit is yours to keep or release.")
 * implies it and contradicts the product description in so many words:
 * `design/AVO-Beauty-Product-Description-v2.md:45` — "automatically returns to
 * their wallet. (Money never leaves the ecosystem; the deposit creates
 * commitment, not punishment.)" Reported as a design copy conflict. No string
 * here may imply otherwise, and none does.
 *
 * ── why a fixed list and not a second Stepper ──────────────────────────────
 * The deposit above is a `Stepper` with a hard 1–10 KD range the DATABASE states
 * (`salon_deposit_range`) and the route re-states. This field has no upper bound
 * anywhere: `parseNoShowReturnMinutes` asks only for "a whole number of minutes
 * greater than zero" and the CHECK is `salon_no_show_return_positive` — `> 0`.
 *
 *   A STEPPER WOULD HAVE TO INVENT `min`, `max` AND `step`, and would then
 *   ENFORCE the invention: `Stepper` clamps (`Math.min(max, Math.max(min, …))`),
 *   so a salon already holding a value outside my range would have it quietly
 *   rewritten the first time anyone touched the control. Those salons exist —
 *   `e2e/tenancy.test.ts:709` sends 999 and calls it valid. One `step` also
 *   cannot serve both ends: 15 makes seven days 672 presses, 60 makes 45 minutes
 *   unreachable.
 *
 *   A BOUNDED TEXT INPUT would need its own parse, its own inline error and its
 *   own refusal path — a second one, beside the screen's — and would still be
 *   inventing the bound, only less visibly. It also makes the merchant think in
 *   minutes while the sentence beneath her reads "1 hour".
 *
 *   A FIXED LIST INVENTS A CHOICE, NOT A BOUND. It does not clamp — an unlisted
 *   value is CARRIED as its own option rather than corrected — and every value it
 *   can produce is enumerable, which is what lets the design's sentence be
 *   checked at all of them instead of argued about. See
 *   `settingsNoShowWindow.test.tsx § the sentence and the option agree`.
 *
 * ── the five, and why the ends are about the till ──────────────────────────
 * THIS NUMBER IS TWO WINDOWS, NOT ONE, and that is the whole argument. Besides
 * deciding when the deposit auto-returns (`booking.no_show_return_due_at =
 * ends_at + n`), `findApplicableHold` reuses it as the EARLY-ARRIVAL GRACE at the
 * till: `starts_at <= now + noShowReturnMinutes` decides which held deposit a
 * charge may consume. So both ends of the range are money at the counter:
 *
 *   TOO SHORT and a customer checked in ten minutes before her slot finds her own
 *   deposit not applicable — she paid, and the till cannot see it. 15 minutes is
 *   the shortest that clears an ordinary check-in lead.
 *   TOO LONG and the grace reaches a DIFFERENT appointment. `findApplicableHold`'s
 *   header describes the failure at length — "A customer with an appointment next
 *   Tuesday who walks in today for a blow-dry must not have Tuesday's deposit
 *   spent on it" — and a large enough window re-opens it by configuration rather
 *   than by code. 4 hours sits inside a salon's own day (morning 10:00–13:00,
 *   evening 16:00–21:00 in the seeded hours), so the grace cannot reach tomorrow.
 *
 * 60 is the anchor: the contract's example, the column default, the seed, the
 * design's rendered "1 hour", and the product description's stated rule ("if the
 * customer doesn't arrive within 1 hour of the slot").
 *
 * ── THE BOUND ITSELF BELONGS ON THE SERVER, AND IS NOT BUILT HERE ──────────
 * This list is what the CONTROL offers. It is not a validation, and it must not
 * be mistaken for one: the endpoint still accepts 1 and still accepts 10080, from
 * the console's `PATCH /v1/platform/salons/{id}` or from curl. That is
 * non-negotiable #7's reasoning applied to a range instead of a permission — a
 * client-side bound is a validation the next client will not have. Reported to
 * trunk for `api/`, described in the handoff, and pinned from the test file so
 * the day a ceiling lands someone re-reads this list.
 */
const RETURN_WINDOW_PRESETS: readonly number[] = [15, 30, 60, 120, 240];

/*
 * THE LABEL ITSELF MOVED OUT — `routes/noShowWindow.ts`.
 *
 * It was exported from here, and that was right while this was the only screen
 * that could state the window. Appointments states the same rule on the board
 * where a merchant acts on a no-show, and a route importing a formatter out of a
 * sibling route would make one screen's copy a library for the other's. One
 * function still, so the select's option labels and BOTH sentences cannot
 * disagree at any value; it simply no longer lives in one of the two callers.
 */

/**
 * The presets, plus the salon's own value when it is not one of them.
 *
 * CARRIED, NOT CLAMPED, AND SORTED INTO PLACE. A salon on 45 minutes sees "45
 * minutes" selected between 30 and 60 and may leave it there; picking a preset is
 * then her decision and not a side effect of the panel rendering. This is the
 * behaviour a `Stepper` could not have had, and the reason the control is a list.
 */
function returnWindowOptions(current: number): SelectOption[] {
  const minutes = RETURN_WINDOW_PRESETS.includes(current)
    ? [...RETURN_WINDOW_PRESETS]
    : [...RETURN_WINDOW_PRESETS, current].sort((a, b) => a - b);
  return minutes.map((m) => ({ value: String(m), label: formatReturnWindow(m) }));
}

export function DepositPanel({ salon, update }: { salon: Salon | undefined; update: Updater }) {
  const serverValue = salon?.depositFils ?? DEPOSIT_MIN;
  const [value, setValue] = useState<number>(serverValue);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /*
   * The server value wins whenever it changes underneath — including after a
   * failed PATCH, which is how the stepper snaps back to what is actually held
   * rather than sitting on a number nobody accepted.
   */
  useEffect(() => setValue(serverValue), [serverValue]);

  /*
   * Debounced, because the stepper is a control a merchant clicks four times to
   * get from 5 to 9 and each click would otherwise be a money write with its own
   * audit row. The last value wins; the request carries the settled figure.
   */
  function onChange(next: number) {
    setValue(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (next !== serverValue) update.mutate({ depositFils: fils(next) });
    }, 550);
  }

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const returnMinutes = salon?.noShowReturnMinutes ?? 60;
  const returnLabel = formatReturnWindow(returnMinutes);

  /*
   * THE VALUE THE SELECT SHOWS WHILE A WRITE IS IN THE AIR, WITHOUT A LOCAL COPY.
   *
   * `useUpdateSalon` writes nothing optimistically, so rendering `returnMinutes`
   * alone would snap the select back under the merchant's hand the instant she
   * picked an option and hold it there until the refetch landed. The stepper
   * above solves that with `useState` + an effect, which it needs anyway for the
   * debounce; a select has no intermediate values to debounce, so it can read the
   * in-flight value off the mutation instead and keep no state of its own. That
   * also removes a failure the stepper's draft has: after a REFUSED patch the
   * server value is unchanged, so an effect keyed on it never re-fires and the
   * draft sits on a number nobody accepted. Here the settled mutation simply
   * stops being pending and the server's value renders again.
   *
   * BOTH HALVES OF THE CONDITION EARN THEIR PLACE, and a third did not.
   *
   * `update` is ONE mutation shared by every panel on this screen, so `isPending`
   * alone is true during a WhatsApp flip too — reading the KEY off `variables` is
   * what keeps another panel's write off this control. And `isPending` is what
   * makes the settled state the server's again, refusal included: `variables`
   * survives a failed mutation, so without it a refused 240 would sit here
   * forever.
   *
   * WHAT IS NOT HERE: an `'noShowReturnMinutes' in update.variables` guard, which
   * this line carried until a mutation proved it inert — deleting it failed
   * nothing, because `?? returnMinutes` already answers for a patch that does not
   * mention the field. A check that cannot fail is not a safeguard, it is a
   * second statement of a rule that lives one line down.
   */
  const pendingWindow = update.isPending ? update.variables?.noShowReturnMinutes : undefined;
  const shownMinutes = pendingWindow ?? returnMinutes;

  return (
    <Card className="settings__card">
      <h2 className="settings__title avo-display">Booking deposit</h2>
      <p className="settings__sub">
        Held from the wallet at confirmation. Remainder paid at the salon.
      </p>

      {salon === undefined ? (
        <>
          <Skeleton width={220} height={38} />
          {/*
            The new row skeletons too, and at its real height — interaction-spec
            §4 asks skeletons to match the layout's shape, and a card that grows
            a 33px row on load is the reflow `Overview.tsx` was corrected for.
          */}
          <div className="settings__window">
            <span className="settings__window-label">Return window</span>
            <Skeleton width={104} height={33} radius={10} />
          </div>
        </>
      ) : (
        <>
          <div className="settings__deposit">
            <Stepper
              label="Booking deposit"
              value={value}
              min={DEPOSIT_MIN}
              max={DEPOSIT_MAX}
              step={DEPOSIT_STEP}
              onChange={onChange}
              // Integer fils in, formatted only here. Never a float.
              format={(v) => formatFils(fils(v))}
              valueText={`${formatFils(fils(value))} Kuwaiti dinars`}
              disabled={update.isPending}
            />
            <span className="settings__deposit-unit">KD</span>
            <span className="settings__deposit-range">1&ndash;10 KD</span>
          </div>

          <div className="settings__window">
            {/*
              THE VISIBLE CAPTION IS A SUBSTRING OF THE ACCESSIBLE NAME, on
              purpose — WCAG 2.5.3 "Label in Name". "Return window" is
              unambiguous inside a card titled Booking deposit and above a
              sentence that starts "No-show:", while a screen reader that has
              neither still hears which window this is.
            */}
            <span className="settings__window-label">Return window</span>
            <Select
              label="No-show return window"
              labelHidden
              size="sm"
              value={String(shownMinutes)}
              options={returnWindowOptions(shownMinutes)}
              disabled={update.isPending}
              /*
               * NOT DEBOUNCED, and the stepper beside it is — the difference is
               * the control, not an inconsistency. A stepper passes through 6, 7
               * and 8 on the way to 9 and each would be its own write; a select
               * emits one settled choice per interaction. Compared against the
               * SERVER's value, so re-picking what the salon already holds is not
               * a write at all.
               */
              onChange={(event) => {
                const next = Number(event.target.value);
                if (next !== returnMinutes) update.mutate({ noShowReturnMinutes: next });
              }}
            />
          </div>
        </>
      )}

      {/*
        THE DESIGN'S SENTENCE, VERBATIM, AND IT FOLLOWS THE SERVER RATHER THAN THE
        CONTROL. While a write is in the air the select shows the merchant's
        choice and this shows the salon's live rule, because the two say different
        things: one is an intent, the other is a claim about what happens to a
        CUSTOMER'S money and must never run ahead of the server. `ModuleRow`'s
        Pill-beside-Toggle carries the same argument. They re-agree the moment the
        write settles, whichever way it settles; a refusal surfaces in the
        screen's own `WriteError`.
      */}
      <div className="settings__foot">
        No-show: deposit returns to the wallet <b>{returnLabel}</b> after a missed slot.
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------- business hours */

function BusinessHoursPanel({ salon }: { salon: Salon | undefined }) {
  const hours = salon?.businessHours;
  return (
    <Card className="settings__card">
      <h2 className="settings__title avo-display">Business hours</h2>
      {hours === undefined ? (
        <Skeleton width="70%" height={16} />
      ) : (
        <>
          <div className="settings__hours-row">
            <span className="settings__hours-label">Morning</span>
            <span className="settings__hours-value">
              {hours.morning[0]} &ndash; {hours.morning[1]}
            </span>
          </div>
          <div className="settings__hours-row settings__hours-row--divided">
            <span className="settings__hours-label">Evening</span>
            <span className="settings__hours-value">
              {hours.evening[0]} &ndash; {hours.evening[1]}
            </span>
          </div>
          <div className="settings__note">Afternoon closure — typical of Kuwait retail.</div>
          {/*
            The zone is not decoration. `businessHours` is naive wall clock; the
            same "10:00" resolves to a different instant per zone, and it is what
            artist windows and happy hours are measured against. Shown so a
            merchant can see which clock the salon runs on.
          */}
          {salon?.timezone ? (
            <div className="settings__note">All times in {salon.timezone}.</div>
          ) : null}
        </>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------------- branches */

/**
 * Branches — the design's list, ✕ per row, and "+ Add branch".
 *
 * CLOSING IS NOT DELETING, AND THE SCREEN SAYS SO. `DELETE
 * /salons/{id}/branches/{bid}` sets `closedAt`; the row survives because
 * `booking.branch_id` and `transaction` reference it. The design's ✕ carries only
 * `title="Remove"`, which would be a lie about what the button does.
 *
 * THE CONSEQUENCES ARE SHOWN BEFORE THE CONFIRMATION, AND THE SERVER COMPUTES
 * THEM. `GET /salons/{id}/branches/{bid}/closure-preview` on `perms.loyalty` —
 * the same permission as the close — answers who gets re-scoped, who is left with
 * no branch at all, how many appointments still hold a deposit (and how many of
 * those had their branch inferred), which tills would be unenrolled, and whether
 * the close would be refused outright. The DELETE's own response is then shown
 * afterwards as a receipt of what actually happened, in the same field names.
 *
 * THIS PANEL USED TO COMPUTE ALL OF THAT ITSELF, and the note that told it to is
 * corrected in `api/settings.ts § useCloseBranch` — the preview route existed at
 * the exact path that note said was missing. Two things came of the replacement,
 * and both are reasons the client-side version could not have stayed:
 *
 * 1. THE WARNING IS NO LONGER PERMISSION-BOUND. Deriving it needed `perms.team`
 *    (`GET /staff`), `perms.appointments` (`GET /salons/{id}/bookings`) and
 *    `perms.dashboard` (`GET /salons/{id}/devices`) — three permissions the person
 *    closing the branch need not hold, since closing it needs only `loyalty`. A
 *    `loyalty`-only account was shown categories of consequence without counts:
 *    honest, and a mitigation rather than a fix. One permission, one answer now.
 *
 * 2. THE TWO ANSWERS DISAGREED, on data a real salon reaches. `GET
 *    /salons/{id}/bookings` is capped at 200 rows ordered `starts_at DESC` and
 *    reports `nextCursor: null`, so past 200 deposit-held bookings this panel's
 *    count silently dropped the ones starting SOONEST. Driven on `avo_lane_c`: the
 *    server said 3 deposits held at Salmiya, this panel computed 0, and the
 *    confirmation read "No appointment here is holding a deposit" over three
 *    customers' money. `api/settings.ts § BranchClosurePreview` carries the
 *    measurement.
 *
 * WHAT A FAILED PREVIEW DOES: IT BLOCKS THE CLOSE. Argued at the render below.
 */
function BranchesPanel({ salon }: { salon: Salon | undefined }) {
  const session = useSession('merchant');
  const addBranch = useAddBranch();
  const closeBranch = useCloseBranch();
  const [newName, setNewName] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [closed, setClosed] = useState<BranchClosure | null>(null);

  /*
   * ONE READ, ON THE SAME PERMISSION AS THE ACT, and only while a confirmation is
   * open — `confirming` is the branch id or null, and the query is disabled on
   * null. Three hooks went with the client-side computation this replaced:
   * `useStaff`, `useSalonBookings('deposit_held')` and `useDevices`, each fetched
   * on a permission the closer might not hold.
   */
  const preview = useBranchClosurePreview(confirming);

  const branches = salon?.branches ?? [];
  const onlyOpenBranch = branches.length <= 1;

  return (
    <Card className="settings__card">
      <h2 className="settings__title avo-display">Branches</h2>
      <p className="settings__sub">
        One wallet across all. Each branch gets an ID you can scope staff to.
      </p>

      {salon === undefined ? (
        <Skeleton width="80%" height={16} />
      ) : (
        <ul className="settings__branches">
          {branches.map((branch) => {
            return (
              <li key={branch.id} className="settings__branch">
                <span className="settings__branch-dot" aria-hidden="true" />
                <span className="settings__branch-name">{branch.name}</span>
                <span className="settings__branch-id">{branch.id}</span>
                {/*
                  The ✕ pattern from Accounts: a control that cannot succeed says
                  why BEFORE it is pressed. The server refuses the last open
                  branch with `last_open_branch` — a salon with none cannot take a
                  payment, a top-up or a booking.
                */}
                <button
                  type="button"
                  className="settings__branch-close"
                  aria-label={`Close ${branch.name}`}
                  title={
                    onlyOpenBranch
                      ? "This is the salon's only open branch. Open the new location first, then close this one."
                      : `Close ${branch.name}`
                  }
                  disabled={onlyOpenBranch || closeBranch.isPending}
                  onClick={() => {
                    setClosed(null);
                    setConfirming(branch.id);
                  }}
                >
                  <span aria-hidden="true">✕</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {confirming !== null
        ? (() => {
            const branch = branches.find((b) => b.id === confirming);
            if (!branch) return null;
            const busy = closeBranch.isPending;
            /*
             * `preview.isError ? undefined : preview.data` — AND NOT JUST
             * `preview.data`, WHICH IS THE BUG THIS LINE EXISTS FOR.
             *
             * TanStack KEEPS the last successful `data` when a refetch fails, so
             * a query can be `isError` and hold `data` at the same time. Driven
             * in a browser against a 500 on the preview: the failure state
             * rendered, the previous answer's consequence list rendered UNDER it,
             * and `impact.closable` was still true — so the Close button was
             * still there, under a heading saying we could not check what closing
             * it would do. Every argument for blocking, defeated by a cache.
             *
             * STALE-NOT-BLANK DOES NOT APPLY HERE, and that is the distinction.
             * `StateBlocks.tsx § StaleBanner` keeps figures visible on a failed
             * refresh because "a merchant who sees the figures vanish assumes the
             * money did too" — true of a balance she is reading. This is not a
             * reading; it is the impact statement for an irreversible cascade she
             * is about to authorise, and the whole reason `staleTime` is 0 on this
             * query is that a 30-second-old answer may already describe a
             * different salon. Showing it beside a failure, with a live button,
             * is worse than showing nothing.
             */
            const impact = preview.isError ? undefined : preview.data;

            return (
              <div
                className="settings__confirm"
                role="group"
                aria-label={`Close ${branch.name}?`}
              >
                <p className="settings__confirm-text">
                  Close <b>{branch.name}</b>? It stops taking payments, top-ups and bookings.
                  Past charges keep its name — it is closed, not deleted.
                </p>

                {/*
                  LOADING. Skeleton lines where the consequences will be, not an
                  empty list and not a spinner replacing the whole sheet: the
                  question is already legible above and the merchant can read it
                  while the impact arrives. What she cannot do is CONFIRM — the
                  Close button is absent until the answer is in, because a
                  confirmation dialog whose consequences are still loading is a
                  dialog that can be dismissed with the primary action before it
                  has said anything. `AVO States.dc.html` § Loading: skeletons in
                  the shape of the content, never a blocking overlay.
                */}
                {preview.isPending ? (
                  <ul className="settings__consequences" aria-busy="true">
                    <li>
                      <Skeleton width="82%" height={14} />
                    </li>
                    <li>
                      <Skeleton width="68%" height={14} />
                    </li>
                    <li>
                      <Skeleton width="74%" height={14} />
                    </li>
                  </ul>
                ) : null}

                {/*
                  FAILURE. THE CLOSE IS BLOCKED, NOT WARNED ABOUT, and this is the
                  one state on this screen worth arguing for at length.

                  Degrading to "we couldn't check — close anyway?" was the other
                  option and it is wrong here, for four reasons that stack:

                  1. THE CLOSE IS ONE-WAY FROM EVERY SURFACE. There is no reopen
                     endpoint — `grep -rn reopen api/src` finds nothing, and
                     `PATCH /salons/{id}/branches/{bid}` accepts `name` and
                     `nameAr` and answers `not_editable` to anything else. So a
                     close decided on unknown impact cannot be undone by the
                     person who decided it.

                  2. IT CASCADES INTO THREE PLACES, one of which takes money.
                     Staff are `array_remove`d, deposits are reported, and tills
                     are REVOKED (DECISIONS.md #91) — a revoked till is a counter
                     that stops charging, and the merchant only learns which ones
                     from this sheet.

                  3. THE PERMISSION ARGUMENT FOR DEGRADING IS GONE. The old
                     client-side warning degraded because it needed `perms.team`,
                     `perms.appointments` and `perms.dashboard`, and a
                     `loyalty`-only closer legitimately lacked them — so "cannot
                     see it" was a normal, permanent state and refusing the close
                     over it would have barred her from her own settings. The
                     preview is on `loyalty` alone. A failure here is no longer
                     "you may not know", it is "we could not find out", which is
                     transient and retryable.

                  4. THIS PANEL'S OWN PRECEDENT. The ✕ on the last open branch is
                     disabled with the reason in its `title` rather than pressed
                     and refused. Saying no before the act is what this file
                     already does.

                  It is a block, not a dead end: `SectionError` renders Try again,
                  and Keep it open stays. The classification is `SectionError`'s
                  rather than ours so that a served 403 or a named state answer
                  reaches the merchant in the server's own words — the 403 branch
                  should be unreachable, since she just passed the same
                  permission to load this screen, and rendering it honestly costs
                  nothing and is not a claim that it cannot happen.
                */}
                {preview.isError ? (
                  <div className="settings__confirm-failed">
                    <SectionError
                      error={preview.error}
                      forbiddenTitle={`You can't check what closing ${branch.name} would do`}
                      failedTitle={`Couldn't check what closing ${branch.name} would do`}
                      onRetry={() => void preview.refetch()}
                      retrying={preview.isFetching}
                    />
                    <p className="settings__confirm-blocked">
                      Closing a branch re-scopes staff, unenrols tills and cannot be undone.
                      It stays available once we can tell you what it would affect.
                    </p>
                  </div>
                ) : null}

                {impact !== undefined ? (
                  <>
                    <ul className="settings__consequences">
                      <li>
                        {impact.staffRescoped.length === 0
                          ? 'No staff are scoped to this branch.'
                          : impact.staffRescoped.length === 1
                            ? `${impact.staffRescoped[0]} loses it from her branch access.`
                            : `${impact.staffRescoped.length} staff lose it from their branch access: ${impact.staffRescoped.join(', ')}.`}
                      </li>

                      {/*
                        `staffLeftWithNoBranch` is the one that needs her
                        attention — a staff member scoped to branches with none
                        left cannot work — so it gets its own line and the warning
                        tone rather than being folded into the count.
                      */}
                      {impact.staffLeftWithNoBranch.length > 0 ? (
                        <li className="settings__consequence--warn">
                          <b>
                            {impact.staffLeftWithNoBranch.join(', ')} would be left with no
                            branch at all
                          </b>{' '}
                          and cannot work until you give{' '}
                          {impact.staffLeftWithNoBranch.length === 1 ? 'her' : 'them'} another
                          one in Accounts → Team.
                        </li>
                      ) : null}

                      {impact.depositHeldBookings > 0 ? (
                        <li className="settings__consequence--warn">
                          <b>
                            {impact.depositHeldBookings} appointment
                            {impact.depositHeldBookings === 1 ? '' : 's'} here still hold
                            {impact.depositHeldBookings === 1 ? 's' : ''} a customer&rsquo;s
                            deposit
                          </b>{' '}
                          — that money is already taken and stays held against the booking.
                          {/*
                            A COUNT, WHERE THIS USED TO BE A BOOLEAN. The client-side
                            version could only say "at least one of those has an
                            assumed branch"; the server reports how many. An artist
                            has no branch column, so part of this total is resolved
                            rather than recorded, and a warning about money already
                            taken from customers must not state a guess as a fact.
                          */}
                          {impact.depositHeldBookingsBranchAssumed > 0
                            ? ` ${impact.depositHeldBookingsBranchAssumed} of those had ${impact.depositHeldBookingsBranchAssumed === 1 ? 'its' : 'their'} branch inferred rather than recorded, so treat the count as approximate.`
                            : ''}
                        </li>
                      ) : (
                        <li>No appointment here is holding a deposit.</li>
                      )}

                      {/*
                        THE TILLS. The one consequence on this list that stops
                        money being taken at all, so it is the one that says so
                        loudest — and `tillsUnenrolled` is the ONLY place the
                        answer comes from. The close revokes these rows; before
                        the field existed a merchant found out which tills a close
                        broke by charging from one and getting a 404.
                      */}
                      {impact.tillsUnenrolled.length > 0 ? (
                        <li className="settings__consequence--warn">
                          <b>
                            {impact.tillsUnenrolled.length === 1
                              ? `${impact.tillsUnenrolled[0]} would be unenrolled and stop taking payments`
                              : `${impact.tillsUnenrolled.length} tills would be unenrolled and stop taking payments: ${impact.tillsUnenrolled.join(', ')}`}
                          </b>{' '}
                          — closing the branch revokes{' '}
                          {impact.tillsUnenrolled.length === 1 ? 'its' : 'their'} enrolment.
                          Set {impact.tillsUnenrolled.length === 1 ? 'it' : 'them'} up again at
                          another branch under Tills below.
                        </li>
                      ) : (
                        <li>No till stands at this branch.</li>
                      )}
                    </ul>

                    {/*
                      THE SERVER'S OWN REFUSAL, IN ITS OWN WORDS. `closable` is
                      false for `last_open_branch` and `already_closed`. The ✕
                      above is already disabled on the first of those from the
                      branch count, but this is the authoritative answer — the
                      client's count is of the list it happens to be holding, and
                      another manager may have closed the other branch a second
                      ago. Where the server says no, no Close button is drawn.
                    */}
                    {impact.closable ? null : (
                      <p className="settings__confirm-blocked" role="alert">
                        {impact.blockedReason === 'already_closed'
                          ? `${branch.name} is already closed.`
                          : "This is the salon's only open branch. A salon with no open branch cannot take a payment, a top-up or a booking — open the new location first, then close this one."}
                      </p>
                    )}
                  </>
                ) : null}

                <div className="settings__confirm-actions">
                  {/*
                    The primary action exists only where the preview answered AND
                    the server says the close would go through. Loading and
                    failure both render Keep it open alone.
                  */}
                  {impact !== undefined && impact.closable ? (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => {
                        closeBranch.mutate(
                          { branchId: branch.id },
                          {
                            onSuccess: (result) => {
                              setConfirming(null);
                              setClosed(result);
                            },
                          },
                        );
                      }}
                    >
                      {busy ? 'Closing…' : `Close ${branch.name}`}
                    </Button>
                  ) : null}
                  <Button variant="quiet" disabled={busy} onClick={() => setConfirming(null)}>
                    Keep it open
                  </Button>
                </div>
              </div>
            );
          })()
        : null}

      {/*
        WHAT THE CLOSE ACTUALLY TOUCHED, read from the UPDATE's own RETURNING.

        STILL NOT A DUPLICATE OF THE WARNING, for a changed reason. It used to be
        the server's numbers against this client's estimate — two sources that
        could disagree, and did. Both now come from the same
        `branchClosureImpact`, in the same field names, which the API chose
        deliberately "so the preview and the outcome are comparable rather than
        merely similar". So this is a receipt: the same four facts, stated in the
        past tense, after the transaction that made them true. A merchant who
        confirmed on a preview and reads something different here has found a real
        race — somebody granted branch access, or enrolled a till, between the two
        calls — and that is worth being able to see rather than smoothing over.

        `tillsUnenrolled` IS ON THE RECEIPT because it is the consequence she has
        to act on: those counters are dead until somebody enrols them somewhere.
      */}
      {closed !== null ? (
        <div className="settings__closed" role="status">
          <b>{closed.name} is closed.</b>{' '}
          {closed.staffRescoped.length > 0
            ? `Re-scoped ${closed.staffRescoped.join(', ')}. `
            : 'No staff needed re-scoping. '}
          {closed.staffLeftWithNoBranch.length > 0
            ? `${closed.staffLeftWithNoBranch.join(', ')} now ${closed.staffLeftWithNoBranch.length === 1 ? 'has' : 'have'} no branch access — fix that in Accounts → Team. `
            : ''}
          {closed.tillsUnenrolled.length > 0
            ? `Unenrolled ${closed.tillsUnenrolled.join(', ')} — set ${closed.tillsUnenrolled.length === 1 ? 'it' : 'them'} up again at another branch under Tills. `
            : ''}
          {closed.depositHeldBookings > 0
            ? `${closed.depositHeldBookings} appointment${closed.depositHeldBookings === 1 ? '' : 's'} still hold a deposit here.`
            : ''}
        </div>
      ) : null}

      <div className="settings__addbranch">
        <TextField
          label="New branch name"
          labelHidden
          placeholder="New branch name"
          value={newName}
          disabled={addBranch.isPending}
          onChange={(event) => setNewName(event.target.value)}
        />
        <Button
          disabled={addBranch.isPending || newName.trim() === ''}
          onClick={() =>
            addBranch.mutate(
              { name: newName.trim() },
              { onSuccess: () => setNewName('') },
            )
          }
        >
          {addBranch.isPending ? 'Adding…' : '+ Add branch'}
        </Button>
      </div>

      {addBranch.isError ? (
        <WriteError error={addBranch.error} reassurance="No branch was added." />
      ) : null}
      {closeBranch.isError ? (
        <WriteError error={closeBranch.error} reassurance="That branch is still open." />
      ) : null}
    </Card>
  );
}

/* --------------------------------------------------------- receipt channels */

/**
 * ===========================================================================
 * THE TWO CHANNELS A RECEIPT CAN GO OUT ON — Aftab's item 11.
 * ===========================================================================
 * "Invoice through emails or WhatsApp, option set by merchant." The server had
 * both halves and this screen exposed one: `emailEnabled` appeared zero times
 * under `apps/dashboard/`, so a merchant could turn WhatsApp off and could not
 * turn email on. 107 `receipt_job` rows on the demo database, every one
 * `whatsapp`. `api/settings.ts § SalonPatch` carries the verification.
 *
 * TWO INDEPENDENT SWITCHES, NEVER A CHOICE BETWEEN THE TWO, and this is the
 * design decision rather than a styling one.
 *
 * The obvious control for "option set by merchant" is a segment — WhatsApp |
 * Email | Both — and it would be a lie. `services/receipts.ts §
 * decideReceiptChannels` does not implement an either/or:
 *
 *   `member.phone` is NOT NULL, so WhatsApp is possible for every customer.
 *   `member.email` is nullable and `email_verified` defaults false, and email is
 *   queued only for `email && emailVerified` — "an unverified address is one the
 *   customer typed, and it might be someone else's. A receipt names what she
 *   bought, what it cost and what her wallet balance is now."
 *
 * So a salon set to email-only STILL SENDS WHATSAPP to every customer who has
 * not verified an address — the server falls back to it and stamps
 * `fallbackReason: 'email_unavailable'` on the row, because a receipt is "a
 * record-keeping obligation, not marketing" (design/README.md § Known gaps 7)
 * and the merchant's preference must not be able to produce silence. A segment
 * reading "Email" would tell her WhatsApp is off for everyone. Two switches
 * state only what is true: each channel is on or off as a PREFERENCE, and the
 * intersection with what is possible for a given customer is the server's.
 *
 * SHE MAY CHOOSE A CHANNEL; SHE MAY NOT CHOOSE SILENCE, AND NOT FROM HERE.
 * Both off is refused twice on the server — `salon_receipt_channel_floor` is a
 * CHECK, and `PATCH /salons/{id}` answers 409 `receipt_channels_required` with a
 * sentence written to be read. This screen does NOT grey the second switch when
 * the first is off. That version is non-negotiable #7 inverted: the UI becomes
 * the control, and it drifts, because it can see `salon.whatsappEnabled` and
 * cannot see whether any member of this salon has a verified address. The flip
 * goes to the server, the server refuses, and `WriteError` at the foot of the
 * screen renders the API's own sentence verbatim.
 *
 * WHAT IS MISSING HERE IS COPY, AND IT IS REPORTED RATHER THAN INVENTED.
 * There is no merchant-facing string anywhere in the design bundle for the
 * fallback above — "WhatsApp receipts still reach customers who have not
 * verified an email address". `AVO Merchant Dashboard.dc.html:1090` draws ONE
 * channel row and no second one; the only wording for the fallback rule anywhere
 * is `api-contract.md:116`, written for an implementer rather than for a
 * merchant. CLAUDE.md § Keep the copy verbatim, so that state has no words and
 * is reported as needing them. What the screen does meanwhile is decline to
 * assert the opposite — hence two switches and no segment.
 *
 * "Email receipts" IS THE BUNDLE'S OWN NAME FOR THE CHANNEL, not a coinage:
 * `AVO Wallet Home.dc.html:1205`, `AVO Receipt Email.html:164` ("Manage email
 * receipts") and `design/README.md`. It is also the precise one — this channel
 * carries receipts and nothing else, while WhatsApp carries "Confirmations ·
 * reminders · receipts". The sub-line under it is the string that does not
 * exist; the wallet's `nReceiptSub` is written to a customer about her own
 * receipts and is a different register from the dot list beside it, so it is not
 * borrowed. The row ships without one.
 *
 * `labelHidden` ON BOTH, AND IT IS A FIX. `Toggle` renders its label visibly
 * unless told not to, so the WhatsApp card has been painting "WhatsApp
 * notifications" twice — once as the row name the design draws, once beside the
 * knob. The design draws it once (`…dc.html:1090` is a name, a sub-line and a
 * bare switch). `labelHidden` keeps the accessible name in the DOM under
 * `.avo-sr-only` — the switch still announces what it does — and stops the
 * duplicate paint. Marketing solved the same duplication with a CSS override;
 * `Toggle` grew the prop afterwards, and this is what it is for.
 */
export interface ChannelPanelProps {
  salon: Salon | undefined;
  /** A write is in flight. Not "this channel may not be changed". */
  busy: boolean;
  onChange: (next: boolean) => void;
}

export function WhatsAppPanel({ salon, busy, onChange }: ChannelPanelProps) {
  return (
    <Card className="settings__card settings__card--inline">
      <div>
        <div className="settings__row-name">WhatsApp notifications</div>
        <div className="settings__row-body">Confirmations · reminders · receipts</div>
      </div>
      {salon === undefined ? (
        <Skeleton width={40} height={24} radius={999} />
      ) : (
        <Toggle
          checked={salon.whatsappEnabled}
          disabled={busy}
          onChange={onChange}
          label="WhatsApp notifications"
          labelHidden
        />
      )}
    </Card>
  );
}

export function EmailReceiptsPanel({ salon, busy, onChange }: ChannelPanelProps) {
  return (
    <Card className="settings__card settings__card--inline">
      <div>
        {/*
          NO SUB-LINE. Not an oversight and not a layout choice — see the block
          above: the bundle has no merchant-facing sentence for this row, and the
          one string that describes the channel is written to a customer about
          her own receipts. Reported as needing copy rather than paraphrased.
        */}
        <div className="settings__row-name">Email receipts</div>
      </div>
      {salon === undefined ? (
        <Skeleton width={40} height={24} radius={999} />
      ) : (
        <Toggle
          checked={salon.emailEnabled}
          disabled={busy}
          onChange={onChange}
          label="Email receipts"
          labelHidden
        />
      )}
    </Card>
  );
}
