/**
 * App shell.
 *
 * Fonts are loaded before anything renders. The design's display face is
 * Fraunces and its UI face is Inter (design/tokens/avo-tokens.json → font), and
 * a wallet card that flashes system-serif before swapping is worse than a beat
 * of blank canvas.
 *
 * IBM PLEX SANS ARABIC IS LOADED UNCONDITIONALLY, not on the language switch.
 *
 * Loading it lazily would mean the first Arabic frame renders in whatever the OS
 * substitutes and swaps a moment later — and a silent system substitution is
 * exactly the failure this is meant to prevent. It is four weights against a
 * one-off cost at startup, and the switch has to be instant on web because on
 * web it is instant (see src/i18n/language.tsx).
 *
 * `useFonts` returns true only once every named face has actually registered, so
 * a missing Arabic face fails visibly at startup rather than quietly falling back
 * at the moment somebody switches language.
 */

import { useFonts } from 'expo-font';
import {
  Fraunces_400Regular,
  Fraunces_400Regular_Italic,
  Fraunces_500Medium,
  Fraunces_600SemiBold,
} from '@expo-google-fonts/fraunces';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import {
  IBMPlexSansArabic_400Regular,
  IBMPlexSansArabic_500Medium,
  IBMPlexSansArabic_600SemiBold,
  IBMPlexSansArabic_700Bold,
} from '@expo-google-fonts/ibm-plex-sans-arabic';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MIN_TAP_TARGET, color, text } from './src/theme';
import { installFocusRing } from './src/theme/focus';
import { SNAPSHOT_KEY } from './src/state/cache';
import { PREFERENCES_KEY } from './src/state/notifications';
import { HomeScreen } from './src/screens/HomeScreen';
import { QrOverlay } from './src/components/QrOverlay';
import { paymentCodeView, type PaymentCodeView } from './src/domain/paymentCode';
import { enlargedCodeIsOpen, payTabAction } from './src/domain/payTab';
import { salonName } from './src/domain/names';
import { useWalletToken } from './src/state/useWalletToken';
import { AccountScreen } from './src/screens/AccountScreen';
import { BookScreen } from './src/screens/BookScreen';
import { ShopScreen } from './src/screens/ShopScreen';
import { SignInScreen } from './src/screens/SignInScreen';
import { SignUpScreen } from './src/screens/SignUpScreen';
import { ForgotPasswordScreen } from './src/screens/ForgotPasswordScreen';
import { signOut } from './src/api/auth';
import { refreshSession } from './src/api/client';
import { isSignedIn, onSessionEnded, restore } from './src/api/session';
import { bootDestination } from './src/domain/bootGate';
import { LanguageProvider, useCopy, useLanguage } from './src/i18n/language';
import { initialLanguage } from './src/i18n/initialLanguage';
import { useWalletHome } from './src/state/useWalletHome';
import type { WalletSnapshot } from './src/state/cache';
import { useShop } from './src/state/useShop';
import { Toast, useToast } from './src/components/Toast';
import { focusable } from './src/theme/focus';
import type { BookingView } from './src/api/booking';
import type { RescheduleTarget } from './src/state/useBooking';

/**
 * The four built screens.
 *
 * STILL NO ROUTER, and the prediction held. This said "when Shop and the auth
 * screens land, this union becomes a navigator and none of the screens' props
 * change" — both have now landed and none of them did. No deep links, no back
 * stack; a navigation container would still be machinery ahead of a need.
 *
 * PAY IS NOT IN THIS UNION, AND THAT IS THE DESIGN'S CALL RATHER THAN A GAP.
 * The note here used to read "the design's wallet has five destinations (home,
 * book, shop, pay, account)". It has four. design:627 binds the Pay button to
 * `openQr` (design:1905), which sets one flag and never touches `screen` — which
 * is exactly why design:1897 writes `navPayStyle: this.navStyle(false)` and the
 * tab can never render active. Pay is a layer over whichever screen she is on,
 * not a place to be. See `domain/payTab.ts`.
 */
type Screen = 'home' | 'book' | 'shop' | 'account';

// interaction-spec.md §2's focus ring, as real CSS. At module scope so the rule
// exists before the first control paints. Idempotent and a no-op off web.
installFocusRing();

