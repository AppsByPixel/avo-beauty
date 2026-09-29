import { useEffect, useId, useRef, useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import {
  fils,
  formatFils,
  hhmmToMinutes,
  socialUrl,
  visibleSocialLinks,
  type BookingPolicy,
  type Branch,
  type Salon,
  type SocialLink,
} from '@avo/types';
import {
  Button,
  Card,
  ErrorState,
  InlineError,
  Pill,
  Segmented,
  Select,
  Skeleton,
  Stepper,
  TextField,
  Toggle,
  type SegmentedOption,
} from '@avo/ui';
import {
  useBookingPolicy,
  usePublishBookingPolicy,
  type BookingPolicyPublished,
} from '../api/bookingPolicy.js';
import { useSalon } from '../api/salon.js';
import {
  useAddBranch,
  useBranchClosurePreview,
  useCloseBranch,
  useSetBranchHours,
  useUpdateSalon,
  useUpdateSocialLink,
  type BranchClosure,
  type SocialLinkPatch,
} from '../api/settings.js';
import { useSession } from '../auth/AuthProvider.js';
import {
  END_OF_DAY,
  describeHours,
  isWindow,
  minutesToClock,
  noEvening,
  type BusinessHours,
  type Span,
} from './businessHours.js';
import { whenLabel } from './appointmentWhen.js';
import {
  MAX_CANCELLATION_RULES,
  MAX_POLICY_TEXT,
  draftFrom,
  draftToInput,
  fieldForServerError,
  parsedRules,
  ruleSentence,
  validateDraft,
  type DraftRule,
  type PolicyDraft,
  type RowError,
} from './bookingPolicyRules.js';
import { NoShowFootCopy } from './depositCopy.js';
import { SectionError, WriteError } from './sectionState.js';
import { Tills } from './Tills.js';
import {
  WALLET_CARD_BODY,
  WALLET_CARD_OPTIONS,
  WALLET_CARD_STAMPS_NOTE,
  WalletCardPreview,
  type WalletCard,
} from './walletCardChoice.js';

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
 * THE BOOKING POLICY IS A SEVENTH PANEL (2026-09-29), directly under the
 * deposit, and it replaced the deposit card's no-show return window — see
 * § deposit and § booking policy below.
 *
 * SOCIAL LINKS ARE BUILT HERE NOW, and this header said they were not.
 *
 * It read: "NOT BUILT HERE, DELIBERATELY: the brand kit (logo upload, palette,
 * typography), social links, and Your plan & invoices. The first two are a
 * separate slice". That was true when it was written; `SocialLinksPanel` below is
 * that slice, against `PATCH /v1/salons/{id}/social/{linkId}`. The sentence is
 * corrected rather than left standing, because a header claiming a shipped panel
 * does not exist is the stale "not built" claim this dashboard has now found
 * seven of — see `api/salon.ts` and `api/settings.ts`, which each keep their own.
 *
 * STILL NOT BUILT HERE, DELIBERATELY: the brand kit (logo upload, palette,
 * typography), and Your plan & invoices. The first is a separate slice; the
 * second has no endpoint of any kind — there is no invoice,
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
  /*
   * ITS OWN MUTATION, NOT `update`. `PATCH /v1/salons/{id}/social/{linkId}` is a
   * different endpoint with a different body, and keeping it separate is also
   * what lets each screen's banner say which write failed: `DepositPanel` already
   * has to read `update.variables` to keep another panel's in-flight write off its
   * select, and a fourth writer on that one mutation would widen that problem
   * rather than share anything.
   */
  const social = useUpdateSocialLink();
  /*
   * The booking policy has its own read and its own write. The read is not
   * permission-gated, so it runs for every staff member; the panel decides
   * whether it is editable.
   */
  const policy = useBookingPolicy();
  const publishPolicy = usePublishBookingPolicy();
  const salon = salonQuery.data;

  /*
   * WHICH LINK THE ONE IN-FLIGHT WRITE IS ABOUT. `variables` survives a settled
   * mutation, so `isPending` / `isSuccess` / `isError` is what makes each of these
   * the CURRENT state rather than a stale echo of the last one — `DepositPanel`
   * § BOTH HALVES OF THE CONDITION EARN THEIR PLACE.
   */
  const socialId = social.variables?.id ?? null;

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
          {/*
            FIRST, BECAUSE THE DESIGN PUTS IT ABOVE Optional modules and the two
            cards it draws between them — the brand kit and the customer-app
            preview — are not built. `SocialLinksPanel` § WHAT THE DESIGN DRAWS.

            INSIDE THE `perms.loyalty` GATE, with the other five salon panels,
            because its endpoint carries the same guard. That is a COURTESY and
            not the control: `requireDashboardPerm(req, 'loyalty')` refuses the
            PATCH with this check deleted, and if the permission is revoked while
            the screen is open the row's own `WriteError` renders the server's
            403 verbatim. Non-negotiable #7.
          */}
          {/*
            THE WALLET CARD FIRST, where the design puts the brand kit it belongs
            to (`AVO Merchant Dashboard.dc.html:963`). The kit itself — logo,
            palette, typography — is still not built, so this card carries the
            brand colour as a read-out beside the one brand choice that is.
          */}
          <WalletCardPanel salon={salon} canEdit />
          <SocialLinksPanel
            salon={salon}
            saving={social.isPending ? socialId : null}
            saved={social.isSuccess ? socialId : null}
            failed={social.isError && socialId !== null ? { id: socialId, error: social.error } : null}
            onSave={(patch: SocialLinkPatch) => social.mutate(patch)}
          />
          <ModulesPanel salon={salon} update={update} />
          <div className="settings__pair">
            <DepositPanel
              salon={salon}
              update={update}
              policy={policy.isSuccess ? policy.data : undefined}
            />
            <BusinessHoursPanel salon={salon} />
          </div>
          {/*
            THE BOOKING POLICY SITS DIRECTLY UNDER THE DEPOSIT, full width: it is
            the rule for what happens to that deposit, and it replaces the return
            window that card used to carry. Full width because a cut-off row
            ("At least [24] hours before → [100] % back  Remove") wraps in half a
            column, and a rule that breaks across lines is harder to read as one.
          */}
          <BookingPolicyPanel
            policy={policy}
            timezone={salon?.timezone ?? null}
            canEdit
            publish={publishPolicy}
          />
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
        <>
          <ErrorState
            title="You don't have access to salon settings"
            body="You don't have permission to change loyalty settings. A manager can grant it."
          />
          {/*
            READ-ONLY, NOT HIDDEN, for the policy's reason: the salon read is
            ungated, so what her customers' cards look like is not a secret from
            her. The panel says why she cannot change it.
          */}
          <WalletCardPanel salon={salon} canEdit={false} />
          {/*
            READ-ONLY, NOT HIDDEN. The policy read is ungated — her customers
            read it before they book — so staff without `perms.loyalty` may read
            it too. The panel says why it cannot be edited.
          */}
          <BookingPolicyPanel
            policy={policy}
            timezone={salon?.timezone ?? null}
            canEdit={false}
            publish={publishPolicy}
          />
        </>
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

/* -------------------------------------------------------------- wallet card */

/**
 * ==========================================================================
 * Merchant → Settings → Wallet card — NEW WORK, THE DESIGN DRAWS NO SUCH CARD
 * ==========================================================================
 * Aftab, 2026-09-29: a workspace that has chosen its theme — the dark-green
 * `forest` preset, say — keeps it on the wallet card instead of the member's
 * tier metal. `Salon.walletCard` (trunk, fd6edc8): `tier` (the default) or
 * `brand`. The words and the picture are `walletCardChoice.tsx`, shared with
 * the console's onboarding wizard.
 *
 * THE SAME DOOR AND THE SAME GATE AS THE BRAND. `PATCH /salons/{id}` with
 * `{ walletCard }`, `perms.loyalty` — the courtesy check is `canEdit`, and the
 * server refuses with it deleted (#7). Without it the card is READ-ONLY, not
 * absent: `GET /salons/{id}` is ungated, so the setting is not a secret, and a
 * control that vanishes tells her nothing about why.
 *
 * ITS OWN MUTATION, not `Settings`' shared `update`, for `SalonHoursEditor`'s
 * reason: the refusal belongs on this card, beside the control that caused it,
 * and a write in flight here must not disable the deposit stepper or the
 * module switches.
 *
 * NO OPTIMISTIC FLIP, for `ModuleRow`'s reason. The segment follows the SERVER's
 * value; `useUpdateSalon` writes the parsed response into the cache and the
 * selection moves then, not before. So a refusal needs no rollback — the choice
 * never moved — and "Saving…" is the only thing the press changes until the
 * answer lands.
 *
 * THE REFUSAL IS THE SERVER'S SENTENCE, whatever its code. Lane A names the code
 * for a bad value in parallel; today's API has no `walletCard` in
 * `MERCHANT_EDITABLE` and answers `400 not_editable` — "These fields cannot be
 * edited here: walletCard." — and `WriteError` renders either verbatim.
 */
