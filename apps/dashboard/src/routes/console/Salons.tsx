import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { fils } from '@avo/types';
import { deriveBrandSet } from '@avo/tokens';
import {
  Button,
  Card,
  EmptyState,
  InfoBanner,
  Money,
  Segmented,
  Skeleton,
  Stepper,
  TextField,
  Toggle,
} from '@avo/ui';
import {
  LOYALTY_LABEL,
  PLAN_LABEL,
  useOnboardSalon,
  usePlatformSalons,
  type LoyaltyMode,
  type OnboardSalonResult,
  type PlatformSalon,
} from '../../api/platformSalons.js';
import { usePlatformSettings } from '../../api/platformConsole.js';
import { useConsoleSections } from '../../auth/AuthProvider.js';
import { ApiError } from '../../api/client.js';
import { SectionError, WriteError } from '../sectionState.js';

/**
 * Console → Salons. `GET /v1/platform/salons`, gated `analytics` — see
 * `api/platformSalons.ts` for why that is not a typo and who it locks out.
 *
 * `AVO Owner Console.dc.html:202` § SALONS — the list half.
 *
 * =========================================================================
 * WHAT THIS SCREEN DELIBERATELY DOES NOT DRAW
 * =========================================================================
 * The design's section is "list → per-salon editor", and this is the list only.
 * The editor is NOT built, and the reason is an absence rather than a decision to
 * defer: THERE IS NO ENDPOINT A CONSOLE ADMIN CAN USE TO READ OR WRITE ONE SALON.
 * Driven against the real API on `avo_lane_c` with an owner-console token, which
 * is the only way to tell a refusal from a missing route — three digits do not
 * say which guard answered:
 *
 *   GET   /salons/SAL-AMARA                403  "This endpoint belongs to a
 *                                               salon. Open it from the console’s
 *                                               Salons section."      ← the guard
 *   PATCH /salons/SAL-AMARA                403  "This endpoint is for salon
 *                                               staff."               ← the guard
 *   GET   /v1/platform/salons/SAL-AMARA    404  "No such endpoint."   ← absence
 *
 * The first refusal points at THIS SCREEN for the remedy, and the remedy does not
 * exist yet: `requireSalonScoped` in `api/src/auth/principal.ts` says so in as
 * many words — "A platform admin who needs to read a salon's data reads it
 * through a console route gated on the `salons` section… Those routes are not
 * built yet." Nothing in `api/src/routes` is gated on `salons` at all today.
 *
 * So there is no `Manage` button on a row. A control that opens a screen which
 * can only 403 is worse than a column that is not there: it teaches an admin that
 * the console is broken rather than that the feature is unbuilt. The row action
 * and the Live toggle are absent for the same reason — each would be a claim the
 * product cannot honour. Reported to trunk with the two endpoints that would fix
 * it: `GET` and `PATCH /v1/platform/salons/{id}`, gated `salons`.
 *
 * THE WIZARD, BY CONTRAST, IS HERE — `POST /v1/platform/salons` landed. See
 * `OnboardWizard` below, and `api/platformSalons.ts` for the gate and the
 * idempotency rule it turns on. The button that opens it is courtesy-gated on
 * `sections.salons` while this list is gated `analytics`, because those are
 * genuinely two authorities and this screen is the one place they diverge.
 *
 * =========================================================================
 * THE BANNER COPY IS THE DESIGN'S FIRST SENTENCE AND NOT ITS SECOND
 * =========================================================================
 * The design writes: "Every salon on AVO. Open one to edit its modules, deposit
 * and loyalty structure — or flip it off to instantly suspend it. Customers keep
 * their balance."
 *
 * Only the first sentence is true of what ships. The rest describes the editor
 * that has no endpoint and a suspend that has no column, so it is dropped rather
 * than paraphrased into something vaguer — copy is verbatim or absent, never
 * softened.
 *
 * NO COURTESY GATE ON THE READ. It is `requirePlatform(req, 'analytics')`, so an
 * admin without it gets a 403 on load and `SectionError` renders the server's own
 * sentence. A second check here would duplicate the server and drift from it —
 * non-negotiable #7, the sidebar mark is a courtesy and not a control. The
 * onboard BUTTON is the exception, and it is a courtesy over a different section
 * entirely rather than a second copy of this one.
 */
