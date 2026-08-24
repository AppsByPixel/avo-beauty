/**
 * Wallet · Account.
 *
 * Opened from the header avatar on Home. Layout, spacing and copy from
 * design/AVO Wallet Home.dc.html:390-477 and its five sheets; the state
 * treatments from design/AVO States.dc.html.
 *
 * THE FOUR STATES ARE THE ONLY WAYS THIS RENDERS, same as Home:
 *
 *   loading   `useAccount` has no member yet → the skeleton, never a blank card
 *             with someone else's initial on it.
 *   ready     the screen.
 *   stale     the screen plus the banner — a refresh failed over data already up.
 *   offline   the screen plus the offline banner.
 *   error /   the failure screen. `blocked` gets no Try again, because retrying
 *   blocked   a 403 is not a plan.
 *
 * TWO SECTIONS HAVE A FIFTH STATE OF THEIR OWN, AND IT IS EMPTY:
 *
 *   policies  Non-negotiable #10. If `GET /v1/platform/policies` failed or
 *             returned no documents, the section renders nothing at all — no
 *             heading, no rows, and above all no bundled fallback text. This is
 *             the observable behaviour that proves the wallet holds no legal
 *             copy; see components/account/PolicySheet.tsx.
 *   support   Same shape for the same reason: no config, no Contact us row. The
 *             topic list decides which queue a message lands in (#11), and a
 *             form with no topics would either post nothing or post a guess.
 */

import { useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native';
import type { LegalDoc, Member } from '@avo/types';
import { color, MIN_TAP_TARGET, radius, text } from '../theme';
import { useLanguage } from '../i18n/language';
import { useAccount } from '../state/useAccount';
import {
  NOTIFICATION_KEYS,
  useNotificationPreferences,
  type NotificationKey,
} from '../state/notifications';
import { useDeletionState } from '../state/useDeletionState';
import { deletionSection } from '../domain/deletion';
import { salonName } from '../domain/names';
import { takeContactPrefill } from '../support/contact';
import { FailureScreen } from '../components/FailureScreen';
import { OfflineBanner, StaleBanner } from '../components/Banners';
import { SecondaryButton, TappableRow } from '../components/Buttons';
import { Toast, useToast } from '../components/Toast';
import { CardNote, SectionLabel, SettingsCard, SettingsRow, ToggleRow } from '../components/account/Rows';
import { PolicySheet } from '../components/account/PolicySheet';
import { ContactSheet } from '../components/account/ContactSheet';
import { EditProfileSheet } from '../components/account/EditProfileSheet';
import { ChangePasswordSheet } from '../components/account/ChangePasswordSheet';
import { DeleteAccountSheet } from '../components/account/DeleteAccountSheet';
import { DeletionScheduled } from '../components/account/DeletionScheduled';
import { FollowSalon } from '../components/account/FollowSalon';
import { AccountSkeleton } from '../components/account/AccountSkeleton';

interface Props {
  onBack: () => void;
  /**
   * Ends the session — a real server sign-out, not a local clear.
   *
   * THIS COMMENT WAS STALE FOR SEVERAL MERGES and was cited as authority for "the
   * wallet has no auth slice" while briefing other lanes. It read: "The wallet's
   * auth slice is not built — there is no login screen and `api/client.ts` sends
   * no bearer token — so App's implementation clears local state and returns
   * Home." Every clause was false: `SignInScreen` and `SignUpScreen` exist,
   * `client.ts` sends `authorization: Bearer`, and `App.tsx`'s handler awaits
   * `signOut()` before `clearLocalState()`.
   *
   * The implementation had been corrected and the comment had not, which is the
   * worse of the two failure modes: nothing was broken, so nothing failed, so
   * only a reader was misled.
   */
  onLogOut: () => void;
  /**
   * "I forgot my current password" → the WhatsApp reset-link flow.
   *
   * THE BLOCKER IS THE ENDPOINT, NOT THE SCREENS. This said the flow "lives on
   * the not-yet-built auth screens"; those screens are built. What does not exist
   * is a MEMBER password-reset endpoint — `api/src/routes/auth.ts` has
   * `/auth/staff/password-reset` and `/auth/platform/password-reset`, and
   * `/members/me/password` is a change that requires being signed in already.
   * So the gap is real and the behaviour below is still right; only the reason
   * was wrong, and a wrong reason sends the next reader to build the wrong half.
   *
   * api-contract.md rule 5 is explicit that this is a separate flow and NOT a way
   * around `current`.
   */
  onForgotPassword: () => void;
}

export function AccountScreen({ onBack, onLogOut, onForgotPassword }: Props) {
  const { lang, copy, setLang } = useLanguage();
  const account = useAccount();
  const notifications = useNotificationPreferences();
  const deletion = useDeletionState();
  const toast = useToast();

  const [profileOpen, setProfileOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [openDoc, setOpenDoc] = useState<LegalDoc | null>(null);

  /**
   * THE RECEIPT HANDOFF. "Report a problem with this payment" on a receipt calls
   * `startPaymentReport(reference)` and navigates here; this reads it once, on
   * mount, and opening Account any other way finds nothing pending.
   *
   * Taken in a lazy `useState` initialiser rather than an effect so it happens
   * before the first paint — an effect would render the sheet closed for a frame
   * and then pop it open, which reads as a glitch rather than as a destination.
   * `takeContactPrefill` clears as it reads, so returning to Account later does
   * not resurrect an old receipt number into the field.
   */
  const [prefill] = useState(() => takeContactPrefill());
  const [contactOpen, setContactOpen] = useState(prefill !== null);
  const [contactRef, setContactRef] = useState(prefill?.reference ?? '');

  const { status, data, failure } = account;

  // The four states the exit slot can show, decided in one place. See
  // domain/deletion.ts — an unknown read must never resolve to the ordinary row.
  const deletionView = deletionSection(deletion);

  if (status === 'loading' || (!data && account.refreshing)) {
    return (
      <Shell onBack={onBack}>
        <AccountSkeleton />
      </Shell>
    );
  }

  if (!data) {
    return (
      <Shell onBack={onBack} centered>
        <FailureScreen
          kind={failure?.kind ?? 'server'}
          message={failure?.message ?? copy.errorBody}
          reference={failure?.reference ?? '—'}
          onRetry={account.retry}
          retrying={account.refreshing}
        />
      </Shell>
    );
  }

  const { member, salon, policies, support } = data;
  const offline = status === 'offline';

  const openProfile = () => setProfileOpen(true);
  const onSaved = (updated: Member, message: string) => {
    account.applyMember(updated);
    setProfileOpen(false);
    toast.show(message);
  };

  /** Opened from the Help block, so no receipt is attached. */
  const openContact = () => {
    setContactRef('');
    setContactOpen(true);
  };

  const notificationRows: { key: NotificationKey; label: string; sub: string }[] = [
    { key: 'push', label: copy.nPush, sub: copy.nPushSub },
    { key: 'wa', label: copy.nWa, sub: copy.nWaSub },
    { key: 'remind', label: copy.nRemind, sub: copy.nRemindSub },
    { key: 'receipt', label: copy.nReceipt, sub: copy.nReceiptSub },
    { key: 'offers', label: copy.nOffers, sub: copy.nOffersSub },
  ];

  const docs = policies?.docs ?? [];

  return (
    <Shell
      onBack={onBack}
      memberId={member.id}
      overlay={
        <>
          <EditProfileSheet
            open={profileOpen}
            member={member}
            onClose={() => setProfileOpen(false)}
            onSaved={onSaved}
            onToast={toast.show}
          />
          <ChangePasswordSheet
            open={passwordOpen}
            onClose={() => setPasswordOpen(false)}
            onChanged={(message) => {
              setPasswordOpen(false);
              toast.show(message);
            }}
            onForgot={() => {
              setPasswordOpen(false);
              onForgotPassword();
            }}
          />
          <PolicySheet
            doc={openDoc}
            effectiveFrom={policies?.effectiveFrom ?? null}
            version={policies?.version ?? null}
            onClose={() => setOpenDoc(null)}
          />
          <ContactSheet
            open={contactOpen}
            config={support}
            memberEmail={member.email}
            memberPhone={member.phone}
            prefillRef={contactRef}
            onClose={() => setContactOpen(false)}
          />
          <DeleteAccountSheet
            open={deleteOpen}
            balanceFils={member.balanceFils}
            /**
             * Opened from the scheduled card, this has to be the cancel door
             * rather than the question — she has already answered it. Null when
             * nothing is pending, which is the normal path.
             */
            pending={deletion.state?.status === 'pending' ? deletion.state : null}
            onClose={() => setDeleteOpen(false)}
            /**
             * Re-read after anything that moves the state. The screen outside the
             * sheet has to agree with the server about whether a clock is running,
             * and a request or a cancel is exactly when it would stop agreeing.
             */
            onDeletionChanged={deletion.reload}
            onToast={toast.show}
          />
          <Toast message={toast.message} />
        </>
      }
    >
      {offline ? <OfflineBanner /> : null}
      {status === 'stale' && account.fetchedAt ? (
        <StaleBanner at={account.fetchedAt} onRetry={account.retry} />
      ) : null}

      <Text style={[text('displayM', lang), styles.screenTitle]}>{copy.accountTitle}</Text>

      {/* ------------------------------------------------------ profile card -- */}
      <View style={styles.profileCard} testID="profile-card">
        <View style={styles.avatar}>
          <Text style={styles.avatarInitial}>{member.name.trim().charAt(0)}</Text>
        </View>
        <View style={styles.profileText}>
          <Text numberOfLines={1} style={[text('displayS', lang), styles.profileName]}>
            {member.name}
          </Text>
          {/* design:403 — the phone is LTR in both languages. */}
          <Text numberOfLines={1} style={[text('bodyS', lang), styles.profilePhone]}>
            {member.phone}
          </Text>
        </View>
        <TappableRow
          onPress={openProfile}
          accessibilityRole="button"
          accessibilityLabel={copy.rowEdit}
          testID="profile-edit"
          style={styles.editBtn}
        >
          <Text style={[text('bodyS', lang), styles.editText]}>{copy.rowEdit}</Text>
        </TappableRow>
      </View>

      {/* ---------------------------------------------------------- profile -- */}
      <SectionLabel>{copy.acctProfile}</SectionLabel>
      <SettingsCard testID="profile-rows">
        <SettingsRow label={copy.rowName} value={member.name} onPress={openProfile} testID="row-name" />
        <SettingsRow
          label={copy.rowPhone}
          value={member.phone}
          ltrValue
          onPress={openProfile}
          testID="row-phone"
        />
        <SettingsRow
          label={copy.rowEmail}
          // design:1830 — the value is the prompt when there is no email yet.
          value={member.email ?? copy.rowAddEmail}
          ltrValue={member.email !== null}
          onPress={openProfile}
          testID="row-email"
        />
        {/*
          NON-NEGOTIABLE #6. The value column says "Change" and can never say
          anything else — there is no password on `Member`, no endpoint returns
          one, and nothing here has a value to render even by accident.
        */}
        <SettingsRow
          label={copy.rowPassword}
          value={copy.rowChange}
          onPress={() => setPasswordOpen(true)}
          testID="row-password"
        />
        <SettingsRow
          label={copy.rowLang}
          value={copy.rowLangValue}
          onPress={() => setLang(lang === 'en' ? 'ar' : 'en')}
          last
          testID="row-language"
        />
      </SettingsCard>

      {/* ---------------------------------------------------- notifications -- */}
      {/*
        THE READ FAILING IS NOT THE SAME AS THE SWITCHES BEING OFF. Five switches
        drawn from `DEFAULT_PREFERENCES` look exactly like her settings and are
        not — and one of them is marketing consent, so a wrong `offers` here is a
        wrong answer to a question that has legal weight. So a failed read shows
        the failure and a retry, and no switches at all.
      */}
      <SectionLabel>{copy.acctNotifs}</SectionLabel>
      {notifications.loadFailed ? (
        <SettingsCard testID="notification-error">
          <View style={styles.notifError}>
            <Text style={[text('body', lang), styles.notifErrorText]}>{copy.notifErr}</Text>
            <TappableRow
              onPress={notifications.reload}
              accessibilityRole="button"
              accessibilityLabel={copy.tryAgain}
              testID="notification-retry"
              style={styles.notifRetry}
            >
              <Text style={[text('bodyS', lang), styles.notifRetryText]}>{copy.tryAgain}</Text>
            </TappableRow>
          </View>
        </SettingsCard>
      ) : (
        <>
          <SettingsCard testID="notification-rows">
            {notificationRows.map((row, index) => (
              <ToggleRow
                key={row.key}
                label={row.label}
                sub={row.sub}
                value={notifications.prefs[row.key]}
                onToggle={() => notifications.toggle(row.key)}
                saving={notifications.saving.includes(row.key)}
                last={index === NOTIFICATION_KEYS.length - 1}
                testID={`toggle-${row.key}`}
              />
            ))}
          </SettingsCard>
          {/*
            The switch has already moved back by the time this renders — the hook
            reverts it. This says why it moved, so the revert does not read as the
            app ignoring her.
          */}
          {notifications.writeFailed ? (
            <CardNote testID="notification-save-error">{copy.notifSaveErr}</CardNote>
          ) : null}
        </>
      )}

      {/* ------------------------------------------------ wallet & policies -- */}
      {/*
        Rendered only when the API sent documents. Non-negotiable #10: delete the
        policy response and this whole block disappears, heading included. There
        is no `docs.length === 0 ? <DefaultTerms/> : …` branch, and there is not
        meant to be one.
      */}
      {docs.length > 0 ? (
        <>
          <SectionLabel>{copy.acctLegal}</SectionLabel>
          <SettingsCard testID="policy-rows">
            {docs.map((doc, index) => (
              <SettingsRow
                key={doc.id}
                label={lang === 'ar' && doc.title.ar.trim() ? doc.title.ar : doc.title.en}
                onPress={() => setOpenDoc(doc)}
                last={index === docs.length - 1}
                testID={`policy-${doc.id}`}
              />
            ))}
          </SettingsCard>
          {/*
            NOT a legal document — a plain-language summary of what the wallet is,
            which is why it is app copy and not a clause from the API. It makes no
            representation the published terms do not.
          */}
          <CardNote>{copy.walletFine}</CardNote>
        </>
      ) : null}

      {/* ------------------------------------------------------------- help -- */}
      {support ? (
        <>
          <SectionLabel>{copy.acctHelp}</SectionLabel>
          <SettingsCard testID="help-rows">
            <TappableRow
              onPress={openContact}
              accessibilityRole="button"
              accessibilityLabel={copy.contactCta}
              accessibilityHint={copy.contactCtaSub}
              testID="contact-open"
              style={styles.helpRow}
            >
              <View style={styles.helpText}>
                <Text style={[text('body', lang), styles.helpTitle]}>{copy.contactCta}</Text>
                <Text style={[text('bodyS', lang), styles.helpSub]}>{copy.contactCtaSub}</Text>
              </View>
            </TappableRow>
            <View style={styles.waRow}>
              <Text style={[text('body', lang), styles.rowLabel]}>{copy.cViaWa}</Text>
              {/* E.164, LTR in both languages — api-contract.md § SupportConfig. */}
              <Text style={[text('bodyS', lang), styles.waValue]} testID="support-whatsapp">
                {support.channels.whatsapp}
              </Text>
            </View>
          </SettingsCard>
          <CardNote>{lang === 'ar' ? support.channels.hoursAr : support.channels.hoursEn}</CardNote>
        </>
      ) : null}

      {/* ----------------------------------------------------------- follow -- */}
      {salon.social.some((s) => s.on && s.handle.trim()) ? (
        <>
          <SectionLabel>
            {/*
              Was an inline `lang === 'ar' && salon.nameAr ? … : …`. Same rule,
              fifth copy, and a fifth place for it to drift — `&&` also differs
              from `??` on an empty string, which only a CHECK constraint on
              `salon.name_ar` currently prevents from reaching a customer.
            */}
            {copy.followTitle(salonName(salon, lang))}
          </SectionLabel>
          <FollowSalon social={salon.social} />
        </>
      ) : null}

      {/* ------------------------------------------------------------- exit -- */}
      <SecondaryButton
        label={copy.logOut}
        onPress={onLogOut}
        style={styles.logOut}
        testID="log-out"
      />
      {/*
        THREE STATES, AND "DELETE MY ACCOUNT" IS ONLY ONE OF THEM.

        A deletion request outlives the sheet, so this slot has to be able to say
        so. Rendering the ordinary row while a deletion is pending is the bug this
        section exists to fix — she would see no sign of the clock and no route to
        the cancel door. Rendering it while the read has FAILED is the same bug
        with a different cause, so an unknown state says it is unknown rather than
        assuming `none`. See state/useDeletionState.ts.

        Nothing at all until the first answer: this is the bottom of a scrolling
        screen, so there is no layout to hold open, and a row that flips from
        "Delete my account" to "Deletion scheduled" a beat later has already made
        a false statement.
      */}
      {deletionView.kind === 'unknown' ? null : deletionView.kind === 'failed' ? (
        <View style={styles.deleteUnknown} testID="deletion-check-failed">
          <Text style={[text('bodyS', lang), styles.deleteUnknownText]}>
            {copy.deleteCheckFailed}
          </Text>
          <TappableRow
            onPress={deletion.reload}
            accessibilityRole="button"
            accessibilityLabel={copy.tryAgain}
            testID="deletion-check-retry"
            style={styles.deleteUnknownRetry}
          >
            <Text style={[text('bodyS', lang), styles.deleteUnknownRetryText]}>
              {copy.tryAgain}
            </Text>
          </TappableRow>
        </View>
      ) : deletionView.kind === 'scheduled' ? (
        <DeletionScheduled
          erasureDueAt={deletionView.erasureDueAt}
          onOpenCancel={() => setDeleteOpen(true)}
        />
      ) : (
        <TappableRow
          onPress={() => setDeleteOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={copy.deleteAcct}
          testID="delete-open"
          style={styles.deleteBtn}
        >
          <Text style={[text('bodyS', lang), styles.deleteText]}>{copy.deleteAcct}</Text>
        </TappableRow>
      )}

      <Text style={[text('bodyS', lang), styles.version]}>{copy.appVersion}</Text>
      <View style={styles.footerSpace} />
    </Shell>
  );
}

/**
 * The back row and the member id, which sit above every state — including the
 * failure one. A customer who cannot load her account still has to be able to
 * leave the screen.
 */
function Shell({
  children,
  onBack,
  memberId,
  centered,
  overlay,
}: {
  children: React.ReactNode;
  onBack: () => void;
  memberId?: string;
  centered?: boolean;
  overlay?: React.ReactNode;
}) {
  const { lang, copy } = useLanguage();
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.frame}>
        <View style={styles.topBar}>
          <TappableRow
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel={copy.back}
            testID="account-back"
            style={styles.backBtn}
          >
            <Text style={[text('bodyS', lang), styles.backText]}>{copy.back}</Text>
          </TappableRow>
          {memberId ? (
            <Text style={[text('bodyS', lang), styles.memberId]}>
              {copy.memberIdPrefix}
              {memberId}
            </Text>
          ) : null}
        </View>
        <ScrollView
          contentContainerStyle={[styles.scroll, centered && styles.scrollCentered]}
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
        {overlay}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  // The notifications read failed. Inside the same card the switches would have
  // occupied, so the section keeps its shape and its heading.
  notifError: { paddingVertical: 16, gap: 4 },
  notifErrorText: { color: color.ink },
  notifRetry: { alignSelf: 'flex-start', minHeight: MIN_TAP_TARGET, justifyContent: 'center' },
  notifRetryText: { color: color.brandDeep, fontWeight: '600' },
  frame: {
    flex: 1,
    width: '100%',
    maxWidth: 402,
    alignSelf: 'center',
    backgroundColor: color.surfaceAlt,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'web' ? 12 : 4,
  },
  backBtn: { minHeight: MIN_TAP_TARGET, justifyContent: 'center', paddingEnd: 8 },
  backText: { color: color.brandDeep, fontWeight: '600' },
  memberId: { color: color.textMutedSoft },
  scroll: { paddingHorizontal: 20, paddingBottom: 40 },
  scrollCentered: { flexGrow: 1, justifyContent: 'center' },

  screenTitle: { color: color.ink, fontSize: 26 },

  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    marginTop: 18,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.cardLg,
    padding: 16,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: radius.card,
    backgroundColor: color.brandTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The initial is a display-face letter in both languages — the design sets it
  // in Fraunces, and an Arabic initial falls through to the Arabic face at the
  // same size because Fraunces has no glyph for it.
  avatarInitial: {
    fontFamily: 'Fraunces_600SemiBold',
    fontWeight: '600',
    fontSize: 21,
    color: color.brandDeep,
  },
  profileText: { flex: 1, minWidth: 0 },
  profileName: { color: color.ink, fontSize: 18 },
  profilePhone: { color: color.textMuted, marginTop: 2, writingDirection: 'ltr' },
  editBtn: {
    minHeight: 38,
    justifyContent: 'center',
    backgroundColor: color.surfaceAlt2,
    borderRadius: radius.pill,
    paddingHorizontal: 15,
  },
  editText: { color: color.ink, fontWeight: '600' },

  rowLabel: { color: color.ink },
  helpRow: {
    minHeight: MIN_TAP_TARGET,
    justifyContent: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: color.hairlineInner,
  },
  helpText: { flex: 1, minWidth: 0 },
  helpTitle: { color: color.ink, fontWeight: '600' },
  helpSub: { color: color.textMuted, marginTop: 2, lineHeight: 18 },
  waRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: MIN_TAP_TARGET,
    paddingVertical: 15,
  },
  waValue: { color: color.textMutedSoft, writingDirection: 'ltr' },

  logOut: { marginTop: 22, backgroundColor: color.surface },
  deleteBtn: {
    marginTop: 10,
    minHeight: MIN_TAP_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
  },
  deleteText: { color: color.dangerText, fontWeight: '600' },
  // The read failed, so neither "Delete my account" nor "Deletion scheduled" can
  // be shown honestly. Same treatment as the notifications failure above.
  deleteUnknown: { marginTop: 14, gap: 4, alignItems: 'center' },
  deleteUnknownText: { color: color.textMutedLabel, textAlign: 'center', lineHeight: 18 },
  deleteUnknownRetry: {
    minHeight: MIN_TAP_TARGET,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  deleteUnknownRetryText: { color: color.brandDeep, fontWeight: '600' },
  version: { color: color.textMutedSoft, textAlign: 'center', marginTop: 6, fontSize: 11 },
  footerSpace: { height: 24 },
});
