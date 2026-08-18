import { useEffect, useRef, useState } from 'react';
import { DEFAULT_COMMISSION, fils, formatFils, type Salon } from '@avo/types';
import { Card, ErrorState, Pill, Skeleton, Stepper, Toggle } from '@avo/ui';
import { useSalon } from '../api/salon.js';
import { useUpdateSalon } from '../api/settings.js';
import { useSession } from '../auth/AuthProvider.js';
import { SectionError, WriteError } from './sectionState.js';

/**
 * Merchant → Settings.
 *
 * Six panels, in the design's order: optional modules, booking deposit,
 * business hours, branches, WhatsApp, and AVO's commission.
 *
 * NOT BUILT HERE, DELIBERATELY: the brand kit (logo upload, palette,
 * typography), social links, and Your plan & invoices. The first two are a
 * separate slice; the third has no endpoint of any kind — there is no invoice,
 * plan-price or payment-method shape in the API or in the contract, and the
 * design's figures ("45.000 KD a month plus 3%", "Next invoice 118.500 KD") are
 * prototype fixtures. Rendering them would put invented money on a merchant's
 * billing screen.
 *
 * COMMISSION IS SHOWN HERE, AND ONLY HERE.
 * api-contract.md: commission is "merchant-visible, customer-never". This is the
 * merchant surface, so it appears. The rates come from `DEFAULT_COMMISSION` in
 * @avo/types — the same constant `commissionFor()` prices a real top-up with —
 * rather than from the design's typed strings, so the panel cannot drift from
 * what a merchant is actually charged.
 */

const DEPOSIT_MIN = 1_000; // 1 KD, and the API's own floor
const DEPOSIT_MAX = 10_000; // 10 KD
const DEPOSIT_STEP = 1_000;

export function Settings() {
  const session = useSession('merchant');
  const salonQuery = useSalon();
  const update = useUpdateSalon();
  const salon = salonQuery.data;

  /*
   * THE COURTESY GATE MARKETING ALREADY HAD AND THIS SCREEN DID NOT.
   *
   * `GET /salons/{id}` is guarded by `requirePrincipal` and `requireSameSalon`
   * and NO permission — deliberately, because the customer wallet reads the same
   * object for `timezone`, `businessHours` and the loyalty shape. So the read
   * succeeds for any staff member in the salon, and this screen rendered a
   * complete, editable Settings editor to a front-desk account with
   * `perms.dashboard` and `perms.loyalty` both off. Every write from it then
   * refuses.
   *
   * That is the inverse of the failure `sectionState.tsx` guards against. Not a
   * 403 wearing a Retry button, but NO refusal at all until she has set a deposit,
   * toggled WhatsApp and pressed save — at which point the screen tells her the
   * change never happened. Verified with the seeded front-desk account: six
   * sections explained themselves, Settings handed her the editor.
   *
   * `perms.loyalty` and not `perms.dashboard`, because that is what the server
   * actually enforces: every salon write — `PATCH /salons/{id}` and all three
   * branch routes — is `requireDashboardPerm(req, 'loyalty')`. Gating the courtesy
   * on `dashboard` would hide the screen from somebody the API would let save,
   * which is a worse error than the one being fixed.
   *
   * Non-negotiable #7 is unchanged: the server refuses these writes whether or
   * not this check exists. This is the courtesy, not the control. The copy is the
   * API's own sentence for `loyalty`, so a merchant who reaches the refusal by
   * another route reads the same words.
   */
  if (!session.perms.loyalty) {
    return (
      <ErrorState
        title="You don't have access to settings"
        body="You don't have permission to change loyalty settings. A manager can grant it."
      />
    );
  }

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

  return (
    <div className="settings">
      <ModulesPanel salon={salon} />
      <div className="settings__pair">
        <DepositPanel salon={salon} update={update} />
        <BusinessHoursPanel salon={salon} />
      </div>
      <div className="settings__pair">
        <BranchesPanel salon={salon} />
        <div className="settings__stack">
          <WhatsAppPanel salon={salon} update={update} />
          <CommissionPanel />
        </div>
      </div>

      {update.isError ? (
        <WriteError error={update.error} reassurance="That setting is unchanged." />
      ) : null}
    </div>
  );
}

type Updater = ReturnType<typeof useUpdateSalon>;

/* ------------------------------------------------------------------ modules */