export function WalletCardPanel({ salon, canEdit }: { salon: Salon | undefined; canEdit: boolean }) {
  const update = useUpdateSalon();

  function choose(next: WalletCard) {
    if (!canEdit || update.isPending || salon === undefined || next === salon.walletCard) return;
    update.mutate({ walletCard: next });
  }

  return (
    <Card className="settings__card">
      <h2 className="settings__title avo-display">Wallet card</h2>
      <p className="settings__sub">
        The main card in the customer app. Changes reach phones on next open.
      </p>

      {salon === undefined ? (
        <div className="wcard-panel">
          <div className="wcard-panel__controls">
            <Skeleton width={220} height={40} radius={12} />
            <Skeleton width="70%" height={15} />
          </div>
          <Skeleton width={232} height={128} radius={18} />
        </div>
      ) : (
        <div className="wcard-panel">
          <div className="wcard-panel__controls">
            {canEdit ? null : (
              <p className="policy__readonly" role="note">
                You can see this setting but not change it — changing it needs the loyalty
                permission. A manager can grant it.
              </p>
            )}
            <Segmented
              label="Wallet card"
              value={salon.walletCard}
              onChange={choose}
              options={WALLET_CARD_OPTIONS.map((o) => ({
                ...o,
                disabled: !canEdit || update.isPending,
              }))}
            />
            <p className="settings__row-body">
              {WALLET_CARD_BODY[salon.walletCard]}
            </p>
            {salon.loyaltyMode === 'stamps' ? (
              <p className="settings__row-body">{WALLET_CARD_STAMPS_NOTE}</p>
            ) : null}
            {/*
              THE BRAND, AS A READ-OUT. The brand kit is not built, so the hex
              cannot be changed here; it is shown because "Our colour" means
              this one. `--avo-brand` as a pure surface with no text on it (#9).
            */}
            <div className="wcard-panel__brand">
              <span className="wcard-panel__swatch" aria-hidden="true" />
              <span>
                Brand colour <span className="wcard-panel__hex">{salon.brandColor.toUpperCase()}</span>
              </span>
            </div>
            {update.isPending ? (
              <p className="wcard-panel__status" role="status">
                Saving…
              </p>
            ) : null}
            {update.isError ? (
              <WriteError error={update.error} reassurance="That setting is unchanged." />
            ) : null}
          </div>
          <WalletCardPreview
            choice={salon.walletCard}
            brandHex={salon.brandColor}
            loyaltyMode={salon.loyaltyMode}
          />
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------- social links */

/**
 * ==========================================================================
 * Merchant → Settings → Social links.
 * ==========================================================================
 * WHAT THE DESIGN DRAWS, AND WHERE. `design/AVO Merchant Dashboard.dc.html:1019`
 * — a white card between the customer-app preview and Optional modules, titled
 * "Social links", with the sub-line rendered verbatim below, then four rows
 * repeated over `socialRows` (`:1025`, `hint-placeholder-count="4"`). Each row is
 * an icon tile, a fixed-width name, a text input and a bare switch:
 *
 *     [icon 36]  Instagram   [ @handle …………………… ]   ( o)
 *
 * and the handler pair at `:2068` is `API.setSocial(so.id, { handle })` on input
 * and `API.setSocial(so.id, { on })` on the switch — ONE LINK PER WRITE, which is
 * the endpoint this panel calls. The placeholders at `:2066` are the design's
 * own: `@handle`, and `+965 ····` for WhatsApp.
 *
 * IT SITS FIRST ON THE SCREEN RATHER THAN THIRD, and that is the design's order
 * rather than a departure from it: everything the artboard draws above this card
 * — the brand kit and the customer-app preview — is the slice that is still not
 * built, so this is the topmost panel that exists. The cards below it keep the
 * order they had.
 *
 * ONE THING IS ADDED TO THE DRAWN ROW: the caption under each input, which names
 * whether the customer app is showing that channel and where the icon points.
 * The design has no such line, and it is added deliberately rather than by
 * oversight — `api/src/routes/salons.ts` sends `url` back with every write for
 * exactly this, "so the merchant screen can show where the icon now points
 * without reimplementing the four rules", and a handle box with no feedback
 * cannot tell a merchant that a switch left On is showing nothing because the
 * handle beside it is empty. Reported to trunk as an addition to the artboard.
 *
 * THE COPY IN THE CAPTIONS IS THIS LANE'S and is reported as needing a writer.
 * The bundle has no string for an empty channel or a saved one. "Shown" and
 * "Hidden" are not invented: they are the API's own words for these two states —
 * `routes/salons.ts` writes the audit detail as `… · shown` / `… · hidden`.
 */

/**
 * THE FOUR IDS IN THE CONTRACT'S ORDER — `SocialLinkSchema`'s enum, and
 * `SOCIAL_IDS` on the server, which derives from the same enum.
 *
 * THE ROWS ARE DRAWN FROM THIS LIST AND NOT FROM `salon.social`. A salon
 * onboarded through the wizard starts with `social: []` (the column default), and
 * the design draws four rows always; `applySocialPatch` creates a link the salon
 * does not have rather than answering 404, precisely so that a new salon can set
 * its first handle. Rendering the server's array would show that salon an empty
 * card with nothing to type into.
 */
const SOCIAL_IDS: readonly SocialLink['id'][] = ['instagram', 'tiktok', 'snapchat', 'whatsapp'];

/**
 * THE FALLBACK LABEL, for a row the salon does not have yet.
 *
 * `label` IS DERIVED SERVER-SIDE AND IS NEVER SENT — `SOCIAL_LABELS` in
 * `api/src/services/socialLinks.ts`, because the string renders under the icons
 * in the customer app and "a merchant-settable string there is arbitrary copy in
 * the wallet with no review path". So this map is not a second source of truth
 * for the label; it is what a row with no server record yet is called. Where the
 * salon HAS the link, its own `label` renders.
 */
const SOCIAL_LABEL: Record<SocialLink['id'], string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  snapchat: 'Snapchat',
  whatsapp: 'WhatsApp',
};

/**
 * ==========================================================================
 * FOUR NETWORKS, FOUR HANDLE FORMATS, AND THE SCREEN SAYS WHICH BEFORE SHE TYPES
 * ==========================================================================
 * `parseSocialHandle` accepts an `@name` for three networks and E.164 for
 * WhatsApp, and refuses a pasted URL by name on all four. One box that takes
 * anything and fails on save is the shape worth avoiding, so the format is stated
 * twice per row: as the design's placeholder, and as the field's accessible name
 * — "WhatsApp number", not "WhatsApp handle", because a phone number is what it
 * wants and a screen-reader user gets the placeholder read as a value, not as a
 * spec.
 *
 * WHAT IS DELIBERATELY NOT HERE IS A CLIENT-SIDE COPY OF THE FOUR RULES.
 * `api/src/services/socialLinks.ts` is emphatic that ONE parser serves both
 * server doors "so the two cannot disagree about what a handle is"; a third copy
 * in this column would be the client explaining a refusal the API stopped giving
 * — the receipt-floor mistake `settingsReceiptChannels.test.ts` pins. Saying what
 * is wanted is a courtesy; deciding what is valid is the server's, and the
 * refusal renders verbatim with the network named.
 */
const SOCIAL_PLACEHOLDER: Record<SocialLink['id'], string> = {
  instagram: '@handle',
  tiktok: '@handle',
  snapchat: '@handle',
  /* The design's own string, `…dc.html:2066` — four dots, not a real number. */
  whatsapp: '+965 ····',
};

const SOCIAL_FIELD_LABEL: Record<SocialLink['id'], string> = {
  instagram: 'Instagram handle',
  tiktok: 'TikTok handle',
  snapchat: 'Snapchat handle',
  whatsapp: 'WhatsApp number',
};

/**
 * The four icons, as the design's reference implementation draws them —
 * `design/avo-promotions.js:524`. Path data only: the tile around them is CSS
 * here rather than the inline style the prototype carries.
 */
const SOCIAL_ICON: Record<SocialLink['id'], string> = {
  instagram:
    'M7 3.5h10a3.5 3.5 0 0 1 3.5 3.5v10a3.5 3.5 0 0 1-3.5 3.5H7A3.5 3.5 0 0 1 3.5 17V7A3.5 3.5 0 0 1 7 3.5ZM12 8.2a3.8 3.8 0 1 1 0 7.6 3.8 3.8 0 0 1 0-7.6ZM17.1 6.7h.01',
  tiktok: 'M14 3.5v10.2a3.4 3.4 0 1 1-2.7-3.33M14 3.5c.45 2.3 1.95 3.6 4.1 3.8',
  snapchat:
    'M12 3.2c3 0 4.6 2 4.6 4.6 0 .9-.1 1.7.3 2 .5.4 1.4 0 1.7.5.3.6-.9 1.2-1.7 1.6-.5.3.4 1.9 2 2.4.5.2.3.8-.4 1-1 .3-1.6.2-1.9.6-.2.3-.1.9-.7.9-1 0-1.8-.4-2.8.3-.8.6-1.4 1.1-2.6 1.1s-1.8-.5-2.6-1.1c-1-.7-1.8-.3-2.8-.3-.6 0-.5-.6-.7-.9-.3-.4-.9-.3-1.9-.6-.7-.2-.9-.8-.4-1 1.6-.5 2.5-2.1 2-2.4-.8-.4-2-1-1.7-1.6.3-.5 1.2-.1 1.7-.5.4-.3.3-1.1.3-2C7.4 5.2 9 3.2 12 3.2Z',
  whatsapp:
    'M20 12a8 8 0 0 1-11.9 7L4 20l1.1-4A8 8 0 1 1 20 12ZM9.2 8.9c.4-.2.9 0 1 .4l.6 1.3-.7.9c.5 1 1.3 1.8 2.3 2.2l.9-.7 1.3.6c.4.2.6.6.4 1-.3.8-1.2 1.2-2 1-2.4-.6-4.3-2.5-4.9-4.9-.2-.8.3-1.6 1.1-1.8Z',
};

/** How long the handle box waits after the last keystroke before it writes. */
const SOCIAL_SAVE_DELAY = 550;

export interface SocialLinksPanelProps {
  salon: Salon | undefined;
  /** The link a write is in flight for. */
  saving: SocialLink['id'] | null;
  /** The link whose last write landed. */
  saved: SocialLink['id'] | null;
  /** The link whose last write was refused, and the server's answer. */
  failed: { id: SocialLink['id']; error: unknown } | null;
  onSave: (patch: SocialLinkPatch) => void;
}

export function SocialLinksPanel({ salon, saving, saved, failed, onSave }: SocialLinksPanelProps) {
  const links = salon?.social;

  /**
   * WHICH CHANNELS THE CUSTOMER APP IS ACTUALLY SHOWING, BY THE SHARED RULE.
   *
   * `visibleSocialLinks` is `on && a handle that derives a URL` — and the second
   * half is the part a row cannot infer from its switch. A link left On with an
   * empty handle renders NOTHING in the wallet, so `link.on ? 'Shown' : 'Hidden'`
   * would tell a merchant her Instagram is live while every customer sees three
   * icons. Re-deriving the predicate here is the drift `packages/types/src/rules.ts`
   * exists to prevent; this asks it.
   */
  const shown = new Set((links ? visibleSocialLinks(links) : []).map((l) => l.id));

  /**
   * THE EMPTY STATE: not a salon with no ROWS — there are always four — but a
   * salon with no handle on any of them, which is every salon on the day it is
   * onboarded. The rows stay editable; what is added is a sentence saying what
   * the customer app is doing meanwhile, because a card of four blank boxes does
   * not say "nothing is being shown" to anyone who has not been told.
   */
  const nothingSetYet = links !== undefined && links.every((l) => l.handle.trim() === '');

  return (
    <Card className="settings__card">
      <h2 className="settings__title avo-display">Social links</h2>
      {/* Verbatim, `AVO Merchant Dashboard.dc.html:1024`. It is also the panel's
          own statement that the switch is not a delete, which is why it is the
          one line here that may not be reworded. */}
      <p className="settings__sub">
        Shown as icons in the customer app under Help. Off hides the icon but keeps the handle.
      </p>

      {nothingSetYet ? (
        <p className="settings__social-empty">
          No handles yet — the customer app shows no social icons for this salon.
        </p>
      ) : null}

      <div className="settings__social">
        {SOCIAL_IDS.map((id) => (
          <SocialRow
            key={id}
            id={id}
            link={links?.find((l) => l.id === id)}
            loading={links === undefined}
            visible={shown.has(id)}
            saving={saving === id}
            saved={saved === id}
            onSave={onSave}
          />
        ))}
      </div>

      {/*
        THE FAILURE NAMES ITS NETWORK, and that is the whole reason this banner is
        here rather than folded into the screen-level one at the foot. Four rows
        write through one mutation; "That setting is unchanged." under a card with
        four boxes in it does not say which box. `WriteError` renders the server's
        own sentence — including the 403 a merchant gets if `loyalty` was revoked
        while this screen was open, and including `handle_is_a_url`, which names
        the fix.
      */}
      {failed !== null ? (
        <WriteError
          error={failed.error}
          reassurance={`${SOCIAL_LABEL[failed.id]} is unchanged.`}
        />
      ) : null}
    </Card>
  );
}

interface SocialRowProps {
  id: SocialLink['id'];
  link: SocialLink | undefined;
  loading: boolean;
  /** `visibleSocialLinks` said the wallet renders this one. */
  visible: boolean;
  saving: boolean;
  saved: boolean;
  onSave: (patch: SocialLinkPatch) => void;
}

function SocialRow({ id, link, loading, visible, saving, saved, onSave }: SocialRowProps) {
  const serverHandle = link?.handle ?? '';
  const [draft, setDraft] = useState(serverHandle);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captionId = useId();

  /*
   * The server's value wins whenever it changes underneath — a colleague editing
   * this row in the next tab, or this row's own write coming back normalised:
   * `parseE164` stores "+965 2233 4455" as it canonicalises it, so the box has to
   * be able to show her what was actually kept.
   *
   * AFTER A REFUSED WRITE THE DRAFT DELIBERATELY SURVIVES. The server value did
   * not change, so this effect does not re-fire, and what she typed stays in the
   * box beside the sentence explaining it. That is the same mechanism
   * `DepositPanel` records as a FLAW in a stepper — a number nobody accepted
   * sitting under the merchant's hand — and it is the right behaviour for a text
   * field, where the refused value is the thing she now has to edit.
   */
  useEffect(() => setDraft(serverHandle), [serverHandle]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  /*
   * DEBOUNCED, FOR `DepositPanel`'s REASON AND NOT THE DESIGN'S. The prototype
   * writes on every keystroke (`onInput` → `API.setSocial`), which against a real
   * API is a PATCH and an audit row per character — and `writeAudit` stamps every
   * one of them, so a merchant typing "@amara.kw" would leave nine "Social link
   * changed" rows in a log another merchant reads. The last value wins and the
   * request carries the settled string.
   */
  function onType(next: string) {
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (next !== serverHandle) onSave({ id, handle: next });
    }, SOCIAL_SAVE_DELAY);
  }

  /*
   * THE SWITCH WRITES IMMEDIATELY AND SENDS ONLY `on`. One key per control, the
   * same rule the module toggles follow: sending the handle with it would make a
   * flip a write of whatever is in the box, including a draft mid-edit.
   *
   * IT ALSO SENDS NO HANDLE *BECAUSE THE HANDLE IS KEPT* — this is the control
   * that must not read as a delete. `applySocialPatch` copies `handle` through
   * untouched when the patch does not mention it, so turning Snapchat off and on
   * again returns the same handle, which is the property the contract states and
   * `settingsSocialLinks.test.tsx` pins.
   */
  function onToggle(next: boolean) {
    onSave({ id, on: next });
  }

  const name = link?.label || SOCIAL_LABEL[id];
  /*
   * DERIVED, NEVER STORED AND NEVER SPELLED OUT HERE — api-contract.md § SocialLink:
   * "Store the handle, derive the URL. Never persist a URL: a salon that edits its
   * handle would leave the icon pointing at a dead profile." `socialUrl` is the one
   * implementation, shared with the wallet and with the API's own response, so a
   * network that changes its domain changes it in one place.
   *
   * FROM THE SERVER'S HANDLE, NOT THE DRAFT. This line is a claim about where the
   * icon points in the customer app right now, and a draft has not been stored. A
   * URL built from half-typed text would be a claim about a profile that nobody
   * outside this browser can reach.
   */
  const url = socialUrl(id, serverHandle);

  return (
    <div className="settings__social-row">
      <span className="settings__social-icon" aria-hidden="true">
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
          <path
            d={SOCIAL_ICON[id]}
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="settings__social-name">{name}</span>

      {loading ? (
        <>
          {/* At the control's real height, so the card does not reflow when the
              salon lands — interaction-spec.md §4. */}
          <span className="settings__social-field">
            <Skeleton height={37} radius={10} />
          </span>
          <Skeleton width={40} height={24} radius={999} />
        </>
      ) : (
        <>
          <span className="settings__social-field">
            <TextField
              label={SOCIAL_FIELD_LABEL[id]}
              labelHidden
              value={draft}
              placeholder={SOCIAL_PLACEHOLDER[id]}
              /* A phone keypad for the one field that wants a number. */
              inputMode={id === 'whatsapp' ? 'tel' : 'text'}
              autoComplete="off"
              spellCheck={false}
              describedBy={captionId}
              onChange={(e) => onType(e.target.value)}
            />
            <span className="settings__social-caption" id={captionId}>
              <SocialCaption
                url={url}
                visible={visible}
                saving={saving}
                saved={saved}
              />
            </span>
          </span>

          {/*
            NOT A DELETE, AND THE ACCESSIBLE NAME IS WHERE THAT IS SAID. "Show
            Instagram in the customer app" is a visibility control in words; "Remove
            Instagram" is what the same switch would be called if it were the other
            thing. The handle stays in the box beside it either way, the caption
            keeps printing the link it still points at, and the panel's sub-line
            says so in the design's own sentence. Three statements of one property,
            because the control itself is a switch and switches are ambiguous.

            `labelHidden` for `WhatsAppPanel`'s reason — the row already draws the
            name, and `Toggle` would otherwise paint it twice.
          */}
          <Toggle
            checked={link?.on ?? false}
            onChange={onToggle}
            label={`Show ${name} in the customer app`}
            labelHidden
          />
        </>
      )}
    </div>
  );
}

/**
 * The line under the box. One slot, four things it can say, in the order that
 * matters most to someone who has just typed.
 *
 * `Saving…` and `Saved` are the write states. They report the mutation rather
 * than a local flag: `Saved` therefore stays until the next write, which is
 * honest — the last thing that happened to this row IS a successful save — rather
 * than fading on a timer that would have to be a second source of truth about
 * whether the server has the value.
 *
 * A FAILURE DOES NOT SPEAK HERE. It says `Not saved` and the sentence goes to the
 * banner at the foot of the card, because the server's copy is a full sentence
 * naming a fix ("Enter just the Instagram handle, not the link…") and this slot
 * is one line under an input.
 */
function SocialCaption({
  url,
  visible,
  saving,
  saved,
}: {
  url: string | null;
  visible: boolean;
  saving: boolean;
  saved: boolean;
}) {
  if (saving) return <>Saving…</>;

  /*
   * `url === null` IS THE EMPTY HANDLE, and the route asks for it to be rendered
   * rather than hidden: "null when the handle is empty, which is a fact the form
   * should render rather than hide." It is also the state a switch cannot show —
   * On with nothing to point at.
   */
  if (url === null) {
    return <>{saved ? 'Saved · ' : ''}Not set — nothing shows in the customer app.</>;
  }

  return (
    <>
      {saved ? 'Saved · ' : ''}
      {visible ? 'Shown' : 'Hidden'} ·{' '}
      <a
        className="settings__social-link"
        href={url}
        target="_blank"
        rel="noreferrer noopener"
      >
        {url}
      </a>
    </>
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
 * THE NO-SHOW RETURN WINDOW IS GONE FROM THIS CARD — THE SALON'S POLICY SAYS IT
 * ═══════════════════════════════════════════════════════════════════════════
 * This card carried a "Return window" select (15 minutes … 4 hours) writing
 * `noShowReturnMinutes` through `PATCH /salons/{id}`. Lane A's be36b9a moved that
 * field out of `MERCHANT_EDITABLE` into `PLATFORM_ONLY_EDITABLE`, so every pick
 * now answers `400 not_editable`. The rule it set is replaced by the salon's own
 * booking policy (migration 0066; DECISIONS, the fourth list): the salon chooses
 * whether a no-show keeps or returns the deposit, in `BookingPolicyPanel` below.
 * The window survives only on the console, for legacy bookings and the till's
 * early-arrival grace.
 *
 * `SalonPatch` no longer admits the key, so the compiler refuses a stale write
 * from this client too. `settingsNoShowWindow.test.tsx` pins both halves.
 *
 * THE FOOT SENTENCE FOLLOWS THE POLICY. The design's line ("No-show: deposit
 * returns to the wallet 1 hour after a missed slot.") is still true of a salon
 * that has never published a policy, and is shown for exactly that salon.
 * `depositCopy.tsx` owns both wordings, shared with the Appointments banner.
 */
export function DepositPanel({
  salon,
  update,
  policy,
}: {
  salon: Salon | undefined;
  update: Updater;
  /** `undefined` while the policy read is in flight or failed: the foot makes no claim. */
  policy?: BookingPolicy | null | undefined;
}) {
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

      {/*
        NO CLAIM BEFORE BOTH READS LAND. The legacy line needs the salon's window
        and the policy line needs the policy; guessing either is telling a
        merchant a rule about a customer's money that nobody sent. Skeletoned at
        the line's height so the card does not grow on load.
      */}
      <div className="settings__foot">
        {salon === undefined || policy === undefined ? (
          <Skeleton width="82%" height={15} />
        ) : (
          <NoShowFootCopy policy={policy} legacyMinutes={salon.noShowReturnMinutes} />
        )}
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------- booking policy */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Settings → Booking policy — NEW WORK, THE DESIGN DRAWS NO SUCH CARD
 * ═══════════════════════════════════════════════════════════════════════════
 * Aftab, 2026-09-29: "Policy change option in the dashboard and a notification
 * should be sent on each policy change"; "In booking deposit there must be no
 * return or refund window but there must be option to set policy about the
 * refund that will be displayed to the customer"; "how much time before the
 * booked slot, X amount will be returned".
 *
 * `GET /salons/{id}/booking-policy` reads it; `PUT` publishes version n+1 and
 * writes one wallet-bell notice per member, coalesced to one a salon-day, no push.
 * `api/src/services/bookingPolicy.ts` is the specification.
 *
 * THE FORM VALIDATES AS THE SERVER DOES, IN THE SERVER'S WORDS
 * (`bookingPolicyRules.ts`), and still maps every server `400` back to its row —
 * the PUT is the control, the form is a courtesy.
 *
 * `perms.loyalty` GATES THE PUT, and without it this card is READ-ONLY rather
 * than absent: the GET is not gated (the policy is the most public thing a salon
 * publishes), so a staff member without the permission can still read what her
 * customers are told. The refusal the server gives a mid-session revocation
 * renders through `WriteError`, verbatim. Non-negotiable #7.
 *
 * WHAT IS RETURNED IS WALLET CREDIT (#5). Nothing on this card offers, or
 * implies, cash or a card reversal.
 */
export function BookingPolicyPanel({
  policy,
  timezone,
  canEdit,
  publish,
}: {
  policy: UseQueryResult<BookingPolicy | null>;
  timezone: string | null;
  canEdit: boolean;
  publish: ReturnType<typeof usePublishBookingPolicy>;
}) {
  return (
    <Card className="settings__card">
      <h2 className="settings__title avo-display">Booking policy</h2>
      <p className="settings__sub">
        What happens to her deposit if she cancels or doesn&rsquo;t arrive. She sees this before
        she books, and anything returned goes back to her AVO wallet.
      </p>
      {policy.isError ? (
        <SectionError
          error={policy.error}
          forbiddenTitle="You don't have access to the booking policy"
          failedTitle="Couldn't load the booking policy"
          onRetry={() => void policy.refetch()}
          retrying={policy.isFetching}
        />
      ) : policy.isPending ? (
        <div className="policy__loading">
          <Skeleton width="60%" height={15} />
          <Skeleton width="100%" height={33} radius={10} />
          <Skeleton width="100%" height={90} radius={10} />
        </div>
      ) : canEdit ? (
        <PolicyEditor
          // A new published version re-seeds the draft; typing does not.
          key={policy.data?.id ?? 'none'}
          policy={policy.data}
          timezone={timezone}
          publish={publish}
        />
      ) : (
        <PolicyReadOnly policy={policy.data} timezone={timezone} />
      )}
    </Card>
  );
}

function publishedLine(policy: BookingPolicy, timezone: string | null): string {
  return `Version ${policy.version} · published ${whenLabel(policy.publishedAt, timezone)}`;
}

function PolicyReadOnly({ policy, timezone }: { policy: BookingPolicy | null; timezone: string | null }) {
  return (
    <div className="policy">
      <p className="policy__readonly" role="note">
        You can read this policy but not change it — changing it needs the loyalty permission. A
        manager can grant it.
      </p>
      {policy === null ? (
        <p className="policy__version">
          No policy published yet. Until one is, a cancel or a no-show returns her full deposit.
        </p>
      ) : (
        <>
          <p className="policy__version">{publishedLine(policy, timezone)}</p>
          <dl className="policy__facts">
            <div>
              <dt>No-show</dt>
              <dd>{policy.noShow === 'keep' ? 'Keep the deposit' : 'Return it to her wallet'}</dd>
            </div>
            <div>
              <dt>Cancellation</dt>
              <dd>{ruleSentence(policy.cancellation)}</dd>
            </div>
            <div>
              <dt>Policy text</dt>
              <dd className="policy__text">{policy.text.en}</dd>
            </div>
          </dl>
        </>
      )}
    </div>
  );
}

const NO_SHOW_OPTIONS: SegmentedOption<BookingPolicy['noShow']>[] = [
  { value: 'keep', label: 'Keep the deposit' },
  { value: 'return', label: 'Return it to her wallet' },
];

function PolicyEditor({
  policy,
  timezone,
  publish,
}: {
  policy: BookingPolicy | null;
  timezone: string | null;
  publish: ReturnType<typeof usePublishBookingPolicy>;
}) {
  const [draft, setDraft] = useState<PolicyDraft>(() => draftFrom(policy));
  /*
   * ERRORS SHOW ONCE SHE HAS TRIED TO PUBLISH, or on a row she has already left.
   * A blank English box shouting "The policy needs its English text." before she
   * has typed a word is an error about nothing she did.
   */
  const [attempted, setAttempted] = useState(false);
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const enId = useId();
  const arId = useId();
  const touch = (key: string) => setTouched((prev) => new Set(prev).add(key));

  const local = validateDraft(draft);
  /*
   * THE SERVER'S REFUSAL WINS OVER THE FORM'S SILENCE, until she edits. A 400 the
   * form did not predict (a rule retuned in api/ before this file) is placed on
   * its row, verbatim, and cleared by the next keystroke: the mutation resets on
   * every edit, so a stale refusal never sits beside a value it no longer
   * describes.
   */
  const server = publish.isError ? fieldForServerError(publish.error) : null;
  const show = (key: string) => attempted || touched.has(key);

  const edit = (next: PolicyDraft) => {
    if (!publish.isPending) publish.reset();
    setDraft(next);
  };
  const setRule = (index: number, patch: Partial<DraftRule>) =>
    edit({ ...draft, rules: draft.rules.map((r, i) => (i === index ? { ...r, ...patch } : r)) });

  const rules = parsedRules(draft.rules);
  const input = draftToInput(draft);

  function onPublish() {
    setAttempted(true);
    if (input === null || publish.isPending) return;
    publish.mutate(input);
  }

  const rowError = (index: number): RowError | null =>
    server?.rows[index] ?? (show(`row-${index}`) ? (local.rows[index] ?? null) : null);
  const enError = server?.textEn ?? (show('en') ? local.textEn : null);
  const arError = server?.textAr ?? (show('ar') ? local.textAr : null);
  const rulesError = server?.rules ?? local.rules;

  return (
    <div className="policy">
      <p className="policy__version">
        {policy === null
          ? 'No policy published yet. Until you publish one, a cancel or a no-show returns her full deposit.'
          : publishedLine(policy, timezone)}
      </p>

      <div className="policy__group">
        <span className="avo-label">If she doesn&rsquo;t arrive</span>
        <Segmented
          label="No-show"
          options={NO_SHOW_OPTIONS}
          value={draft.noShow}
          onChange={(next) => edit({ ...draft, noShow: next })}
        />
        {server?.noShow ? <InlineError message={server.noShow} /> : null}
      </div>

      <div className="policy__group">
        <span className="avo-label">If she cancels</span>
        {draft.rules.length === 0 ? (
          <p className="policy__none">No cut-offs: a cancel keeps the whole deposit.</p>
        ) : (
          <ol className="policy__rules">
            {draft.rules.map((rule, index) => {
              const error = rowError(index);
              const errorId = `${enId}-row-${index}`;
              return (
                <li key={index} className="policy__rule">
                  <div className="policy__rule-line">
                    <span className="policy__rule-word">At least</span>
                    <input
                      className="avo-input policy__num"
                      inputMode="numeric"
                      aria-label={`Cut-off ${index + 1}: hours before the slot`}
                      aria-invalid={error?.field === 'hours' ? true : undefined}
                      {...(error?.field === 'hours' ? { 'aria-describedby': errorId } : {})}
                      value={rule.hours}
                      onChange={(e) => setRule(index, { hours: e.target.value })}
                      onBlur={() => touch(`row-${index}`)}
                    />
                    <span className="policy__rule-word">hours before</span>
                    <span className="policy__rule-arrow" aria-hidden="true">
                      &rarr;
                    </span>
                    <input
                      className="avo-input policy__num"
                      inputMode="numeric"
                      aria-label={`Cut-off ${index + 1}: percent returned`}
                      aria-invalid={error?.field === 'percent' ? true : undefined}
                      {...(error?.field === 'percent' ? { 'aria-describedby': errorId } : {})}
                      value={rule.percent}
                      onChange={(e) => setRule(index, { percent: e.target.value })}
                      onBlur={() => touch(`row-${index}`)}
                    />
                    <span className="policy__rule-word">% back</span>
                    <button
                      type="button"
                      className="policy__remove"
                      aria-label={`Remove cut-off ${index + 1}`}
                      onClick={() => {
                        setTouched(new Set());
                        edit({ ...draft, rules: draft.rules.filter((_, i) => i !== index) });
                      }}
                    >
                      Remove
                    </button>
                  </div>
                  {error ? <InlineError id={errorId} message={error.message} /> : null}
                </li>
              );
            })}
          </ol>
        )}
        {rulesError ? <InlineError message={rulesError} /> : null}
        {draft.rules.length < MAX_CANCELLATION_RULES ? (
          <div>
            <Button
              variant="secondary"
              onClick={() => edit({ ...draft, rules: [...draft.rules, { hours: '', percent: '' }] })}
            >
              Add a cut-off
            </Button>
          </div>
        ) : null}
        <p className="policy__preview" aria-live="polite">
          {rules === null ? 'Fix the cut-offs above to see the rule.' : ruleSentence(rules)}
        </p>
      </div>

      <div className="policy__group">
        <label className="avo-label" htmlFor={enId}>
          Policy text (English)
        </label>
        <textarea
          id={enId}
          className="avo-input policy__textarea"
          rows={4}
          value={draft.textEn}
          aria-invalid={enError ? true : undefined}
          {...(enError ? { 'aria-describedby': `${enId}-err` } : {})}
          onChange={(e) => edit({ ...draft, textEn: e.target.value })}
          onBlur={() => touch('en')}
        />
        <span className="policy__count">
          {draft.textEn.trim().length} / {MAX_POLICY_TEXT}
        </span>
        {enError ? <InlineError id={`${enId}-err`} message={enError} /> : null}
      </div>

      <div className="policy__group">
        <label className="avo-label" htmlFor={arId}>
          Policy text (Arabic, optional)
        </label>
        <textarea
          id={arId}
          dir="rtl"
          lang="ar"
          className="avo-input policy__textarea"
          rows={4}
          value={draft.textAr}
          aria-invalid={arError ? true : undefined}
          aria-describedby={`${arId}-hint`}
          onChange={(e) => edit({ ...draft, textAr: e.target.value })}
          onBlur={() => touch('ar')}
        />
        <span className="policy__count">
          <span id={`${arId}-hint`}>Leave empty to show the English text.</span>{' '}
          {draft.textAr.trim().length} / {MAX_POLICY_TEXT}
        </span>
        {arError ? <InlineError message={arError} /> : null}
      </div>

      <div className="policy__publish">
        <Button onClick={onPublish} disabled={publish.isPending || (attempted && input === null)}>
          {publish.isPending ? 'Publishing…' : 'Publish policy'}
        </Button>
        <span className="policy__notice-note">
          Publishing tells your customers in their wallet bell — no push, at most one
          notice a day.
        </span>
      </div>

      {publish.isSuccess ? <PublishResultLine result={publish.data} /> : null}
      {publish.isError && (server === null || server.general !== null) ? (
        <WriteError error={publish.error} reassurance="Nothing was published." />
      ) : null}
    </div>
  );
}

/**
 * WHAT THE PUBLISH DID, IN THE SERVER'S NUMBERS.
 *
 * `published: false` is the identical body: nothing was written and nobody was
 * told, and claiming "Published" over it would be claiming a change that did not
 * happen. `noticesWritten` is what THIS publish wrote — 0 on a second publish the
 * same salon-day, because each customer gets at most one notice a day.
 */
export function PublishResultLine({ result }: { result: BookingPolicyPublished }) {
  if (!result.published) {
    return (
      <p className="policy__result" role="status">
        <b>Nothing changed.</b> This is already the published policy (version{' '}
        {result.policy.version}), so nothing was published and no customers were notified.
      </p>
    );
  }
  const n = result.noticesWritten;
  return (
    <p className="policy__result" role="status">
      <b>Version {result.policy.version} published.</b> {n} {n === 1 ? 'customer' : 'customers'}{' '}
      notified. Notices go to the wallet bell only, at most one a day.
    </p>
  );
}

/* ----------------------------------------------------------- business hours */

/**
 * ==========================================================================
 * Settings → Business hours — WHERE THE HOURS ARE SHOWN, THEY ARE EDITED
 * ==========================================================================
 * Aftab, 2026-09-29: "Business hours should be editable and branch wise". This
 * card was display-only, and it was the one he saw; the per-branch editor lived
 * one card over, behind each row's "Hours" button.
 *
 * NOW ONE CARD ANSWERS BOTH. A selector — "Salon default" and each branch —
 * shows that scope's hours and opens that scope's editor:
 *
 *   Salon default → `SalonHoursEditor`, `PATCH /salons/{id}` with
 *     `{ businessHours }`. Writable server-side: `businessHours` is in
 *     `MERCHANT_EDITABLE` and `parseBusinessHours` validates it
 *     (api/src/routes/salons.ts). `SalonPatch` already admitted it; nothing in
 *     the dashboard had written it.
 *   A branch → `BranchHoursEditor`, THE SAME COMPONENT the Branches card opens,
 *     on `PATCH /salons/{id}/branches/{bid}` (migration 0063). Its "uses the
 *     salon's hours" answer is the server's `businessHoursSource`.
 *
 * THE SAME GATE AS THE BRANCH EDITOR, because it is the same permission on both
 * endpoints: `requireDashboardPerm(req, 'loyalty')`. This panel sits inside
 * `Settings`' `canEditSalon` block with the Branches card, which is the courtesy;
 * the server's refusal renders through each editor's own `WriteError` (#7).
 *
 * NO MUTATION HOOK AT THIS LEVEL. The editors own their writes and mount only
 * while open, so the read-only card renders without a query client — which is
 * what `settingsBranchHours.test.tsx` has always mounted it as.
 */
const SALON_SCOPE = 'salon';

export function BusinessHoursPanel({ salon }: { salon: Salon | undefined }) {
  const [scope, setScope] = useState<string>(SALON_SCOPE);
  const [editing, setEditing] = useState(false);
  const hours = salon?.businessHours;
  const branches = salon?.branches ?? [];
  /* A branch closed while it was selected falls back to the salon's, not to a blank. */
  const branch = scope === SALON_SCOPE ? null : (branches.find((b) => b.id === scope) ?? null);
  const shown = branch ? branch.businessHours : hours;

  return (
    <Card className="settings__card">
      <h2 className="settings__title avo-display">Business hours</h2>
      {salon === undefined || hours === undefined || shown === undefined ? (
        <Skeleton width="70%" height={16} />
      ) : (
        <>
          {branches.length > 0 ? (
            <div className="settings__hours-scope">
              <Select
                label="Hours for"
                size="sm"
                value={branch ? branch.id : SALON_SCOPE}
                options={[
                  { value: SALON_SCOPE, label: 'Salon default' },
                  ...branches.map((b) => ({ value: b.id, label: b.name })),
                ]}
                onChange={(e) => {
                  setScope(e.target.value);
                  setEditing(false);
                }}
              />
            </div>
          ) : null}

          {editing ? (
            branch ? (
              <BranchHoursEditor branch={branch} onClose={() => setEditing(false)} />
            ) : (
              <SalonHoursEditor salon={salon} onClose={() => setEditing(false)} />
            )
          ) : (
            <>
              {/*
                WHERE THIS BRANCH'S HOURS COME FROM, from `businessHoursSource`
                — the Branches card's rule, same reason: two identical sets can
                still be an override she chose to pin.
              */}
              {branch ? (
                <div className="settings__note settings__hours-source">
                  {branch.businessHoursSource === 'salon'
                    ? `${branch.name} uses the salon\u2019s hours.`
                    : `${branch.name} keeps its own hours.`}
                </div>
              ) : null}
              <HoursRows hours={shown} />
              {/*
                THE DESIGN'S SENTENCE, VERBATIM — AND ONLY WHERE IT IS TRUE. It
                describes the gap between two sittings. A salon open straight
                through (`evening` zero-length, the established spelling) has no
                afternoon closure, and telling her it does is the phantom evening
                in words.
              */}
              {isWindow(shown.morning) && isWindow(shown.evening) ? (
                <div className="settings__note">Afternoon closure — typical of Kuwait retail.</div>
              ) : null}
              <div className="settings__hours-actions">
                <Button
                  variant="secondary"
                  aria-label={
                    branch ? `Edit the hours for ${branch.name}` : 'Edit the salon\u2019s hours'
                  }
                  onClick={() => setEditing(true)}
                >
                  Edit hours
                </Button>
              </div>
            </>
          )}
          {/*
            The zone is not decoration. `businessHours` is naive wall clock; the
            same "10:00" resolves to a different instant per zone, and it is what
            artist windows and happy hours are measured against. Shown so a
            merchant can see which clock the salon runs on.
          */}
          {salon.timezone ? (
            <div className="settings__note">All times in {salon.timezone}.</div>
          ) : null}
        </>
      )}
    </Card>
  );
}

/**
 * THE SALON'S OWN HOURS. `PATCH /salons/{id}` with `{ businessHours }` —
 * `perms.loyalty`. Its own `useUpdateSalon` rather than `Settings`' shared one,
 * so its refusal renders here, under the hours, rather than at the foot of the
 * screen where `DepositPanel` and the receipt toggles report theirs.
 *
 * WHAT IT MOVES: every branch whose `businessHoursSource` is `salon`. The
 * server resolves that on the next read and the PATCH answer is the whole salon,
 * written into the cache (`api/settings.ts § useUpdateSalon`), so the Branches
 * card's "Using the salon's hours" rows follow from the server's answer.
 */
export function SalonHoursEditor({ salon, onClose }: { salon: Salon; onClose: () => void }) {
  const save = useUpdateSalon();
  const current = salon.businessHours;
  const draft = useHoursDraft(current);
  const changed = JSON.stringify(draft.next) !== JSON.stringify(current);

  return (
    <div className="settings__branch-editor" role="group" aria-label="The salon’s hours">
      <p className="settings__branch-editor-text">
        The salon&rsquo;s own hours. Every branch that does not keep its own uses these.
      </p>
      <HoursFields draft={draft} prefix="Salon" disabled={save.isPending} />
      <div className="settings__confirm-actions">
        <Button
          disabled={save.isPending || !changed}
          onClick={() => save.mutate({ businessHours: draft.next }, { onSuccess: onClose })}
        >
          {save.isPending ? 'Saving…' : 'Save hours'}
        </Button>
        <Button variant="quiet" disabled={save.isPending} onClick={onClose}>
          Cancel
        </Button>
      </div>
      {save.isError ? (
        <WriteError error={save.error} reassurance="The salon’s hours are unchanged." />
      ) : null}
    </div>
  );
}

/**
 * THE TWO SESSIONS, RENDERED THE WAY THE SERVER TRADES THEM. A branch's row line
 * reads through `describeHours` from the same module, so the rule cannot hold for
 * the salon and drift for a branch.
 *
 * A zero-length span (`to <= from`) is "no session", never "21:00 – 21:00".
 * `routes/businessHours.ts § isWindow` carries the argument. EXPORTED for
 * `settingsBranchHours.test.tsx`.
 */
export function HoursRows({ hours }: { hours: BusinessHours }) {
  const row = (span: Span, empty: string) => (
    <span className="settings__hours-value">
      {isWindow(span) ? (
        <>
          {span[0]} &ndash; {span[1]}
        </>
      ) : (
        <span className="settings__hours-none">{empty}</span>
      )}
    </span>
  );
  return (
    <>
      <div className="settings__hours-row">
        <span className="settings__hours-label">Morning</span>
        {row(hours.morning, 'No morning session')}
      </div>
      <div className="settings__hours-row settings__hours-row--divided">
        <span className="settings__hours-label">Evening</span>
        {row(hours.evening, 'No evening session')}
      </div>
    </>
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
/*
 * EXPORTED for `branchResponseParse.test.tsx`, which renders THIS panel rather
 * than a reproduction of it — the two receipts and the consequence list are the
 * subject, so a local copy of them would pin the copy in the test against the
 * copy in the test. `WhatsAppPanel` and `EmailReceiptsPanel` are exported for
 * the same reason.
 *
 * `useSession('merchant')` IS GONE FROM HERE, and it was dead: nothing in this
 * panel read it. It is a leftover of the client-side closure computation that
 * `useBranchClosurePreview` replaced, which gated its three reads on
 * `perms.team` / `perms.appointments` / `perms.dashboard`. Keeping it would have
 * forced this panel's test rig to stand up a session the panel does not consult,
 * which is a rig that misdescribes its subject.
 */
export function BranchesPanel({ salon }: { salon: Salon | undefined }) {
  const addBranch = useAddBranch();
  const closeBranch = useCloseBranch();
  const [newName, setNewName] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  /** The one branch whose hours editor is open, if any. One at a time, like the close sheet. */
  const [editingHours, setEditingHours] = useState<string | null>(null);
  /*
   * THE BRANCH NAME IS KEPT BESIDE THE RECEIPT, because the degraded receipt
   * needs one and the body that failed to parse is exactly the body that cannot
   * be asked for it. This is the name off the branch list she pressed ✕ on,
   * which is the name she is looking at.
   */
  const [closed, setClosed] = useState<{ name: string; closure: BranchClosure | null } | null>(
    null,
  );

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
                <span className="settings__branch-main">
                  <span className="settings__branch-name">{branch.name}</span>
                  {/*
                    WHERE THIS BRANCH'S HOURS COME FROM, from `businessHoursSource`
                    — the server resolves it, so this reads the answer rather than
                    comparing the branch's hours with the salon's (two identical
                    sets can still be an override she chose to pin).
                  */}
                  <span className="settings__branch-hours">
                    {branch.businessHoursSource === 'salon'
                      ? 'Using the salon\u2019s hours'
                      : `Own hours · ${describeHours(branch.businessHours)}`}
                  </span>
                </span>
                <span className="settings__branch-id">{branch.id}</span>
                <Button
                  variant="quiet"
                  aria-label={`Set the hours for ${branch.name}`}
                  aria-expanded={editingHours === branch.id}
                  onClick={() => setEditingHours(editingHours === branch.id ? null : branch.id)}
                >
                  Hours
                </Button>
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
                {editingHours === branch.id ? (
                  <BranchHoursEditor branch={branch} onClose={() => setEditingHours(null)} />
                ) : null}
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
                     `PATCH /salons/{id}/branches/{bid}` accepts `name`,
                     `nameAr` and `businessHours` (0063) and answers
                     `not_editable` to anything else — `closedAt` included. So a
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

                      {/*
                        PICKUP ORDERS WAITING HERE — migration 0060. A customer
                        chose this counter and has not collected yet. The close
                        does not touch her order: it stays on Shop → Orders,
                        flagged as at a closed branch. But nobody will be here to
                        hand it over, so this is a warning she reads BEFORE the
                        button, not a discovery she makes when the customer
                        arrives. `pickupOrdersWaiting` is parsed as a count
                        (`api/settings.ts § parseClosureShape`), so an unreadable
                        one blocks this sheet rather than reaching the reassuring
                        line below as 0.
                      */}
                      {impact.pickupOrdersWaiting > 0 ? (
                        <li className="settings__consequence--warn">
                          <b>
                            {impact.pickupOrdersWaiting} pickup order
                            {impact.pickupOrdersWaiting === 1 ? ' is' : 's are'} waiting at this
                            branch
                          </b>{' '}
                          — {impact.pickupOrdersWaiting === 1 ? 'it stays' : 'they stay'} on Shop →
                          Orders, marked as at a closed branch, and nobody will be here to hand{' '}
                          {impact.pickupOrdersWaiting === 1 ? 'it' : 'them'} over.
                        </li>
                      ) : (
                        <li>No pickup order is waiting here.</li>
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
                              setClosed({ name: branch.name, closure: result });
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
      {closed !== null && closed.closure !== null ? (
        <div className="settings__closed" role="status">
          <b>{closed.closure.name} is closed.</b>{' '}
          {closed.closure.staffRescoped.length > 0
            ? `Re-scoped ${closed.closure.staffRescoped.join(', ')}. `
            : 'No staff needed re-scoping. '}
          {closed.closure.staffLeftWithNoBranch.length > 0
            ? `${closed.closure.staffLeftWithNoBranch.join(', ')} now ${closed.closure.staffLeftWithNoBranch.length === 1 ? 'has' : 'have'} no branch access — fix that in Accounts → Team. `
            : ''}
          {closed.closure.tillsUnenrolled.length > 0
            ? `Unenrolled ${closed.closure.tillsUnenrolled.join(', ')} — set ${closed.closure.tillsUnenrolled.length === 1 ? 'it' : 'them'} up again at another branch under Tills. `
            : ''}
          {closed.closure.depositHeldBookings > 0
            ? `${closed.closure.depositHeldBookings} appointment${closed.closure.depositHeldBookings === 1 ? '' : 's'} still hold a deposit here. `
            : ''}
          {closed.closure.pickupOrdersWaiting > 0
            ? `${closed.closure.pickupOrdersWaiting} pickup order${closed.closure.pickupOrdersWaiting === 1 ? ' is' : 's are'} still waiting here — flagged on Shop → Orders.`
            : ''}
        </div>
      ) : null}

      {/*
        THE DEGRADED RECEIPT — the close committed and its summary could not be
        read. `api/settings.ts § useCloseBranch` carries the argument; what it
        comes to here is that this is the ONLY place in the product that will
        ever name the staff member who lost branch access, so silence is not the
        safe degradation it was for a booking whose status a refetch re-surfaces.

        THREE PROPERTIES, AND EACH ONE IS LOAD-BEARING:

        1. IT OPENS WITH THE FACT. "X is closed." — first, unqualified, in the
           same words as the receipt above it. Whatever else she does not learn,
           she must not leave this screen unsure whether the close happened.

        2. NO FAILURE LANGUAGE. `WriteError`'s sentences ("Something went wrong
           on our side.", "We couldn't reach the workspace.") and this panel's
           own reassurance ("That branch is still open.") are all false here, and
           the last one invites her to close it again. `role="status"`, not
           `role="alert"`: the same politeness level as the full receipt,
           because the outcome is the same outcome.

        3. IT SENDS HER WHERE THE TRUTH STILL IS. `useCloseBranch` invalidates
           `staffKeys.list` and `deviceKeys.list`, so Accounts → Team and Tills
           WILL show the real state on their next read — but only if she knows
           to look, which is precisely what the sentence she did not get would
           have told her. "may have" rather than "has": we did not read the
           body, so naming a consequence as certain would be inventing one.
      */}
      {closed !== null && closed.closure === null ? (
        <div className="settings__closed" role="status">
          <b>{closed.name} is closed.</b> We couldn&rsquo;t read the summary of what that
          changed. Check Accounts → Team for staff who may have been left with no branch
          access, Tills below for counters that may have been unenrolled, and Shop → Orders
          for pickup orders that may still be waiting there.
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

/* ------------------------------------------------------ a branch's own hours */

/**
 * ==========================================================================
 * Settings → Branches → Hours. W8, the merchant half.
 * ==========================================================================
 * A branch can keep its OWN hours or use the salon's — `PATCH
 * /salons/{id}/branches/{bid}` with `{ businessHours }` or `{ businessHours:
 * null }`, `perms.loyalty`, the gate this whole panel is already behind. What
 * customers do with them today: the wallet's pickup sheet says when to collect a
 * shop order at this counter.
 *
 * THE CONTROLS ARE THE TEAM HOURS EDITOR'S, NOT A SECOND VOCABULARY. When this
 * was written there was no salon-hours editor to reuse — `BusinessHoursPanel`
 * only displayed the salon's hours. There is one now (2026-09-29,
 * `SalonHoursEditor`), and it shares this editor's draft and fields
 * (`useHoursDraft`, `HoursFields`) rather than the other way round. The borrowed
 * idiom is still Team's: the `Stepper` per From/To in 30-minute steps, with the
 * same keyboard contract. The read-back — the row's "Own hours · …" line and the
 * salon's `HoursRows` — goes through `routes/businessHours.ts`, so the salon's
 * hours and a branch's obey one display rule.
 *
 * TWO SITTINGS, AND THE SECOND IS OPTIONAL. The Kuwaiti afternoon closure is the
 * norm, so the editor opens on two windows; switching "Evening session" off
 * writes the ESTABLISHED spelling of "no second sitting" — a zero-length evening
 * at the morning's close (`businessHours.ts § noEvening`) — because
 * `BusinessHoursSchema` has no other way to say it and `tradingSpans` already
 * drops such a span. A branch open straight through is therefore expressible,
 * and reads back as "No evening session" rather than a phantom "21:00 – 21:00".
 *
 * "USE THE SALON'S HOURS" SENDS `null`, and is offered only while the branch
 * has its own. The response carries the salon's hours back with `source:
 * 'salon'`, so the row then says "Using the salon's hours" from the server's
 * answer, not from this editor's assumption.
 *
 * NO OPTIMISTIC WRITE. The row changes when the PATCH answers, from the parsed
 * body (`api/settings.ts § useSetBranchHours`).
 */
const HOURS_STEP = 30;

/**
 * THE DRAFT BOTH HOURS EDITORS EDIT — the salon's and a branch's. Lifted out of
 * `BranchHoursEditor` when the Business hours card became an editor too, so the
 * two cannot come to disagree about what "no evening session" writes.
 */
function useHoursDraft(current: BusinessHours) {
  const [morning, setMorning] = useState<[number, number]>(() =>
    isWindow(current.morning)
      ? [hhmmToMinutes(current.morning[0]), hhmmToMinutes(current.morning[1])]
      : [10 * 60, 13 * 60],
  );
  const [eveningOn, setEveningOn] = useState(() => isWindow(current.evening));
  const [evening, setEvening] = useState<[number, number]>(() =>
    isWindow(current.evening)
      ? [hhmmToMinutes(current.evening[0]), hhmmToMinutes(current.evening[1])]
      : [16 * 60, 21 * 60],
  );

  const morningSpan: Span = [minutesToClock(morning[0]), minutesToClock(morning[1])];
  const next: BusinessHours = {
    morning: morningSpan,
    evening: eveningOn
      ? [minutesToClock(evening[0]), minutesToClock(evening[1])]
      : noEvening(morningSpan),
  };
  return { morning, setMorning, eveningOn, setEveningOn, evening, setEvening, next };
}

type HoursDraft = ReturnType<typeof useHoursDraft>;

/** The two sittings' steppers. `prefix` names them: "Salmiya morning opens at". */
function HoursFields({
  draft,
  prefix,
  disabled,
}: {
  draft: HoursDraft;
  prefix: string;
  disabled: boolean;
}) {
  const { morning, setMorning, eveningOn, setEveningOn, evening, setEvening } = draft;
  const stepper = (
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (v: number) => void,
  ) => (
    <Stepper
      size="sm"
      label={label}
      value={value}
      min={min}
      max={max}
      step={HOURS_STEP}
      format={(v) => minutesToClock(v)}
      valueText={minutesToClock(value)}
      disabled={disabled}
      onChange={onChange}
    />
  );

  return (
    <>
      <div className="settings__branch-editor-row">
        <span className="settings__hours-label">Morning</span>
        {stepper(`${prefix} morning opens at`, morning[0], 0, morning[1] - HOURS_STEP, (v) =>
          setMorning([v, morning[1]]),
        )}
        <span className="hours-row__arrow" aria-hidden="true">
          &rarr;
        </span>
        {stepper(
          `${prefix} morning closes at`,
          morning[1],
          morning[0] + HOURS_STEP,
          END_OF_DAY,
          (v) => setMorning([morning[0], v]),
        )}
      </div>

      <div className="settings__branch-editor-row">
        <Toggle
          label="Evening session"
          checked={eveningOn}
          disabled={disabled}
          onChange={setEveningOn}
        />
        {eveningOn ? (
          <>
            {stepper(
              `${prefix} evening opens at`,
              evening[0],
              0,
              evening[1] - HOURS_STEP,
              (v) => setEvening([v, evening[1]]),
            )}
            <span className="hours-row__arrow" aria-hidden="true">
              &rarr;
            </span>
            {stepper(
              `${prefix} evening closes at`,
              evening[1],
              evening[0] + HOURS_STEP,
              END_OF_DAY,
              (v) => setEvening([evening[0], v]),
            )}
          </>
        ) : (
          <span className="settings__hours-none">Open straight through — no second sitting.</span>
        )}
      </div>
    </>
  );
}

export function BranchHoursEditor({ branch, onClose }: { branch: Branch; onClose: () => void }) {
  const save = useSetBranchHours();
  const current = branch.businessHours;
  const own = branch.businessHoursSource === 'branch';
  const draft = useHoursDraft(current);
  const next = draft.next;
  /*
   * ON THE SALON'S HOURS, SAVING IS ALWAYS A CHANGE — it pins these hours to the
   * branch, even if they match the salon's today, so the salon's next edit no
   * longer moves this branch. With its own hours, only a real difference saves.
   */
  const changed = !own || JSON.stringify(next) !== JSON.stringify(current);

  return (
    <div className="settings__branch-editor" role="group" aria-label={`Hours for ${branch.name}`}>
      <p className="settings__branch-editor-text">
        {own ? (
          <>
            <b>{branch.name}</b> keeps its own hours.
          </>
        ) : (
          <>
            <b>{branch.name}</b> is using the salon&rsquo;s hours. Set its own here — the salon&rsquo;s
            hours stay as they are for every other branch.
          </>
        )}{' '}
        Customers see these hours when they collect a shop order here.
      </p>

      <HoursFields draft={draft} prefix={branch.name} disabled={save.isPending} />

      <div className="settings__confirm-actions">
        <Button
          disabled={save.isPending || !changed}
          onClick={() =>
            save.mutate({ branchId: branch.id, businessHours: next }, { onSuccess: onClose })
          }
        >
          {save.isPending && save.variables?.businessHours !== null ? 'Saving…' : 'Save hours'}
        </Button>
        {own ? (
          <Button
            variant="secondary"
            disabled={save.isPending}
            onClick={() =>
              save.mutate({ branchId: branch.id, businessHours: null }, { onSuccess: onClose })
            }
          >
            Use the salon&rsquo;s hours
          </Button>
        ) : null}
        <Button variant="quiet" disabled={save.isPending} onClick={onClose}>
          Cancel
        </Button>
      </div>

      {save.isError ? (
        <WriteError
          error={save.error}
          reassurance={`${branch.name}\u2019s hours are unchanged.`}
        />
      ) : null}
    </div>
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
