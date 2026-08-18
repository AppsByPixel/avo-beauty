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
import { AccountScreen } from './src/screens/AccountScreen';
import { BookScreen } from './src/screens/BookScreen';
import { SignInScreen } from './src/screens/SignInScreen';
import { SignUpScreen } from './src/screens/SignUpScreen';
import { signOut } from './src/api/auth';
import { refreshSession } from './src/api/client';
import { onSessionEnded, restore } from './src/api/session';
import { LanguageProvider, useLanguage } from './src/i18n/language';
import { initialLanguage } from './src/i18n/initialLanguage';
import { useWalletHome } from './src/state/useWalletHome';
import { Toast, useToast } from './src/components/Toast';
import { focusable } from './src/theme/focus';
import type { BookingView } from './src/api/booking';
import type { RescheduleTarget } from './src/state/useBooking';

/**
 * The three built screens.
 *
 * STILL NO ROUTER. The design's wallet has five destinations (home, book, shop,
 * pay, account) plus the auth set, and that is a router's job — but a navigation
 * container and a set of typed route params for three screens with no deep
 * links and no back stack is machinery ahead of a need. The seam has not moved:
 * when Shop and the auth screens land, this union becomes a navigator and none
 * of the screens' props change.
 */
type Screen = 'home' | 'book' | 'account';

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
  const [state, setState] = useState<'checking' | 'in' | 'signIn' | 'signUp'>('checking');

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
      if (stored === null) {
        setState('signIn');
        return;
      }
      const ok = await refreshSession();
      if (alive) setState(ok ? 'in' : 'signIn');
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
      />
    );
  }
  if (state === 'signUp') {
    return (
      <SignUpScreen onSignedUp={() => setState('in')} onLogIn={() => setState('signIn')} />
    );
  }
  return <Wallet onSignedOut={() => setState('signIn')} />;
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
function Wallet({ onSignedOut }: { onSignedOut: () => void }) {
  const [screen, setScreen] = useState<Screen>('home');
  const [reschedule, setReschedule] = useState<RescheduleTarget | null>(null);
  const home = useWalletHome();
  const toast = useToast();

  const goHome = useCallback(() => {
    setScreen('home');
    setReschedule(null);
  }, []);

  const startReschedule = useCallback((booking: BookingView) => {
    setReschedule({ booking, artistId: booking.artistId, serviceId: booking.serviceId });
    setScreen('book');
  }, []);

  const snapshot = home.snapshot;

  return (
    <View style={styles.root}>
      <View style={styles.body}>
        {screen === 'home' && (
          <HomeScreen
            home={home}
            onOpenAccount={() => setScreen('account')}
            onBook={() => {
              setReschedule(null);
              setScreen('book');
            }}
            onReschedule={startReschedule}
            onToast={toast.show}
          />
        )}

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
            <HomeScreen
              home={home}
              onOpenAccount={() => setScreen('account')}
              onBook={() => setScreen('book')}
              onReschedule={startReschedule}
              onToast={toast.show}
            />
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
           * The WhatsApp reset-link flow lives on the auth screens, which are
           * not built. api-contract.md rule 5 is explicit that this is a
           * separate flow and not a bypass of `current`, so it must not quietly
           * unlock the password sheet. Until the reset screen exists it returns
           * to Home rather than pretending to send a link. Reported.
           */
            onForgotPassword={() => setScreen('home')}
          />
        )}
      </View>

      {/*
        design:622-628 — the bottom navigation.

        TWO TABS, NOT FOUR, AND THAT IS DELIBERATE. The design's nav carries
        Home, Book, Shop and Pay. Shop is not built (design/README.md § Known
        gaps) and Pay opens the QR overlay, which lives on the wallet card and
        already has a tap target there. A tab that leads to a screen that does
        not exist is worse than a tab that is not there yet — so the nav is a
        list rather than a fixed four-up, and the other two drop in without a
        layout change.

        Hidden on Account, which the design pushes as a full screen with its own
        back control rather than as a tab.
      */}
      {screen !== 'account' ? (
        <BottomNav
          screen={screen}
          onHome={goHome}
          onBook={() => {
            setReschedule(null);
            setScreen('book');
          }}
        />
      ) : null}

      <Toast message={toast.message} />
    </View>
  );
}

/** design:623-625 — the two built destinations, with the design's own glyphs. */
function BottomNav({
  screen,
  onHome,
  onBook,
}: {
  screen: Screen;
  onHome: () => void;
  onBook: () => void;
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
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  icon: React.ReactNode;
  testID: string;
  lang: 'en' | 'ar';
}) {
  // Brand text and brand glyphs on a light surface are `brandDeep`, never
  // `brand` — non-negotiable #9.
  const tint = active ? color.brandDeep : color.textMuted;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      dataSet={focusable}
      testID={testID}
      style={styles.navItem}
    >
      <Svg width={23} height={23} viewBox="0 0 24 24" fill="none" color={tint}>
        {icon}
      </Svg>
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
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingTop: 9,
    paddingBottom: 20,
    paddingHorizontal: 22,
    borderTopWidth: 1,
    borderTopColor: color.hairline,
    backgroundColor: color.surface,
  },
  navItem: {
    minWidth: MIN_TAP_TARGET,
    minHeight: MIN_TAP_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: 12,
  },
});