export default function App() {
  const [fontsLoaded] = useFonts({
    Fraunces_400Regular,
    Fraunces_400Regular_Italic,
    Fraunces_500Medium,
    Fraunces_600SemiBold,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    // design/README.md § Typography — "IBM Plex Sans Arabic (400–700)".
    IBMPlexSansArabic_400Regular,
    IBMPlexSansArabic_500Medium,
    IBMPlexSansArabic_600SemiBold,
    IBMPlexSansArabic_700Bold,
  });

  if (!fontsLoaded) return <View style={styles.blank} />;

  return (
    <LanguageProvider initial={initialLanguage()}>
      <StatusBar style="dark" />
      <Gate />
    </LanguageProvider>
  );
}

/**
 * Signed in, or not. The wallet's first real gate — until now there was none,
 * because the app only ever spoke to the mock, which asks for no credentials.
 *
 * BOOT GOES THROUGH THE REFRESH, NOT AROUND IT. `restore()` brings back a refresh
 * token and deliberately no access token, so the only way into a working session
 * is `refreshSession()` — the same call a mid-session expiry makes. Boot is
 * therefore not a special case with its own bugs, and a session revoked from
 * another device is discovered before a screen renders rather than as a 401
 * underneath one.
 *
 * `checking` renders nothing rather than the wallet. A frame of Home with no data
 * would break the "never render 0.000 before data arrives" rule, and here it would
 * also be a frame of somebody's wallet shown to whoever is holding the phone.
 *
 * SIGNED OUT IS NOW TWO SCREENS, NOT ONE. `POST /auth/member/signup` landed, so
 * design:107's "New here? Create account" leads somewhere and the pre-auth pair
 * moves between themselves. `signUp` issues a session with its 201 exactly as
 * sign-in does, so BOTH doors land on `'in'` through the same call — there is no
 * separate post-registration path, and therefore no second way to get the session
 * handling wrong.
 *
 * The state is a screen name rather than a boolean because that is what the future
 * navigator will take, and because "out" was never one destination: a customer who
 * cannot get in is either an existing member or a new one.
 */
function Gate() {
  const [state, setState] = useState<'checking' | 'in' | 'signIn' | 'signUp' | 'forgot'>('checking');

  useEffect(() => {
    let alive = true;
    /*
      A session that ends while the app is open — a refresh that failed, or a
      revoke from another device — has to move the UI, not just clear a variable.
      Registered before the restore so an ending during boot is not missed.
    */
    onSessionEnded(() => {
      /*
        Sign-in, not signup. A session that ENDED belongs to somebody who has an
        account, so dropping her on Create account would ask her to register a
        number she already holds — and the endpoint would refuse it.
      */
      if (alive) setState('signIn');
    });

    void (async () => {
      const stored = await restore();
      if (!alive) return;
      /*
        `refreshSession()` returning false meant two different things and this
        used to read it as one: `setState(ok ? 'in' : 'signIn')`. A refresh the
        server REFUSED ends the session; a refresh we could not DELIVER does not,
        and sending her to sign-in for the second asks her to type a password to
        see a balance already sitting in storage.

        Driven, before the fix: a cold launch with the API unreachable deleted
        `avo.wallet.session.v1`, kept `avo.wallet.home.v1` beside it, and showed
        sign-in — so interaction-spec.md §4's offline Home, which exists to
        render exactly that cached snapshot with a "last updated" stamp, could
        never be reached on a cold start.

        `isSignedIn()` read AFTER the attempt is what tells them apart, because
        `client.ts § sessionWasRepudiated` now clears only on a 401/403.
        `domain/bootGate.ts` carries the rule and the spec.
      */
      // Not called at all with nothing restored: there is no token to exchange,
      // and `refreshSession()` answering false for a third distinct reason is
      // exactly the conflation this change exists to remove.
      const refreshed = stored === null ? false : await refreshSession();
      if (!alive) return;
      setState(
        bootDestination({
          hasStoredSession: stored !== null,
          refreshed,
          stillSignedIn: isSignedIn(),
        }),
      );
    })();

    return () => {
      alive = false;
      onSessionEnded(null);
    };
  }, []);

  if (state === 'checking') return <View style={styles.blank} />;
  if (state === 'signIn') {
    return (
      <SignInScreen
        onSignedIn={() => setState('in')}
        onCreateAccount={() => setState('signUp')}
        onForgotPassword={() => setState('forgot')}
      />
    );
  }
  if (state === 'forgot') {
    /*
      Reached from sign-in's "Forgot password?" (design:104) AND from Account →
      Change password → "I forgot my current password" (contract rule 5). One
      exit for both: sign-in. From the Account path that leaves a valid session
      behind by design — requesting a link revokes nothing; only REDEEMING one
      does, and it revokes every session at once — so landing on sign-in is not
      a sign-out, it is where someone who cannot remember her password goes
      next.
    */
    return <ForgotPasswordScreen onBack={() => setState('signIn')} />;
  }
  if (state === 'signUp') {
    return (
      <SignUpScreen onSignedUp={() => setState('in')} onLogIn={() => setState('signIn')} />
    );
  }
  return <Wallet onSignedOut={() => setState('signIn')} onForgotPassword={() => setState('forgot')} />;
}