export function Salons() {
  const [search, setSearch] = useState('');
  const [wizardOpen, setWizardOpen] = useState(false);
  const onboardButton = useRef<HTMLButtonElement>(null);
  const list = usePlatformSalons();
  /*
   * The courtesy over `salons`, which is NOT the section this screen's read is
   * gated on. #7 unchanged — `POST /v1/platform/salons` refuses without it, and
   * that refusal is what protects the tenant. This only stops offering a wizard
   * whose last step is guaranteed to fail.
   */
  const canOnboard = useConsoleSections().salons;

  /**
   * STABLE, and that is load-bearing rather than tidy. As an inline arrow this was
   * a new function on every render of this screen, which re-ran the wizard's focus
   * effect and moved the caret — see the note on that effect. A background refetch
   * of the salon list was enough to do it.
   *
   * §2: focus "returns to the trigger on close". The button is still mounted — the
   * courtesy gate that rendered it cannot change while the wizard is open — so this
   * is a plain restore rather than a search for somewhere plausible to land.
   */
  const closeWizard = useCallback(() => {
    setWizardOpen(false);
    onboardButton.current?.focus();
  }, []);

  const rows = (list.data?.pages ?? []).flatMap((p) => p.items);
  const query = search.trim().toLowerCase();

  /*
   * FILTERED IN THE BROWSER, AND THE WORD "shown" IS WHY THAT IS HONEST. The
   * endpoint has no `?q=`, so there is no server search to call. The count line
   * is the design's own "{n} shown" — a claim about what is on screen, not about
   * what exists — and the pager below stays visible while pages remain, so a
   * filter never silently stands in for a complete search.
   *
   * The design's placeholder is "Search salon or city" and both are matched, now
   * that `city` is on the wire. `nameAr` is matched too and is NOT drawn: the
   * design's list has no Arabic column, and an admin who types أمارا is looking for
   * Amara. Matching a field the row does not display is a search affordance, not a
   * hidden column.
   *
   * ABOVE THE ERROR RETURN, AND THAT ORDERING IS THE FIX FOR A REAL CRASH. This
   * `useMemo` originally sat below `if (list.isError) return <SectionError/>`,
   * which is a hooks-count violation: the happy render runs three hooks and the
   * error render runs two, so the first request to actually FAIL took the whole
   * console to "Rendered fewer hooks than expected" — the error boundary, not the
   * error state. Found by killing the API and reloading rather than by reading the
   * file, which is the argument for driving the failure path instead of trusting
   * that it compiles. Every hook this component owns is now called before any
   * return.
   */
  const filtered = useMemo(
    () =>
      query === ''
        ? rows
        : rows.filter(
            (s) =>
              s.name.toLowerCase().includes(query) ||
              s.id.toLowerCase().includes(query) ||
              (s.city ?? '').toLowerCase().includes(query) ||
              (s.nameAr ?? '').toLowerCase().includes(query),
          ),
    [rows, query],
  );

  if (list.isError) {
    return (
      <SectionError
        error={list.error}
        forbiddenTitle="You don't have access to salons"
        failedTitle="Couldn't load the salons"
        onRetry={() => void list.refetch()}
        retrying={list.isFetching}
      />
    );
  }

  return (
    <div className="salons">
      <InfoBanner icon={<StorefrontGlyph />}>Every salon on AVO.</InfoBanner>

      <div className="salons__controls">
        <input
          className="avo-input salons__search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search salon or city"
          aria-label="Search the salons on AVO"
        />
        {/*
          THE COUNT WITHHOLDS ITSELF WHILE PENDING, and so does the caption below.
          `rows` is `[]` before the first page lands, so an unguarded "{n} shown"
          would announce "0 shown" over a skeleton — the fabricated zero the
          no-`0.000` rule bans on money, arriving on a count instead. The same
          defect was found on both audit screens through the sr-only caption.
        */}
        <span className="salons__count" role="status">
          {list.isPending ? '' : `${filtered.length} shown`}
        </span>
        {/*
          "+ Onboard a salon", verbatim, and offered only to an admin the SERVER
          will let finish. An analyst reads this whole list and is refused the
          create — measured, not assumed — so rendering the button for her would
          walk her through four steps to a 403 on the last one.
        */}
        {canOnboard ? (
          <Button ref={onboardButton} onClick={() => setWizardOpen(true)}>
            + Onboard a salon
          </Button>
        ) : null}
      </div>

      <Card className="salons__card" flush>
        <div className="salons__scroll">
          <table className="salons__table">
            <caption className="avo-sr-only">
              Every salon on AVO, oldest first.
              {list.isPending ? '' : ` ${filtered.length} shown.`}
            </caption>
            <thead>
              <tr>
                <th scope="col">Salon</th>
                <th scope="col">City</th>
                <th scope="col">Plan</th>
                <th scope="col">Branches</th>
                <th scope="col">Members</th>
                <th scope="col">Loyalty</th>
              </tr>
            </thead>
            <tbody>
              {list.isPending ? (
                [0, 1, 2, 3, 4].map((n) => (
                  <tr key={n}>
                    {[0, 1, 2, 3, 4, 5].map((c) => (
                      <td key={c}>
                        <Skeleton width={`${80 - c * 8}%`} height={13} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="salons__empty">
                    {query !== '' ? (
                      /*
                       * NAMES WHAT IT FILTERED. "No salons" under an invisible
                       * search box reads as "AVO has no salons", which on this
                       * screen is a claim about the whole business.
                       */
                      `No salons match “${search.trim()}”.`
                    ) : (
                      <EmptyState
                        title="No salons yet"
                        body="Every salon AVO onboards appears here, with its plan, branches and loyalty mechanic."
                      />
                    )}
                  </td>
                </tr>
              ) : (
                filtered.map((salon) => <SalonRow key={salon.id} salon={salon} />)
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {list.hasNextPage ? (
        <div className="salons__more">
          <Button
            variant="secondary"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
          >
            {list.isFetchingNextPage ? 'Loading…' : 'Show more salons'}
          </Button>
        </div>
      ) : null}

      {/*
        NOT IN THE DESIGN, AND IT EARNS ITS PLACE. `memberCount` counts tombstoned
        members on purpose — the handler's reasoning is that excluding erased rows
        would make this list disagree with the ledger by exactly the number of
        erasures. An admin reconciling this column against a salon's own dashboard
        will find a difference; one sentence here is the difference between a
        known rule and a suspected bug.
      */}
      <p className="salons__foot">
        Members counts every wallet on a salon's books, including accounts since erased — the same
        figure its transactions still roll up into.
      </p>

      {wizardOpen ? <OnboardWizard onClose={closeWizard} /> : null}
    </div>
  );
}

/**
 * One row. Six columns — the design's seven minus the Live toggle, which has no
 * column to read and no endpoint to write. See the screen header.
 */
function SalonRow({ salon }: { salon: PlatformSalon }) {
  return (
    <tr>
      <td>
        <div className="salons__name">
          <span className="salons__initial" aria-hidden="true">
            {/*
              `Array.from` rather than `name[0]`: an Arabic or emoji first
              character is more than one UTF-16 code unit, and `[0]` renders half
              of it. The design's prototype writes `c.name[0]` because its data is
              ASCII; a real salon list is not.
            */}
            {Array.from(salon.name)[0] ?? ''}
          </span>
          <span>
            <span className="salons__salon">{salon.name}</span>
            <span className="salons__id">{salon.id}</span>
          </span>
        </div>
      </td>
      {/*
        EM DASH, NOT AN EMPTY CELL, for the salons that predate migration 0037.
        A blank cell reads as a rendering failure; "—" says the record is empty,
        which is the true thing. `aria-label` says it in words, because a screen
        reader announcing "dash" in a City column is not an answer.
      */}
      <td className="salons__city">
        {salon.city ?? (
          <span aria-label="No city on record">
            <span aria-hidden="true">—</span>
          </span>
        )}
      </td>
      <td>
        {/*
          The plan badge, on the `--avo-plan-*` tokens that exist for exactly this
          — NOT on `Pill`, whose `warn` tone borrows `plan.pro.bg` and would say a
          Starter salon is a warning. `Pill`'s own docstring makes that objection
          about the audit log; it applies in reverse here.
        */}
        <span className="salons__plan" data-plan={salon.plan}>
          {PLAN_LABEL[salon.plan]}
        </span>
      </td>
      <td className="salons__num">{salon.branchCount}</td>
      <td className="salons__num">{salon.memberCount.toLocaleString('en-US')}</td>
      <td className="salons__loyalty">{LOYALTY_LABEL[salon.loyaltyMode]}</td>
    </tr>
  );
}

/** The design's own storefront mark, from the Salons nav item and banner. */
function StorefrontGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M3 17V8l7-4 7 4v9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

/* ============================================================ THE WIZARD == */

/**
 * `design/README.md:165` and `AVO Owner Console.dc.html:239` § ONBOARDING WIZARD.
 * Four steps — details & plan, modules & deposit, loyalty & brand colour, review —
 * then `POST /v1/platform/salons`.
 *
 * =========================================================================
 * THE COPY THAT PROMISES A MESSAGE, AND WHAT WAS DONE ABOUT IT
 * =========================================================================
 * The design's review step says, verbatim: "Creating the salon sends the owner a
 * WhatsApp invite with their dashboard sign-in, and opens a 14-day trial before
 * the first invoice."
 *
 * NO WHATSAPP SENDER IS WIRED. The endpoint's own response says so — `invite`
 * comes back `{ delivered: false }`, `invite.sent_at` is NULL in the row, and the
 * created owner has `passwordSet: false`. So the sentence above is a promise the
 * product cannot currently keep.
 *
 * The drawn copy STANDS, on trunk's standing ruling — Lane B raised the identical
 * problem for the forgot-password screen ("a link is on its way") and trunk kept
 * the design's words. Consistency between two screens making the same claim is
 * worth more than one of them being quietly braver than the other, and the fix is
 * a sender rather than a rewrite.
 *
 * WHAT IS *NOT* DRAWN IS THE MOMENT AFTER. The prototype simply closes the modal
 * and appends a row, so there is no success copy in the design — and this is where
 * the promise would have to be either honoured or corrected. Nothing is invented
 * here: on success the wizard closes and the new salon appears in the list, which
 * is exactly what the design does. That leaves a real gap, and it is FLAGGED
 * rather than papered over: the admin's last words on screen were a delivery
 * promise, the owner cannot sign in, and the console never shows the handle it
 * just minted (`owner.handle`, in the response, rendered nowhere). Asked of trunk
 * in the lane report; not answered with drafted copy here.
 *
 * =========================================================================
 * WHERE THE IDEMPOTENCY KEY COMES FROM
 * =========================================================================
 * Minted on every ENTRY INTO REVIEW, and the two measured failure modes force
 * exactly that placement — see `useOnboardSalon`. Per-click would let a
 * double-tapped Confirm mint two salons; once-per-wizard would make Back → edit →
 * Confirm a permanent 422 `idempotency_key_reused`. Entering step 4 is the moment
 * the body stops changing, which is the moment a key means something.
 *
 * =========================================================================
 * THE BRAND COLOUR IS PREVIEWED HERE AND DECIDED THERE
 * =========================================================================
 * `deriveBrandSet` is already a dashboard dependency (`useBrandTheme` applies it),
 * so step 3 derives the swatch locally and shows the deep/tint it would produce.
 * The SERVER remains the gate — #7 — and its refusal carries the deriver's own
 * written reason, which is rendered verbatim on the field rather than summarised.
 *
 * A refusal is NOT an error state here. This is the one place a merchant's brand
 * is chosen, so "that hex cannot carry white text" is ordinary input validation:
 * it lands inline, the wizard stays on step 3, and she picks another.
 *
 * WORTH KNOWING: the design offers exactly three swatches and all three derive
 * cleanly (`#6E7F6C` → deep `#5C6A5A`, `#B08D8D` → `#825A5A`, `#8A7CB0` →
 * `#6A5A95`, checked by running the real function). So the refusal path cannot be
 * reached through the drawn control today. It is wired anyway, because the swatch
 * list is design data and a future palette is one edit away from producing a hex
 * that fails — and an unwired refusal would then surface as a dead Confirm button.
 */

/** `AVO Owner Console.dc.html:1154` — planFee and planComm, verbatim. */
const PLAN_FEE_KD: Record<string, number> = { Starter: 25, Growth: 45, Pro: 80 };
const PLAN_COMMISSION: Record<string, string> = {
  Starter: '4.0%',
  Growth: '3.0%',
  Pro: '2.0%',
};
const WIZARD_PLANS = ['Starter', 'Growth', 'Pro'] as const;

/** Same file, `wizStepLabel`. */
const STEP_LABELS = ['Salon details', 'Modules & deposit', 'Loyalty & brand', 'Review'] as const;

/** Same file, `wBrands`. Three swatches, and `wBrand: '#6E7F6C'` is preselected. */
const BRAND_SWATCHES = ['#6E7F6C', '#B08D8D', '#8A7CB0'] as const;

/**
 * The design's stepper is drawn in whole KD, 1–10, and the server's CHECK is
 * 1000–10000 fils. INTEGER FILS throughout — non-negotiable #1 — so the stepper
 * moves in thousands and no division ever happens outside `<Money>`.
 */
const DEPOSIT_MIN_FILS = 1000;
const DEPOSIT_MAX_FILS = 10_000;
const DEPOSIT_STEP_FILS = 1000;
/** The design's own `wDeposit: 5`, used only when the platform default is unreadable. */
const DEPOSIT_FALLBACK_FILS = 5000;

/** The design's `wLoyaltyNote`, both branches, verbatim. */
const LOYALTY_NOTE: Record<LoyaltyMode, string> = {
  tiers:
    'Bronze / Silver / Gold / Black start at 0, 4, 10 and 20 visits with 0, 10, 20 and 30% top-up bonus. The salon can edit these from their own dashboard.',
  stamps:
    'A stamp per visit or shop purchase, 8 stamps for a free blow-dry. No top-up bonus exists in stamps mode.',
};

/** The design's stamps summary says "8 to reward", and the server's default is 8. */
const DEFAULT_STAMP_TARGET = 8;

/**
 * Everything inside the panel a Tab can reach. `tabIndex >= 0` and a laid-out
 * `offsetParent` rather than a tag allow-list, so a step that hides a control does
 * not leave a hole in the cycle.
 */
function tabbableIn(panel: HTMLElement): HTMLElement[] {
  return [
    ...panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]',
    ),
  ].filter((el) => el.tabIndex >= 0 && el.offsetParent !== null);
}

function OnboardWizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [phone, setPhone] = useState('');
  const [plan, setPlan] = useState<string>('Growth');
  const [booking, setBooking] = useState(false);
  const [shop, setShop] = useState(false);
  const [loyaltyMode, setLoyaltyMode] = useState<LoyaltyMode>('tiers');
  const [brandColor, setBrandColor] = useState<string>(BRAND_SWATCHES[0]);
  const [depositTouched, setDepositTouched] = useState(false);
  const [deposit, setDeposit] = useState<number | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  /**
   * The response, held rather than discarded, because the wizard has a fifth
   * panel now — see `DoneStep`. `null` means "still onboarding"; non-null means the
   * salon exists and every control that could change it is gone.
   */
  const [created, setCreated] = useState<OnboardSalonResult | null>(null);

  const create = useOnboardSalon();
  const dialog = useRef<HTMLDivElement>(null);
  const doneButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  /*
   * THE DEPOSIT DEFAULT IS THE PLATFORM'S, NOT THE DESIGN'S NUMBER. The owner sets
   * a new-salon default in Controls, `platform_settings.new_salon_deposit_fils`,
   * and the create endpoint reads it when `depositFils` is absent — its comment
   * calls that "the join" for a value nothing had ever read. Seeding the stepper
   * from anywhere else would make the wizard silently override a setting the owner
   * deliberately moved.
   *
   * GATED ON `controls`, WHICH IS NOT A PERMISSION CHECK — it is a decision not to
   * make a request whose 403 is already known. A `support` admin holds `salons` and
   * not `controls`, so she can onboard and cannot read the default; she gets the
   * design's 5 KD, visible in the stepper, and changes it if it is wrong.
   */
  const canReadSettings = useConsoleSections().controls;
  const settings = usePlatformSettings({ enabled: canReadSettings });
  const defaultDeposit = settings.data?.newSalonDepositFils ?? DEPOSIT_FALLBACK_FILS;
  const depositFils = depositTouched && deposit !== null ? deposit : defaultDeposit;

  /*
   * §2: "focus moves to the sheet on open, is trapped while open, and returns to
   * the trigger on close. Esc closes."
   *
   * SPLIT IN TWO, AND THE SPLIT IS A BUG FIX. This was one effect keyed on
   * `[onClose]`, and `onClose` is an inline arrow in `Salons` — so it is a new
   * function on every parent render, so the effect re-ran, so IT RE-FOCUSED. Two
   * consequences, one of which I watched happen:
   *
   *   - the success panel has no control inside `.wiz__body`, so the re-run fell
   *     through to `tabbable()[0]` — the ✕ — and yanked the caret off the Done
   *     button a moment after the effect below had put it there. Driving it was the
   *     only way to see that; the code reads correctly in isolation.
   *   - worse, and latent: any background refetch of the salon list re-renders
   *     `Salons`, which would have thrown a typing admin back to the first field
   *     mid-step. Nothing in the happy path makes that visible.
   *
   * So: moving focus IN happens once, on mount. Trapping it is a listener that may
   * re-bind as often as it likes. `onClose` is `useCallback`-stable in the parent
   * now as well, which keeps the listener from churning at all.
   *
   * NOT SHARED WITH `MerchantShell`'s TRAP, and deliberately: that one is written
   * around a roving tabindex (its nav has exactly one tabbable link and arrow keys
   * move it), so its `tabbable()` correctly resolves to a single element. A wizard
   * with eleven controls needs the ordinary reading. Two implementations is the
   * lesser wrong until a third caller shows what the shared one should be.
   */
  useEffect(() => {
    const panel = dialog.current;
    if (panel === null) return;
    /*
     * LAND ON THE STEP, NOT ON THE CLOSE BUTTON. `tabbable()[0]` is the ✕ — it
     * comes first in DOM order — and driving the wizard showed the caret arriving
     * there on open: the first thing a keyboard user is offered is the exit. So the
     * body's first control wins, and the ✕ is only the fallback for a panel that
     * has none.
     */
    const body = panel.querySelector<HTMLElement>('.wiz__body');
    const inBody = body === null ? [] : tabbableIn(panel).filter((el) => body.contains(el));
    (inBody[0] ?? tabbableIn(panel)[0] ?? panel).focus();
    // Mount only. See the header — a re-run steals focus from wherever it went.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const mounted = dialog.current;
    if (mounted === null) return;
    const panel: HTMLDivElement = mounted;

    const tabbable = () => tabbableIn(panel);

    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = tabbable();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * The done panel replaces the whole body, and the effect above does not re-run —
   * its job is the one-time trap. Without this the caret stays wherever "Create
   * salon & send invite" was, on a button that no longer exists, and a screen
   * reader is never told the panel changed. `DoneStep` also carries
   * `role="status"`, so the facts are announced; this puts the caret on the only
   * remaining control.
   */
  useEffect(() => {
    if (created !== null) doneButton.current?.focus();
  }, [created]);

  /**
   * `wizReady` in the design: `s.wName.trim() && s.wCity.trim() && s.wPhone.trim()`
   * on step 1, and unconditional afterwards. The server requires the same three and
   * refuses each by name, so this is the same rule on the courtesy side — #7.
   */
  const step1Ready = name.trim() !== '' && city.trim() !== '' && phone.trim() !== '';
  const ready = step !== 1 || step1Ready;

  /** The optimistic preview. The server still decides — see the header. */
  const derived = useMemo(() => deriveBrandSet(brandColor), [brandColor]);

  /**
   * A FIELD-LEVEL REFUSAL, TOLD APART FROM A FAILURE. `brand_color_not_viable`
   * carries `deriveBrandSet`'s own written reason and `invalid_brand_color` carries
   * the hex-format sentence; both belong on the brand field on step 3, not in a
   * banner at the bottom of a review the admin is about to leave.
   */
  const brandRefusal =
    create.error instanceof ApiError &&
    (create.error.code === 'brand_color_not_viable' ||
      create.error.code === 'invalid_brand_color')
      ? create.error.message
      : null;

  function toStep(next: number) {
    /*
     * Entering review mints the key; leaving review drops it. Dropping it is the
     * half that matters: an admin who goes Back, changes the plan and returns must
     * arrive with a NEW key, because the same key with a different body is a 422.
     */
    setIdempotencyKey(next === 4 ? crypto.randomUUID() : null);
    create.reset();
    setStep(next);
  }

  function onPrimary() {
    if (!ready) return;
    if (step < 4) {
      toStep(step + 1);
      return;
    }
    if (idempotencyKey === null) return;
    create.mutate(
      {
        idempotencyKey,
        input: {
          name: name.trim(),
          city: city.trim(),
          ownerPhone: phone.trim(),
          plan,
          modules: { booking, shop },
          depositFils,
          loyaltyMode,
          ...(loyaltyMode === 'stamps' ? { stampTarget: DEFAULT_STAMP_TARGET } : {}),
          brandColor,
        },
      },
      {
        /*
         * THE MODAL STAYS OPEN. It used to close here, which is what the design's
         * prototype does — and that is the behaviour DECISIONS.md § "The wizard
         * gets a success state" overturned: closing left the drawn promise
         * ("sends the owner a WhatsApp invite") as the last thing the admin read,
         * over a message no sender will pick up.
         */
        onSuccess: (result) => setCreated(result),
        /*
         * A brand refusal sends the admin back to the field that caused it. Any
         * other refusal stays on review, where `WriteError` renders the server's
         * sentence beside the button that produced it.
         */
        onError: (cause) => {
          if (
            cause instanceof ApiError &&
            (cause.code === 'brand_color_not_viable' || cause.code === 'invalid_brand_color')
          ) {
            setStep(3);
          }
        },
      },
    );
  }

  return (
    <div className="wiz" role="presentation">
      <div
        className="wiz__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialog}
        tabIndex={-1}
      >
        <div className="wiz__head">
          <div className="wiz__headrow">
            <div>
              <h2 className="wiz__title avo-display" id={titleId}>
                {/* INVENTED heading — see `DoneStep`. */}
                {created === null ? 'Onboard a salon' : 'Salon created'}
              </h2>
              <p className="wiz__steplabel">
                {created === null
                  ? `Step ${step} of 4 · ${STEP_LABELS[step - 1]}`
                  : /*
                     * FACT ONE, in the header: the salon exists, by name and id. The
                     * id is not decoration — it is the workspace the owner types at
                     * sign-in, which is why it appears again beside the handle below.
                     */
                    `${created.salon.name} · ${created.salon.id}`}
              </p>
            </div>
            <Button variant="quiet" className="wiz__close" onClick={onClose} aria-label="Close">
              <span aria-hidden="true">✕</span>
            </Button>
          </div>
          {/*
            The design's progress bar. `role="progressbar"` with the real numbers
            rather than a decorative div — a four-step form's position is
            information, and the step label above is the only other carrier of it.
          */}
          <div
            className="wiz__progress"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={4}
            aria-valuenow={created === null ? step : 4}
            aria-label="Onboarding progress"
          >
            <span
              className="wiz__progressfill"
              style={{ width: created === null ? `${(step / 4) * 100}%` : '100%' }}
            />
          </div>
        </div>

        <div className="wiz__body">
          {created !== null ? (
            <DoneStep created={created} />
          ) : null}

          {created === null && step === 1 ? (
            <div className="wiz__stack">
              <TextField
                label="Salon name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Amara"
                autoComplete="off"
              />
              <TextField
                label="City"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="e.g. Salmiya"
                autoComplete="off"
              />
              <TextField
                label="Owner contact (WhatsApp)"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+965 …"
                inputMode="tel"
                autoComplete="off"
              />
              <div>
                <span className="wiz__label">Plan</span>
                {/*
                  A radiogroup, not a row of buttons — §2's rule for the segmented
                  controls, and this is one in everything but shape: three mutually
                  exclusive options. The design draws three buttons; three buttons
                  are three tab stops and announce nothing about being a choice.
                */}
                <div className="wiz__plans" role="radiogroup" aria-label="Plan">
                  {WIZARD_PLANS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={plan === p}
                      className="wiz__plan"
                      data-on={plan === p ? '' : undefined}
                      onClick={() => setPlan(p)}
                    >
                      {p} · {PLAN_FEE_KD[p]} KD/mo
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {created === null && step === 2 ? (
            <div className="wiz__stack">
              <p className="wiz__hint">
                Modules start off. Turn on only what this salon has agreed to run.
              </p>
              <ModuleRow
                label="Booking"
                sub="Appointments, deposits and artist hours"
                on={booking}
                onChange={setBooking}
              />
              <ModuleRow
                label="Shop"
                sub="Flat catalog, pay from wallet, pickup at salon"
                on={shop}
                onChange={setShop}
              />
              <div className="wiz__row">
                <div>
                  <div className="wiz__rowlabel">Booking deposit</div>
                  <div className="wiz__rowsub">Auto-returned an hour after a missed slot</div>
                </div>
                {/*
                  INTEGER FILS in, integer fils out, and `<Money>` is the only place
                  a decimal point appears — #1. The design renders "5 KD"; this
                  renders "5.000 KD", which is the house money format everywhere
                  else in both apps and the one `formatFils` guarantees in Arabic
                  too.
                */}
                <Stepper
                  label="Booking deposit"
                  value={depositFils}
                  min={DEPOSIT_MIN_FILS}
                  max={DEPOSIT_MAX_FILS}
                  step={DEPOSIT_STEP_FILS}
                  onChange={(next) => {
                    setDepositTouched(true);
                    setDeposit(next);
                  }}
                  format={(v) => (
                    <>
                      <Money amount={fils(v)} /> <span className="wiz__unit">KD</span>
                    </>
                  )}
                />
              </div>
            </div>
          ) : null}

          {created === null && step === 3 ? (
            <div className="wiz__stack">
              <p className="wiz__hint">
                One mechanic per salon. It can be switched later, but not applied
                retroactively.
              </p>
              <Segmented
                label="Loyalty mechanic"
                value={loyaltyMode}
                onChange={setLoyaltyMode}
                options={[
                  { value: 'tiers', label: LOYALTY_LABEL.tiers },
                  { value: 'stamps', label: LOYALTY_LABEL.stamps },
                ]}
              />
              <p className="wiz__note">{LOYALTY_NOTE[loyaltyMode]}</p>
              <div className="wiz__row">
                <div>
                  <div className="wiz__rowlabel">Brand colour</div>
                  <div className="wiz__rowsub">
                    White-label token. The button variant is derived and contrast-checked.
                  </div>
                </div>
                <div className="wiz__swatches" role="radiogroup" aria-label="Brand colour">
                  {BRAND_SWATCHES.map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      role="radio"
                      aria-checked={brandColor === hex}
                      aria-label={hex}
                      className="wiz__swatch"
                      data-on={brandColor === hex ? '' : undefined}
                      style={{ background: hex }}
                      /*
                       * `create.reset()` WITH THE CHANGE, AND THAT IS A BUG FIX.
                       * Without it the server's refusal outlives the input that
                       * caused it: driving a non-viable hex, then picking a good
                       * one, left "#FFFFF0 can't be used as a brand colour"
                       * sitting under a swatch that was now perfectly fine. The
                       * admin had already fixed the field and the screen was still
                       * accusing her of the old value — a message that is stale is
                       * a message that is wrong, and this one had `role="alert"`.
                       * Found by driving the refusal, not by reading the branch.
                       */
                      onClick={() => {
                        create.reset();
                        setBrandColor(hex);
                      }}
                    />
                  ))}
                </div>
              </div>
              {/*
                THE SERVER'S SENTENCE FIRST, the local preview only when there is no
                refusal to show. Two messages about one field is how somebody ends up
                fixing the wrong one.
              */}
              {brandRefusal !== null ? (
                <p className="wiz__fielderror" role="alert">
                  {brandRefusal}
                </p>
              ) : derived.ok ? (
                <p className="wiz__derived">
                  Buttons will use{' '}
                  <span className="wiz__chip" style={{ background: derived.set.deep }}>
                    <span className="wiz__chiplabel">{derived.set.deep}</span>
                  </span>{' '}
                  on tint{' '}
                  <span className="wiz__chip" style={{ background: derived.set.tint }}>
                    <span className="wiz__chiplabel wiz__chiplabel--dark">{derived.set.tint}</span>
                  </span>
                </p>
              ) : (
                /*
                  The deriver's own reason, ahead of the round trip. Not a block: the
                  server is the gate, and a preview that refused a hex the server
                  would accept would be a second, drifting rule.
                */
                <p className="wiz__fielderror">{derived.reason}</p>
              )}
            </div>
          ) : null}

          {created === null && step === 4 ? (
            <div>
              <dl className="wiz__summary">
                <SummaryRow label="Salon" value={`${name.trim()} · ${city.trim()}`} />
                <SummaryRow label="Owner contact" value={phone.trim()} />
                <SummaryRow
                  label="Plan"
                  value={`${plan} · ${PLAN_FEE_KD[plan]} KD/mo + ${PLAN_COMMISSION[plan]} of top-ups`}
                />
                <SummaryRow
                  label="Modules"
                  value={
                    [booking ? 'Booking' : null, shop ? 'Shop' : null].filter(Boolean).join(' · ') ||
                    'Wallet only'
                  }
                />
                <SummaryRow
                  label="Deposit"
                  value={
                    <>
                      <Money amount={fils(depositFils)} /> KD
                    </>
                  }
                />
                <SummaryRow
                  label="Loyalty"
                  value={
                    loyaltyMode === 'tiers'
                      ? 'Tiers · 4 levels'
                      : `Stamps · ${DEFAULT_STAMP_TARGET} to reward`
                  }
                />
                <SummaryRow label="Brand colour" value={brandColor} />
              </dl>
              <div className="wiz__invite">
                <span className="wiz__invitedot" aria-hidden="true" />
                <span>
                  Creating the salon sends the owner a WhatsApp invite with their dashboard
                  sign-in, and opens a 14-day trial before the first invoice.
                </span>
              </div>
              {/*
                Any refusal that is not the brand field. `WriteError` renders the
                server's own sentence for a 400/409 and says what did not happen —
                which on this endpoint is the whole thing, because the create is one
                transaction.
              */}
              {create.isError && brandRefusal === null ? (
                <WriteError error={create.error} reassurance="No salon was created." />
              ) : null}
            </div>
          ) : null}
        </div>

        {/*
          ONE BUTTON WHEN IT IS DONE, and no Back. The salon exists; there is
          nothing to go back to and nothing left to edit from here — the per-salon
          editor has no endpoint yet, so offering "Back" would be a control that
          either lies or resubmits. Dismissing is the only remaining action, and
          `onClose` returns focus to the trigger exactly as Esc already does.
        */}
        <div className="wiz__foot" data-done={created === null ? undefined : ''}>
          {created === null ? (
            <>
              <Button
                variant="secondary"
                onClick={() => (step > 1 ? toStep(step - 1) : onClose())}
              >
                Back
              </Button>
              <Button onClick={onPrimary} disabled={!ready || create.isPending}>
                {step === 4
                  ? create.isPending
                    ? 'Creating…'
                    : 'Create salon & send invite'
                  : 'Continue'}
              </Button>
            </>
          ) : (
            <Button ref={doneButton} onClick={onClose}>
              Done
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function ModuleRow({
  label,
  sub,
  on,
  onChange,
}: {
  label: string;
  sub: string;
  on: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="wiz__row">
      <div>
        <div className="wiz__rowlabel">{label}</div>
        <div className="wiz__rowsub">{sub}</div>
      </div>
      <Toggle checked={on} onChange={onChange} label={label} />
    </div>
  );
}

/** A `<dl>` rather than the design's divs: every row here is a label and a value. */
function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="wiz__summaryrow">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * The wizard's fifth panel. EVERY STRING HERE IS `INVENTED` AND AUTHORISED —
 * `DECISIONS.md` § "The wizard gets a success state, and the copy is authorised"
 * (`9620372`). English only: `design/README.md` § Known gaps 1 makes the owner
 * console English-only, so there is no Arabic half to write.
 *
 * WHY IT EXISTS, because "keep the copy verbatim" would otherwise say close the
 * modal and say nothing. That rule governs copy that EXISTS, and the design draws
 * no success state at all — its prototype closes and appends a row. Doing the same
 * leaves the review step's drawn promise ("Creating the salon sends the owner a
 * WhatsApp invite with their dashboard sign-in") as the last thing an AVO admin
 * read, over an invite no process will pick up. She then tells a salon owner to
 * check WhatsApp for a message that will never arrive. That is not a missing
 * flourish, it is a false impression shipped to AVO's own staff.
 *
 * THREE FACTS AND NO PROMISES, which is the whole specification:
 *
 *   1. THE SALON EXISTS — name and id, in the panel header. The id doubles as the
 *      workspace the owner types at sign-in, so it is repeated beside the handle.
 *   2. THE OWNER'S SIGN-IN HANDLE. `owner.handle` has been in the response since
 *      the endpoint shipped and NOTHING RENDERED IT. It is the actionable fact:
 *      without it an admin has to go and find it, and there is no console screen
 *      that shows salon staff.
 *   3. THE INVITE IS QUEUED, DELIVERY NOT ENABLED. Stated as a state of the
 *      system, not an apology and not a workaround. "Queued" is exact rather than
 *      diplomatic: `onboardSalon` writes a real `staff_password_reset` outbox row
 *      inside the same transaction and leaves `sent_at` NULL, and its own audit
 *      line says "WhatsApp invite queued to …". The response's `delivered: false`
 *      is the same fact on the wire.
 *
 * WHAT IS DELIBERATELY *NOT* SAID:
 *
 *   - No instruction about how the owner gets a password. #6 allows a link and
 *     nothing else, the console has no screen that issues one for salon staff, and
 *     inventing "send them a reset link" would name an action that does not exist
 *     on this surface.
 *   - The review step's other drawn promise — "opens a 14-day trial before the
 *     first invoice" — is NOT repeated. There is no trial, subscription or invoice
 *     column in the schema; `onboardSalon`'s own header says so. Restating it here
 *     would be inventing a second false claim while fixing the first.
 *   - The invite's 60-minute expiry is not shown. It is true and it is moot: the
 *     message was never sent, so how long it stays valid changes nothing about the
 *     admin's next move. Raised with trunk rather than added unasked.
 *
 * REVERSAL, and this is the part that keeps the change cheap: when a sender lands,
 * `INVITE_STATE` below is the only string that changes. The other two facts are
 * facts either way.
 */

/** INVENTED. The lead line — what did NOT happen, before the details of what did. */
const DONE_LEAD = 'Nothing has been sent to the owner yet. Their sign-in details are below.';

/**
 * INVENTED. The delivery clause, isolated so the reversal is one edit. Not
 * "failed" and not "couldn't" — nothing was attempted, and an apology would
 * misdescribe a system that is working as configured.
 */
const INVITE_STATE = 'Queued — WhatsApp delivery is not enabled yet';

function DoneStep({ created }: { created: OnboardSalonResult }) {
  return (
    /*
     * `role="status"`, not `role="alert"`. This is the successful outcome of
     * something the admin just did, announced once when it replaces the body —
     * `alert` is for an interruption, and interaction-spec.md §4 keeps the two
     * apart. The whole panel is the announcement because the three facts only mean
     * something together.
     */
    <div className="wiz__done" role="status">
      <p className="wiz__hint">{DONE_LEAD}</p>
      <dl className="wiz__summary">
        <SummaryRow label="Salon" value={created.salon.name} />
        {/*
          The handle AND the workspace, because the merchant sign-in takes both —
          `staff_user_salon_handle_uq` is on (salon_id, handle), so "@owner" alone
          identifies nobody. Giving one without the other is half a credential.
        */}
        <SummaryRow
          label="Owner sign-in"
          value={
            <span className="wiz__signin">
              <span className="wiz__handle">{created.owner.handle}</span>
              <span className="wiz__workspace">workspace {created.salon.id}</span>
            </span>
          }
        />
        <SummaryRow label="Invite" value={INVITE_STATE} />
      </dl>
    </div>
  );
}
