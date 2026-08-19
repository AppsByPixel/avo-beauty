import { useState } from 'react';
import { fils, moneyAriaLabel } from '@avo/types';
import { Button, Card, InfoBanner, Money, Skeleton, Stepper, Toggle } from '@avo/ui';
import {
  CARD_FLAT_MAX_FILS,
  CARD_PERCENT_MAX_BP,
  CARD_PERCENT_MIN_BP,
  CARD_PERCENT_STEP_BP,
  DEPOSIT_MAX_FILS,
  DEPOSIT_MIN_FILS,
  DEPOSIT_STEP_FILS,
  FLAG_DESC,
  FLAG_LABEL,
  KNET_FLAT_MAX_FILS,
  KNET_FLAT_MIN_FILS,
  KNET_FLAT_STEP_FILS,
  PLATFORM_FLAGS,
  usePlatformSettings,
  useUpdatePlatformSettings,
  type PlatformFlag,
  type PlatformSettings,
  type UpdateSettingsInput,
} from '../../api/platformConsole.js';
import { SectionError, WriteError } from '../sectionState.js';

/**
 * Controls — "Every platform switch, fee and default".
 *
 * `AVO Owner Console.dc.html:1010` § CONTROLS: a "Platform switches" card of five
 * toggles, a two-up of the KNET and Card commission steppers, and a full-width
 * new-salon deposit row.
 *
 * =========================================================================
 * THIS IS A MONEY PATH, NOT A PREFERENCES SCREEN
 * =========================================================================
 * `PATCH /v1/platform/settings` prices every subsequent top-up —
 * `services/topup.ts` reads `platform_settings` inside the top-up transaction, so
 * a value saved here decides what AVO charges. The endpoint says so itself:
 * "before that wiring the commission was a constant compiled into the server and
 * this endpoint would have been decorative."
 *
 * Consequences for this screen, each of them deliberate:
 *
 * 1. EVERY VALUE STAYS AN INTEGER. Fees are fils, the card rate is basis points,
 *    the deposit is fils. No field is ever divided into a float and sent back —
 *    non-negotiable #1 — and the percent DISPLAY is built by integer decomposition
 *    rather than `bp / 100`. See `percentLabel`.
 *
 * 2. THE FEES ARE A DRAFT WITH AN EXPLICIT SAVE. The design's steppers mutate
 *    state directly, which on a live commission would mean stepping 150 → 200 fils
 *    fires five PATCHes, writes five audit rows, and prices any top-up landing in
 *    between at an intermediate rate nobody chose. `Loyalty.tsx` already settled
 *    this shape for the tier ladder — "the draft lives in component state and is
 *    never written to the cache" — and one intended change becomes one audit row.
 *
 * 3. THE SWITCHES APPLY IMMEDIATELY, and that is not an inconsistency. A flag is a
 *    boolean with no intermediate value to pass through, so there is no wrong state
 *    to land in — the same reasoning the Admins section's permission chips carry.
 *    `maintenance` is the consequential one and the design's own description is the
 *    warning: "Show a maintenance screen and pause all charges."
 *
 * =========================================================================
 * THE CARD FEE IS NOT ONLY A PERCENTAGE, AND THE DESIGN DRAWS ONLY A PERCENTAGE
 * =========================================================================
 * `commissionFor(amount, 'card')` is `percentOf(amount, cardPercent) +
 * cardFlatFils`, and `cardFlatFils` is 50 — not 0. The design's card is titled "AVO
 * commission — Card" and described as "Percentage on card & Apple Pay top-ups.",
 * with a single stepper showing 2.5%.
 *
 * Driven on `avo_lane_c`: a 20.000 KD card top-up recorded `fee_fils = 550`. An
 * owner reading the design's card alone would predict 500.
 *
 * So the flat component is STATED on the card, read-only, beside the percentage.
 * Not as a second stepper: the design draws no control for it and inventing one
 * would be a screen nobody has seen. But a commission screen that understates AVO's
 * own commission by 50 fils a transaction is worse than one that shows a figure it
 * cannot edit. Reported to trunk as a design decision — either the card gets a
 * control or the endpoint should stop accepting the field.
 */