/**
 * The shell, inside the language provider so the nav labels can read copy.
 *
 * THE WALLET SNAPSHOT IS READ ONCE, HERE, AND HANDED DOWN.
 *
 * Home and Book both need the member and the salon, and both can move money —
 * Book holds a deposit, Home cancels one and gets it back. Two `useWalletHome()`
 * instances would be two balances, and the one on screen would be whichever
 * screen happened to mount last. One state, one balance, and a `retry()` after
 * every money move — non-negotiable #2: the new balance is the server's answer
 * to `GET /members/me`, never a figure this app computed.
 */
function Wallet({
  onSignedOut,
  onForgotPassword,
}: {
  onSignedOut: () => void;
  /** Contract rule 5 — pwForgot drops into the reset-link flow, owned by App. */
  onForgotPassword: () => void;
}) {
  const [screen, setScreen] = useState<Screen>('home');
  const [reschedule, setReschedule] = useState<RescheduleTarget | null>(null);
  const home = useWalletHome();
  const toast = useToast();
  /**
   * THE CART LIVES HERE, NOT IN THE SHOP SCREEN, and that reverses an earlier call
   * of mine — recorded rather than quietly changed.
   *
   * `useShop` was mounted BY `ShopScreen`, which is tidier and wrong for two
   * reasons that only appeared on driving it:
   *
   *   1. HER CART EMPTIED WHEN SHE LEFT THE TAB. Tapping Home to check a balance
   *      unmounted the screen and took the cart with it. Nothing in the design
   *      suggests a cart that survives only while you look at it.
   *   2. THE NAV BADGE COULD NOT EXIST. design:626 draws the count on the Shop tab
   *      as well as in the Shop header, and a nav rendered by this shell cannot
   *      read state owned by a child. I had written that the badge's absence was
   *      better than hoisting a cart into the shell "unless something outside Shop
   *      ever needs it" — the nav is outside Shop, and it does.
   *
   * So the cart is app state for exactly the reason the wallet snapshot is: two
   * owners would be two carts, and the one on screen would be whichever mounted
   * last. Same shape as `home`, passed down as a prop.
   *
   * The balance is read from the snapshot when it exists and 0 before it does. That
   * only feeds the CTA label, and `ShopScreen` is not rendered without a snapshot
   * anyway — so no button is ever labelled against a balance we do not have.
   */
  const shop = useShop(snapshotBalance(home.snapshot), home.retry);

  /**
   * THE PAYMENT CODE LIVES IN THE SHELL, FOR THE SAME REASON THE CART DOES.
   *
   * It used to live in `HomeScreen`, which was right while Home was the only way
   * to reach it. design:627's Pay tab is the second way, and the design opens it
   * WITHOUT navigating — `openQr` (design:1905) sets `qrOpen` and leaves `screen`
   * alone, so the enlarged code comes up over Shop and over Book. A token owned
   * by Home is unmounted on both of those tabs; an overlay owned by Home cannot
   * be opened from a screen Home is not on.
   *
   * So one token, one `PaymentCodeView`, one `enlarged`, here. Two of anything
   * would be two answers to "may a QR be on the screen right now", and the one
   * that decided it would be whichever component happened to be mounted.
   *
   * Non-negotiable #2 is untouched by the move: nothing here mints, extends or
   * re-derives a token. `useWalletToken` asks the server and counts down to the
   * expiry the SERVER set, exactly as it did one level down.
   */
  const codeEnabled = home.status === 'ready' || home.status === 'stale';
  const walletToken = useWalletToken(codeEnabled && home.snapshot !== null);
  const codeView = paymentCodeView({
    token: walletToken.token,
    unavailable:
      home.status === 'offline' ? 'offline' : walletToken.failed ? 'failed' : null,
  });
  /**
   * WHETHER THE ENLARGED CODE IS UP, AND WHY IT IS A DERIVATION AND NOT A FLAG.
   *
   * `payRequested` is only ever "she asked". Whether anything OPENS is
   * `enlargedCodeIsOpen`, which ands that request with `codeView.canEnlarge` —
   * so §4's suppression is not something this component can be talked out of.
   * The whole account is in `domain/payTab.ts`; the short version is that trunk
   * mutated the handler below to `if (true)` and the suite stayed green, and a
   * property that survives only because nobody edited a line is not enforced.
   *
   * This replaces `useEffect(() => { if (!canEnlarge) setEnlarged(false) })`.
   * The effect closed a live overlay one render AFTER the code went stale;
   * derivation closes it in the same render. The effect that remains drops the
   * REQUEST, so that a code which comes back does not pop the overlay open again
   * without her asking — a convenience, not the guard.
   */
  const canEnlarge = codeView.canEnlarge;
  const [payRequested, setPayRequested] = useState(false);
  useEffect(() => {
    if (!canEnlarge) setPayRequested(false);
  }, [canEnlarge]);

  const goHome = useCallback(() => {
    setScreen('home');
    setReschedule(null);
  }, []);

  /**
   * design:627 — the Pay tab. ONE decision, taken in `domain/payTab.ts` from the
   * same `codeView` the panel on Home reads, so the tab cannot acquire its own
   * opinion about when a QR may be shown.
   *
   * `home` is the fallback rather than a dead tap or a disabled tab: §4 says the
   * QR is hidden and says nothing about what a Pay affordance does while it is,
   * and the design's prototype has no offline state to copy. Home is where the
   * app already explains itself — `qrOfflineTitle` / `qrFailedTitle` sit on the
   * payment-code panel in the design's own words. Flagged for DECISIONS.md; this
   * is the minimum honest answer, not a settled one.
   *
   * Read once into `action` and applied twice, rather than branched on twice:
   * the two arms are the two halves of ONE answer and must not be able to
   * disagree with each other.
   */
  const onPay = () => {
    const action = payTabAction(codeView);
    setPayRequested(action === 'enlarge');
    if (action === 'home') goHome();
  };

  const startReschedule = useCallback((booking: BookingView) => {
    setReschedule({ booking, artistId: booking.artistId, serviceId: booking.serviceId });
    setScreen('book');
  }, []);

  const snapshot = home.snapshot;

  /**
   * Home, as ONE element rather than three near-copies.
   *
   * It is rendered in three places — as the Home tab, and as what stands in for
   * Book and for Shop until the snapshot they need arrives — and the three had
   * already drifted (two of them forgot to clear `reschedule`). Four more props
   * for the payment code would have been four more chances to drift, so they are
   * written once.
   */
  const homeScreen = (
    <HomeScreen
      home={home}
      onOpenAccount={() => setScreen('account')}
      onBook={() => {
        setReschedule(null);
        setScreen('book');
      }}
      onReschedule={startReschedule}
      onToast={toast.show}
      codeView={codeView}
      codeSecondsRemaining={walletToken.secondsRemaining}
      /*
        design:254 and design:627 are the same handler (`openQr`), so the panel's
        tap is the same REQUEST the Pay tab makes — and it passes the same gate
        at the prop below. It is reached only from the `ready` panel, so it never
        asks for what is not there anyway.
      */
      onEnlargeCode={() => setPayRequested(true)}
      onRetryCode={walletToken.refresh}
    />
  );

  return (
    <View style={styles.root}>
      <View style={styles.body}>
        {screen === 'home' && homeScreen}

        {/*
          Book needs the salon (its timezone, its deposit, its booking module)
          and the member (her tier, for the top-up sheet's bonus row). Until the
          snapshot lands there is nothing to draw it from, so Home stays up with
          its skeletons rather than Book rendering a frame around a salon it
          does not have.
        */}
        {screen === 'book' &&
          (snapshot ? (
            <BookScreen
              salon={snapshot.salon}
              member={snapshot.member}
              onHome={goHome}
              onBooked={home.retry}
              reschedule={reschedule ?? undefined}
              onToast={toast.show}
            />
          ) : (
            homeScreen
          ))}

        {/*
          Shop needs her BALANCE, and only for the cart's CTA label — the server
          prices the order and refuses a client-supplied price by name. Until the
          snapshot lands there is no balance to label a button with, so Home stays
          up with its skeletons rather than Shop rendering "Pay 0.000 from wallet".

          `onPaid` is `home.retry`, not a figure: an order answers
          `balanceAfterFils` and this app deliberately does not carry it across.
          Non-negotiable #2 — the balance on screen is the server's answer to
          `GET /members/me`.
        */}
        {screen === 'shop' &&
          (snapshot ? (
            <ShopScreen
              shop={shop}
              balanceFils={snapshot.member.balanceFils}
              tier={snapshot.member.tier}
              /*
                FOR THE INVOICE'S BRANCH ROW — the same argument Home passes
                `TransactionSheet`. Shop renders only inside this `snapshot`
                branch, so it is never a placeholder.
              */
              branches={snapshot.salon.branches}
              /*
                `onToast` USED TO BE HERE and is gone with the paid toast. The
                invoice replaced it: `Toast` is zIndex 40 over `Sheet`'s 30, so
                firing both would paint the toast across the receipt's rows.
                See `ShopScreen`'s header.
              */
              onReport={() => setScreen('account')}
              /*
                THIS USED TO BE `onTopUp={goHome}`, and that was the whole of the
                cart's top-up: switch to the Home tab, close the cart, open
                nothing. Shop now owns a `TopUpSheet` the way Book does, so what
                the shell owes it is the balance re-read — `home.retry`, the same
                callback `useShop` already gets as `onPaid`.
              */
              onToppedUp={home.retry}
            />
          ) : (
            homeScreen
          ))}

        {screen === 'account' && (
          <AccountScreen
          onBack={() => setScreen('home')}
          /**
           * THERE IS NO SESSION TO END YET, AND THE BUTTON SAYS SO BY DOING THE
           * ONE REAL THING AVAILABLE.
           *
           * The wallet has no auth slice: no login screen, and `api/client.ts`
           * sends no bearer token — it reads an implicitly-authenticated mock.
           * So "log out" cannot revoke anything. What it CAN honestly do is drop
           * the local copies of this customer's data — the cached wallet
           * snapshot and the notification preferences — and return to a cold
           * Home, which is the part of logging out that protects the next person
           * to pick up the phone.
           *
           * When the auth slice lands this also calls POST /auth/sign-out, which
           * already exists on the API. Reported.
           */
          /*
            A REAL SIGN-OUT NOW, AND THE ORDER MATTERS.

            This used to clear two AsyncStorage keys and navigate Home, because
            there was no session to end — the comment on AccountScreen's prop said
            so. It now revokes server-side first (`POST /auth/sign-out`), then
            forgets the tokens, then drops the cached snapshot and preferences.

            Revoking first is the part that matters on a salon counter: this app's
            refresh token is recoverable from an unlocked handset (see
            api/session.ts), so forgetting it locally without revoking would leave
            a working credential on a phone the customer believes she has signed
            out of.

            `clearLocalState` still runs, and still last: the snapshot holds her
            balance and her recent activity, and a signed-out device must not keep
            them.
          */
          onLogOut={() => {
            void (async () => {
              await signOut();
              await clearLocalState();
              onSignedOut();
            })();
          }}
          /**
           * REAL NOW. The paragraph that stood here traced this handler's
           * history: first blocked on "the not-yet-built auth screens" (wrong
           * reason), then on the missing member endpoint (right reason,
           * reported). `POST /auth/member/password-reset/request` landed
           * (api/src/routes/auth.ts:835), so the link finally does what
           * contract rule 5 always specified: drops into the reset-link flow,
           * NOT a bypass of `current` — the sheet stays locked and the flow is
           * a different screen entirely.
           */
            onForgotPassword={onForgotPassword}
          />
        )}
      </View>

      {/*
        design:622-628 — the bottom navigation.

        FOUR BUTTONS NOW, WHICH IS WHAT THE DESIGN DRAWS, AND THE NOTE THAT USED
        TO STAND HERE WAS WRONG ON ITS FACTS. It read: "Pay is still not a tab …
        it opens the QR overlay, which lives on the wallet card and already has a
        tap target there. A tab that duplicates a control one screen up is
        clutter, not a destination."

        Two things were wrong with that. design:627 draws the button, and
        design:1233/1340 name it in both languages — so it was drift, not a
        decision, and no DECISIONS.md entry ever covered it. And "one screen up"
        is the whole point: the wallet card's tap target is on HOME. From the
        Shop tab, at a counter, there was no way to the payment code at all
        without navigating away first. The design's own handler says as much —
        `openQr` opens the overlay and never touches `screen`.

        It is correct that Pay is not a DESTINATION, and that half survives: it
        renders inactive always (design:1897) and `Screen` has no 'pay' member.

        Hidden on Account, which the design pushes as a full screen with its own
        back control rather than as a tab. The design does show the nav there;
        this is a deliberate, pre-existing deviation, and its one new consequence
        is that Pay is unreachable from Account. Reported, not changed here.
      */}
      {screen !== 'account' ? (
        <BottomNav
          screen={screen}
          cartCount={shop.count}
          onHome={goHome}
          onBook={() => {
            setReschedule(null);
            setScreen('book');
          }}
          onShop={() => {
            setReschedule(null);
            setScreen('shop');
          }}
          onPay={onPay}
        />
      ) : null}

      {/*
        design:641-643 — the enlarged payment code, a sibling of the whole shell
        rather than of Home's ScrollView, because design:627 opens it from Shop
        and Book too. The design puts it at the same level: its `qrOpen` block
        sits outside every screen's `sc-if`, so the scrim covers the nav as well.

        `codeView.kind` is the only gate, exactly as it was inside Home. There is
        no render path that produces an overlay without a server-issued token to
        put in it, and offline never has one — interaction-spec.md §4.
      */}
      <PaymentCodeLayer
        codeView={codeView}
        snapshot={snapshot}
        /*
          THE GUARD IS HERE, AT THE PROP, and it is `domain/payTab.ts`'s to give.
          Not `payRequested` — that is only "she asked". §4's suppression is
          anded in at the moment of rendering, so no handler above can open a
          code this app is not allowed to show. See `enlargedCodeIsOpen`.
        */
        open={enlargedCodeIsOpen(payRequested, codeView)}
        secondsRemaining={walletToken.secondsRemaining}
        onClose={() => setPayRequested(false)}
      />

      <Toast message={toast.message} />
    </View>
  );
}