function ModulesPanel({ salon }: { salon: Salon | undefined }) {
  return (
    <Card className="settings__card settings__card--rows">
      <h2 className="settings__title avo-display">Optional modules</h2>

      {/*
        THE API CANNOT WRITE THESE. `PATCH /salons/{id}` refuses `modules`,
        `moduleBooking` and `moduleShop` alike — verified against the running
        API, which answers `not_editable`. There is no other endpoint. So the
        toggles render in their designed place showing the salon's real state,
        and they are disabled with the reason stated, rather than being wired to
        a request that is guaranteed to fail.
      */}
      <div className="settings__notice" role="note">
        Booking and Shop can&rsquo;t be switched on from here yet — the workspace has no endpoint
        for it. Ask AVO to enable a module for your salon.
      </div>

      <ModuleRow
        name="Booking"
        body="Service → artist → slot, with a wallet deposit. Default off."
        on={salon?.modules.booking}
      />
      <ModuleRow
        name="Shop"
        body="Flat catalog, pay from wallet, pickup at salon. Default off."
        on={salon?.modules.shop}
      />
    </Card>
  );
}

function ModuleRow({ name, body, on }: { name: string; body: string; on: boolean | undefined }) {
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
          {/* The state as a word, not only as a switch position. */}
          <Pill tone={on ? 'brand' : 'quiet'}>{on ? 'On' : 'Off'}</Pill>
          <Toggle checked={on} disabled onChange={() => {}} label={`${name} module`} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ deposit */

function DepositPanel({ salon, update }: { salon: Salon | undefined; update: Updater }) {
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
  const returnLabel =
    returnMinutes % 60 === 0
      ? `${returnMinutes / 60} hour${returnMinutes === 60 ? '' : 's'}`
      : `${returnMinutes} minutes`;

  return (
    <Card className="settings__card">
      <h2 className="settings__title avo-display">Booking deposit</h2>
      <p className="settings__sub">
        Held from the wallet at confirmation. Remainder paid at the salon.
      </p>

      {salon === undefined ? (
        <Skeleton width={220} height={38} />
      ) : (
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
      )}

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

function BranchesPanel({ salon }: { salon: Salon | undefined }) {
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
          {salon.branches.map((branch) => (
            <li key={branch.id} className="settings__branch">
              <span className="settings__branch-dot" aria-hidden="true" />
              <span className="settings__branch-name">{branch.name}</span>
              <span className="settings__branch-id">{branch.id}</span>
            </li>
          ))}
        </ul>
      )}

      {/*
        The design has an "+ Add branch" field and a remove button per row.
        Neither is built: `PATCH /salons/{id}` refuses `branches` and there is no
        POST/DELETE for one. A branch id is also referenced by staff
        `branchAccess`, so removing one is a cascade the API has to own.
        Reported to Lane A.
      */}
      <div className="settings__notice" role="note">
        Adding or removing a branch isn&rsquo;t available from the dashboard yet — staff branch
        access depends on these IDs. Ask AVO to change them.
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------------- whatsapp */

function WhatsAppPanel({ salon, update }: { salon: Salon | undefined; update: Updater }) {
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
          disabled={update.isPending}
          onChange={(next) => update.mutate({ whatsappEnabled: next })}
          label="WhatsApp notifications"
        />
      )}
    </Card>
  );
}

/* --------------------------------------------------------------- commission */

function CommissionPanel() {
  /*
   * From the shared constant, not from the design's typed strings. `commissionFor`
   * prices a real top-up from exactly these numbers, so a rate change is one edit
   * in @avo/types and this panel follows it.
   *
   * PER-SALON RATES DO NOT EXIST. `CommissionRates` is a parameter of
   * `commissionFor`, but no endpoint serves a salon its own rates and the Salon
   * entity has no such field — so every salon sees the platform default. That is
   * correct today (the split is configured at the PSP, not computed by the API)
   * and would be wrong the first time AVO signs a salon on different terms.
   * Reported rather than faked with a hardcoded override.
   */
  const { knetFlatFils, cardPercent, cardFlatFils } = DEFAULT_COMMISSION;

  return (
    <Card className="settings__card">
      <h2 className="settings__title avo-display">AVO commission on top-ups</h2>
      <div className="settings__hours-row">
        <span className="settings__hours-label">KNET</span>
        <span className="settings__hours-value">{knetFlatFils} fils flat</span>
      </div>
      <div className="settings__hours-row settings__hours-row--divided">
        <span className="settings__hours-label">Card · Apple Pay</span>
        <span className="settings__hours-value">
          {cardPercent}% + {cardFlatFils} fils
        </span>
      </div>
      {/*
        The design's panel is these two rows and nothing else. No explanatory
        line is added: the customer-facing half of this question is the one open
        conflict in the bundle (the wallet design shows a fee, the contract and
        the live AvoRewards app say it never reaches a customer), and product
        copy about commission is not a thing to invent on a merchant's screen.
      */}
    </Card>
  );
}