export function Controls() {
  const settings = usePlatformSettings();
  const update = useUpdatePlatformSettings();

  if (settings.isError) {
    return (
      <SectionError
        error={settings.error}
        forbiddenTitle="You don't have access to controls"
        failedTitle="Couldn't load the platform controls"
        onRetry={() => void settings.refetch()}
        retrying={settings.isFetching}
      />
    );
  }

  return (
    <div className="controls">
      <InfoBanner icon={<SlidersGlyph />}>
        These apply across every salon. Commission is taken per top-up at the rate held when the
        payment is created, so changing it prices future top-ups and never restates past ones.
      </InfoBanner>

      {settings.isPending || !settings.data ? (
        <ControlsSkeleton />
      ) : (
        <ControlsForm
          /*
           * REMOUNTS ON A NEW SERVER ROW, which is what makes the draft comment in
           * `ControlsForm` true rather than aspirational: `useState` initialisers
           * only run on mount, so without this key a saved value would leave the
           * stepper showing the old draft and reading as if it had not been applied.
           */
          key={settings.data.updatedAt}
          settings={settings.data}
          busy={update.isPending}
          onPatch={(patch) => update.mutate(patch)}
        />
      )}

      {update.isError ? (
        /*
         * "Nothing changed" is exact rather than reassuring-sounding: the handler
         * does the UPDATE and its audit row in ONE transaction, so a failure leaves
         * the row as it was and nothing was charged at a new rate.
         */
        <WriteError error={update.error} reassurance="No fee or switch changed." />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------- the form */

/**
 * `settings` is the SERVER's row; `draft` is the fee fields being edited.
 *
 * The draft is keyed off `updatedAt`, so when a save lands — or another admin's
 * change arrives on a refetch — the component remounts and the draft is rebuilt
 * from the new truth rather than continuing to display a stale local edit as if it
 * had been saved. That is the lost-update case the endpoint calls out: "what a
 * retry CAN do is overwrite a concurrent edit by another admin."
 */
function ControlsForm({
  settings,
  busy,
  onPatch,
}: {
  settings: PlatformSettings;
  busy: boolean;
  onPatch: (patch: UpdateSettingsInput) => void;
}) {
  const [knet, setKnet] = useState(settings.commission.knetFlatFils);
  const [cardBp, setCardBp] = useState(settings.commission.cardPercentBp);
  const [deposit, setDeposit] = useState(settings.newSalonDepositFils);

  /*
   * INTEGER COMPARISONS ONLY. `dirty` is three `!==` on integers, never a
   * stringified object or an epsilon on a float, so a fee is "changed" exactly when
   * its fils or basis points differ.
   */
  const feeDirty =
    knet !== settings.commission.knetFlatFils ||
    cardBp !== settings.commission.cardPercentBp ||
    deposit !== settings.newSalonDepositFils;

  function save() {
    /*
     * ONLY THE CHANGED FIELDS, and flat — `commission` is not a key the handler
     * accepts, despite its comment claiming the body mirrors what GET emits. See
     * api/platformConsole.ts § the PATCH shape; driven, `{"commission":{…}}` is a
     * 400 `invalid_field`.
     *
     * Sending a subset also narrows the lost-update window: an admin who changed
     * only the deposit does not overwrite another admin's fee edit with the value
     * her screen happened to load.
     */
    const patch: UpdateSettingsInput = {};
    if (knet !== settings.commission.knetFlatFils) patch.knetFlatFils = knet;
    if (cardBp !== settings.commission.cardPercentBp) patch.cardPercentBp = cardBp;
    if (deposit !== settings.newSalonDepositFils) patch.newSalonDepositFils = deposit;
    if (Object.keys(patch).length === 0) return;
    onPatch(patch);
  }

  return (
    <>
      <Card className="controls__switches">
        <div className="controls__h2 avo-display controls__switchhead">Platform switches</div>
        {PLATFORM_FLAGS.map((flag) => (
          <div className="controls__switchrow" key={flag}>
            <div className="controls__switchtext">
              <div className="controls__switchlabel">{FLAG_LABEL[flag]}</div>
              <div className="controls__switchdesc">{FLAG_DESC[flag]}</div>
            </div>
            <Toggle
              checked={settings.flags[flag]}
              disabled={busy}
              label={FLAG_LABEL[flag]}
              /* The row already names it; the switch keeps it as its accessible name. */
              labelHidden
              /*
               * A ONE-KEY PARTIAL PATCH, and the value comes from the SERVER's row
               * rather than a local mirror — so two rapid clicks cannot desynchronise
               * a switch from what is actually stored. Sending all five would
               * overwrite another admin's switch with whatever this screen loaded.
               */
              onChange={(next) => onPatch({ flags: { [flag]: next } as Partial<Record<PlatformFlag, boolean>> })}
            />
          </div>
        ))}
      </Card>

      <div className="controls__fees">
        <Card className="controls__fee">
          <div className="controls__h2 avo-display">AVO commission — KNET</div>
          <p className="controls__feedesc">Flat fee taken per KNET top-up, in fils.</p>
          <div className="controls__feerow">
            <Stepper
              label="KNET flat fee"
              value={knet}
              min={KNET_FLAT_MIN_FILS}
              max={KNET_FLAT_MAX_FILS}
              step={KNET_FLAT_STEP_FILS}
              disabled={busy}
              onChange={setKnet}
              /*
               * The unit here is FILS, which is the design's own unit for this field
               * — so the integer is rendered as itself. This is not a money format
               * that needs `formatFils`: it is a count of fils, not an amount in KD,
               * and putting "0.150" here would misread the design and the schema.
               */
              format={(v) => (
                <>
                  <span className="controls__feenum avo-display">{v}</span>
                  <span className="controls__feeunit">fils</span>
                </>
              )}
              valueText={`${knet} fils`}
            />
            <span className="controls__feerange">
              {KNET_FLAT_MIN_FILS}–{KNET_FLAT_MAX_FILS}
            </span>
          </div>
        </Card>

        <Card className="controls__fee">
          <div className="controls__h2 avo-display">AVO commission — Card</div>
          <p className="controls__feedesc">Percentage on card &amp; Apple Pay top-ups.</p>
          <div className="controls__feerow">
            <Stepper
              label="Card rate"
              value={cardBp}
              min={CARD_PERCENT_MIN_BP}
              max={CARD_PERCENT_MAX_BP}
              /*
               * 50 BASIS POINTS, WHICH IS THE MONEY RULE AND NOT THE DESIGN'S
               * STEPPER. The server divides basis points by 100 to get a percent, so
               * a rate off the half-point step cannot be applied to a fil exactly —
               * 29 bp on 25.000 KD is 73 fils by integer arithmetic and 72 through
               * the float. Stepping by 50 means this control cannot express an
               * unsafe rate, and the endpoint refuses one anyway with
               * `invalid_card_percent`.
               */
              step={CARD_PERCENT_STEP_BP}
              disabled={busy}
              onChange={setCardBp}
              format={(v) => (
                <>
                  <span className="controls__feenum avo-display">{percentLabel(v)}</span>
                  <span className="controls__feeunit controls__feeunit--pct">%</span>
                </>
              )}
              valueText={`${percentLabel(cardBp)} percent`}
            />
            <span className="controls__feerange">
              {percentLabel(CARD_PERCENT_MIN_BP)}–{percentLabel(CARD_PERCENT_MAX_BP)}%
            </span>
          </div>

          {/*
            THE FLAT COMPONENT THE DESIGN DOES NOT DRAW. Read-only — see the header.
            Stated because `commissionFor` adds it to every card and Apple Pay
            top-up, so a card labelled "2.5%" alone understates what AVO takes.
          */}
          <p className="controls__feeflat">
            Plus a flat{' '}
            <strong>
              {settings.commission.cardFlatFils} fils
            </strong>{' '}
            per card top-up. Not editable here — the design draws no control for it.
          </p>
        </Card>
      </div>

      <Card className="controls__deposit">
        <div className="controls__deposittext">
          <div className="controls__h2 avo-display">New-salon default deposit</div>
          <p className="controls__feedesc">The booking deposit each new salon starts with.</p>
        </div>
        <Stepper
          label="New-salon default deposit"
          value={deposit}
          min={DEPOSIT_MIN_FILS}
          max={DEPOSIT_MAX_FILS}
          /*
           * A WHOLE KD PER PRESS, in fils. The value never becomes a KD float: it is
           * 1000 fils per step and `<Money>` formats it at the display boundary,
           * which is the only place a decimal point appears — non-negotiable #1.
           * The design's stepper shows "5"; this shows "5.000", which is the same
           * number through the one money formatter this product has.
           */
          step={DEPOSIT_STEP_FILS}
          disabled={busy}
          onChange={setDeposit}
          format={(v) => (
            <>
              <span className="controls__feenum avo-display">
                <Money amount={fils(v)} />
              </span>
              <span className="controls__feeunit">KD</span>
            </>
          )}
          /*
           * WITHOUT THIS THE SPINBUTTON SAYS "five thousand". `aria-valuenow` is the
           * raw fils integer — it has to be, because that is the value the control
           * steps — so a screen reader announces 5000 for a field displaying
           * "5.000 KD". interaction-spec.md §2 is explicit that money must read as
           * dinars and not as a large integer, and `moneyAriaLabel` is the one
           * implementation of that. Caught by reading the accessibility tree of the
           * running screen, not from the markup.
           *
           * The other two steppers are denominated in fils and basis points, whose
           * `aria-valuenow` IS the spoken figure — only this one is KD.
           */
          valueText={moneyAriaLabel(fils(deposit))}
        />
      </Card>

      <div className="controls__save">
        <span className="controls__saved">
          {settings.updatedBy
            ? `Last changed by ${settings.updatedBy} · ${formatStamp(settings.updatedAt)}`
            : 'Never changed since launch.'}
        </span>
        <Button disabled={busy || !feeDirty} onClick={save}>
          {busy ? 'Saving…' : 'Save fee changes'}
        </Button>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- formatting */

/**
 * Basis points as a percent label.
 *
 * WHAT THIS ACTUALLY DOES, stated precisely because an earlier version of this
 * comment claimed it avoided `bp / 100` and the code below plainly divides. The
 * division happens; what is avoided is a float ever *representing* the rate. `trunc`
 * takes the whole percent and `%` takes the remainder, both yielding integers, and
 * the two are joined as STRINGS — so no fractional binary value is carried, compared
 * or rounded anywhere. `Math.trunc(bp / 100)` is exact for every integer `bp` in
 * this control's range by a wide margin.
 *
 * IT IS NOT MONEY EITHER WAY. `bp` is a rate, not an amount, and this client never
 * computes a fee: `commissionFor` runs on the server against the stored row, and the
 * fee lands on the transaction. So even a wrong label here could not mis-charge
 * anybody — it could only misinform the owner, which is why it is still worth
 * getting right.
 *
 * 250 → "2.5", 500 → "5", 0 → "0", 275 → "2.75".
 */
export function percentLabel(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const rem = Math.abs(bp % 100);
  if (rem === 0) return String(whole);
  const frac = rem % 10 === 0 ? String(rem / 10) : String(rem).padStart(2, '0');
  return `${whole}.${frac}`;
}

/** A wall clock for the "last changed" line. Not money; no fils involved. */
function formatStamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'recently';
  return at.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* ------------------------------------------------------------------ loading -- */

/**
 * interaction-spec.md §4. The fee figures skeleton as BARS — a stepper showing
 * "0 fils" or "0.000 KD" before the row arrives is a commission rate somebody could
 * read and act on.
 */
function ControlsSkeleton() {
  return (
    <>
      <Card className="controls__switches">
        <div className="controls__h2 avo-display controls__switchhead">Platform switches</div>
        {[0, 1, 2, 3, 4].map((i) => (
          <div className="controls__switchrow" key={i}>
            <div className="controls__switchtext">
              <Skeleton width="38%" height={14} />
              <Skeleton width="66%" height={12} />
            </div>
            <Skeleton width={44} height={26} />
          </div>
        ))}
      </Card>
      <div className="controls__fees">
        {['AVO commission — KNET', 'AVO commission — Card'].map((title) => (
          <Card className="controls__fee" key={title}>
            <div className="controls__h2 avo-display">{title}</div>
            <Skeleton width="70%" height={12} />
            <div className="controls__feerow">
              <Skeleton width={168} height={38} />
            </div>
          </Card>
        ))}
      </div>
      <Card className="controls__deposit">
        <div className="controls__deposittext">
          <div className="controls__h2 avo-display">New-salon default deposit</div>
          <Skeleton width="62%" height={12} />
        </div>
        <Skeleton width={168} height={38} />
      </Card>
    </>
  );
}

function SlidersGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" fill="none">
      <path d="M3 6h9M15 6h2M3 14h4M10 14h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="13.5" cy="6" r="1.9" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="8.5" cy="14" r="1.9" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