/**
 * The enlarged payment code, at the shell's level — design:641-643.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY IT IS A COMPONENT AND NOT SIX LINES OF JSX IN `Wallet`.
 *
 * It needs the reading language, to name the salon with `salonName()`. Calling
 * `useLanguage()` in `Wallet` would subscribe the entire shell — every screen,
 * the nav, the cart — to a context it only needs for one string, and a hook
 * cannot be called inside the `codeView.kind === 'ready'` branch that guards the
 * overlay. So the read happens here, below the guard's own component boundary.
 *
 * THE FRAME IS LOAD-BEARING, AND GETTING IT WRONG COST THE SCRIM. `QrOverlay`
 * positions itself absolutely against its parent, and `styles.root` is the whole
 * window: on a desktop browser the scrim would span the viewport while the wallet
 * sits in a 402pt column, which is not what design:641 draws — its overlay is
 * inside the phone. The first attempt at that constraint measured zero pixels
 * high and took the backdrop with it; `styles.overlayLayer` carries the whole
 * account. Both wrappers are `box-none` so they capture nothing when the overlay
 * is closed and `QrOverlay` has returned null.
 *
 * `codeView.kind` is the ONLY gate, and it is the same value the panel on Home
 * renders from — see `domain/payTab.ts` for why that sharing is the point.
 * ═════════════════════════════════════════════════════════════════════════════
 */
function PaymentCodeLayer({
  codeView,
  snapshot,
  open,
  secondsRemaining,
  onClose,
}: {
  codeView: PaymentCodeView;
  snapshot: WalletSnapshot | null;
  open: boolean;
  secondsRemaining: number;
  onClose: () => void;
}) {
  const { lang } = useLanguage();
  if (codeView.kind !== 'ready' || !snapshot) return null;
  return (
    <View style={styles.overlayLayer} pointerEvents="box-none">
      <View style={styles.overlayFrame} pointerEvents="box-none">
        <QrOverlay
          open={open}
          token={codeView.token}
          memberId={snapshot.member.id}
          secondsRemaining={secondsRemaining}
          salonLabel={salonName(snapshot.salon, lang)}
          onClose={onClose}
        />
      </View>
    </View>
  );
}

/**
 * The balance the cart's CTA is labelled against, or 0 before the snapshot lands.
 *
 * A LABEL INPUT ONLY. The server prices the order and refuses a client-supplied
 * price by name, so this never decides what is charged — and `ShopScreen` is not
 * rendered without a snapshot, so no button is ever labelled against this 0.
 */
function snapshotBalance(snapshot: { member: { balanceFils: number } } | null): number {
  return snapshot?.member.balanceFils ?? 0;
}

/** design:623-627 — the four buttons, with the design's own glyphs. */
function BottomNav({
  screen,
  cartCount,
  onHome,
  onBook,
  onShop,
  onPay,
}: {
  screen: Screen;
  /** design:626 — the count on the Shop tab. 0 renders no badge. */
  cartCount: number;
  onHome: () => void;
  onBook: () => void;
  onShop: () => void;
  /** design:627 — opens the payment code. Not a destination; see `onPay`. */
  onPay: () => void;
}) {
  const { lang, copy } = useLanguage();
  return (
    <View style={styles.nav}>
      <NavItem
        label={copy.navHome}
        active={screen === 'home'}
        onPress={onHome}
        testID="nav-home"
        lang={lang}
        icon={
          <Path
            d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z"
            stroke="currentColor"
            strokeWidth={1.7}
            strokeLinejoin="round"
          />
        }
      />
      <NavItem
        label={copy.navBook}
        active={screen === 'book'}
        onPress={onBook}
        testID="nav-book"
        lang={lang}
        icon={
          <>
            <Rect x={4} y={5.5} width={16} height={15} rx={2.5} stroke="currentColor" strokeWidth={1.7} />
            <Path
              d="M4 9.5h16M8.5 3.5v4M15.5 3.5v4"
              stroke="currentColor"
              strokeWidth={1.7}
              strokeLinecap="round"
            />
          </>
        }
      />
      {/* design:626 — the bag glyph, with the count the design puts on this tab. */}
      <NavItem
        label={copy.navShop}
        active={screen === 'shop'}
        onPress={onShop}
        testID="nav-shop"
        lang={lang}
        badge={cartCount}
        icon={
          <>
            <Path d="M6 8h12l-1 12.5H7z" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" />
            <Path d="M9 8.5V6a3 3 0 0 1 6 0v2.5" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" />
          </>
        }
      />
      {/*
        design:627 — the QR glyph, traced rect for rect from the design's own svg.

        `active` IS A LITERAL false, not `screen === 'pay'`, and that is the
        design's rule rather than a placeholder: design:1897 writes
        `navPayStyle: this.navStyle(false)` where the other three are computed
        from `s.screen`. It opens a layer; there is no screen for it to be on, so
        it never lights up.

        And it is announced as a BUTTON, not a tab. The other three are tabs and
        one of them is always selected; this one opens the enlarged payment code
        over whatever is already there. "Pay, tab, not selected", forever, would
        describe a broken tab rather than a working button. The design's markup
        is a `<button>` for all four; here the platform draws the distinction the
        design's HTML could not.
      */}
      <NavItem
        label={copy.navPay}
        active={false}
        role="button"
        onPress={onPay}
        testID="nav-pay"
        lang={lang}
        icon={
          <>
            <Rect x={4} y={4} width={7} height={7} rx={1.5} stroke="currentColor" strokeWidth={1.7} />
            <Rect x={4} y={14} width={7} height={6} rx={1.5} stroke="currentColor" strokeWidth={1.7} />
            <Rect x={14} y={4} width={6} height={7} rx={1.5} stroke="currentColor" strokeWidth={1.7} />
            <Path
              d="M14 15h3v5M20 15v5"
              stroke="currentColor"
              strokeWidth={1.7}
              strokeLinecap="round"
            />
          </>
        }
      />
    </View>
  );
}

function NavItem({
  label,
  active,
  onPress,
  icon,
  testID,
  lang,
  badge,
  role = 'tab',
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  icon: React.ReactNode;
  testID: string;
  lang: 'en' | 'ar';
  /** design:626 — a count over the glyph. Absent or 0 renders nothing. */
  badge?: number;
  /**
   * design:627's Pay button is the one entry that is not a destination — it
   * opens the payment code over the current screen. `selected` is meaningless
   * for it and would announce as permanently unselected, so it is a button.
   */
  role?: 'tab' | 'button';
}) {
  // Brand text and brand glyphs on a light surface are `brandDeep`, never
  // `brand` — non-negotiable #9.
  const tint = active ? color.brandDeep : color.textMuted;
  const copy = useCopy();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={role}
      accessibilityState={role === 'tab' ? { selected: active } : undefined}
      accessibilityLabel={label}
      dataSet={focusable}
      testID={testID}
      style={styles.navItem}
    >
      <View>
        <Svg width={23} height={23} viewBox="0 0 24 24" fill="none" color={tint}>
          {icon}
        </Svg>
        {/*
          design:626 — brandDeep because the digits on it are white (#9), and the
          count goes through the copy layer so Arabic renders it Eastern.
        */}
        {badge !== undefined && badge > 0 ? (
          <View style={styles.navBadge} testID={`${testID}-badge`}>
            <Text style={[text('bodyS', lang), styles.navBadgeText]}>{copy.qtyValue(badge)}</Text>
          </View>
        ) : null}
      </View>
      <Text style={[text('bodyS', lang), { color: tint, fontWeight: '600', fontSize: 10.5 }]}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Drops every device-local copy of the customer's data. See `onLogOut`.
 *
 * The keys are imported rather than restated: a cache key that drifts from the
 * module that owns it leaves data behind after a log-out, which is the one
 * failure mode this function exists to prevent.
 */
async function clearLocalState(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([SNAPSHOT_KEY, PREFERENCES_KEY]);
  } catch {
    // Nothing to recover: the screen has already navigated away.
  }
}

const styles = StyleSheet.create({
  blank: { flex: 1, backgroundColor: color.canvas },
  root: { flex: 1, backgroundColor: color.canvas },
  body: { flex: 1 },
  nav: {
    // design:623 — the nav is part of the phone frame, so it is centred at the
    // same 402pt as the screens above it rather than spanning a desktop window.
    width: '100%',
    maxWidth: 402,
    alignSelf: 'center',
    // Already a LOGICAL direction: Yoga reverses a `row` under I18nManager.isRTL
    // and CSS lays one along the inline axis, so the four buttons run right to
    // left in Arabic with no conditional. See src/i18n/rtl.ts.
    flexDirection: 'row',
    // design:623 — `justify-content:space-between`. This was `space-around`
    // while the nav held two, then three, buttons; with the design's own four it
    // is the design's own value, which anchors Home and Pay to the 22pt padding
    // edges instead of floating everything inward.
    justifyContent: 'space-between',
    paddingTop: 9,
    paddingBottom: 20,
    paddingHorizontal: 22,
    borderTopWidth: 1,
    borderTopColor: color.hairline,
    backgroundColor: color.surface,
  },
  /*
    The layer the enlarged payment code is positioned against — see
    `PaymentCodeLayer`. TWO views, and the first draft was one.

    That draft was `position:absolute; top:0; bottom:0; width:'100%';
    maxWidth:402; alignSelf:'center'` — reasoning that leaving the inline insets
    alone would let `alignSelf` centre the column. It measured 402pt wide and
    ZERO HIGH, sitting at the vertical midpoint, so the scrim vanished: the card
    still drew (it is centred by its own parent) but the design's
    `rgba(20,21,17,0.55)` backdrop painted nothing, and an enlarged payment code
    appeared over the Shop screen with the products still legible around it.

    An absolutely-positioned child of a flex container gets its position from
    both the insets and the alignment properties, and the two do not compose the
    way "top and bottom are 0 so it stretches" assumes. So the stretch and the
    width limit are separated: the outer layer is a plain inset-0 fill, and the
    inner one is an ordinary flex child that `alignItems` centres in the same
    402pt column the nav and the screens use.

    `box-none` on both: with the overlay closed `QrOverlay` returns null and
    these two must not sit over the app swallowing taps.
  */
  overlayLayer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
  },
  overlayFrame: { flex: 1, width: '100%', maxWidth: 402 },
  navBadge: {
    position: 'absolute',
    top: -5,
    right: -8,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: color.brandDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navBadgeText: { color: color.white, fontWeight: '700', fontSize: 9.5 },
  navItem: {
    minWidth: MIN_TAP_TARGET,
    minHeight: MIN_TAP_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: 12,
  },
});
