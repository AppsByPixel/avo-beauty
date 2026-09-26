import { useEffect, useId, useState, type FormEvent } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { Button, InlineError, TextField, Toggle } from '@avo/ui';
import { ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthProvider.js';
import { displayNameFor } from '../auth/api.js';
import { SCOPES } from '../auth/scopes.js';
import {
  SESSION_ENDED_COPY,
  returnPathFor,
  sessionEndReasonFrom,
} from '../auth/signInSearch.js';
import { rememberWorkspace, suggestedWorkspace } from '../config.js';

/** AVO Login.dc.html 5a. Copy is verbatim; do not paraphrase it. */
const COPY = {
  bothFields: 'Enter both your username and password.',
  shortPassword: 'Password must be at least 6 characters.',
  unreachable: "We couldn't reach your workspace. Check your connection and try again.",
  rejected: 'That username and password do not match. Try again.',
  /*
   * NOT FROM THE DESIGN — flagged in the lane report, and ruled on since.
   *
   * AVO Login.dc.html 5a draws two fields, username and password. The API needs
   * three: `staff_user_salon_handle_uq` is on (salon_id, handle), so "noura" is
   * not a unique person and a two-field form cannot address a second salon. The
   * departure is normative, not this lane's invention — api-contract.md:787,
   * marked "Ruling": *"merchant sign-in carries a workspace field and platform
   * sign-in does not … forced by the data model rather than chosen"*. It is
   * DECISIONS.md queue item 7.
   *
   * The ruling says the field is CARRIED. It does not say "carried unless the
   * hostname looks like it knows better" — see the field itself below for what
   * that conditional cost.
   */
  missingWorkspace: 'Enter the workspace for your salon.',
} as const;

const MIN_PASSWORD_LENGTH = 6;

export function SignIn() {
  const navigate = useNavigate();
  const { signIn, sessionFor } = useAuth();
  const errorId = useId();

  /*
   * ================================================================
   * WHY SHE IS HERE, AND WHERE SHE WAS
   * ================================================================
   * Read off the location rather than through a typed route handle, and the type
   * is `unknown` on purpose: this is a query string, so it is whatever anybody
   * typed into the address bar. `sessionEndReasonFrom` and `returnPathFor` are
   * the two functions that turn it back into something this screen may act on,
   * and both of them are total — there is no input either one throws on and none
   * that either one passes through unexamined.
   *
   * `location.search` and not `signInRoute.useSearch()`: `router.tsx` imports
   * this component, so importing the route back would be a cycle. The hook is
   * the one the shells already use.
   */
  const location = useRouterState({ select: (state) => state.location });
  const search: unknown = location.search;
  /*
   * A DOOR ONLY NAVIGATES WHILE IT IS THE DOOR, AND THIS GUARD IS A FIX FOR AN
   * OBSERVED FAILURE RATHER THAN CAUTION.
   *
   * `location.search` belongs to WHEREVER THE ROUTER IS, not to this screen.
   * On the navigation out of here, this component renders once more with the
   * search of the route being entered — and `/appointments` carries none. So
   * `destination` recomputed to the default, the effect below re-ran because
   * `destination` is in its dependency list, and it navigated a second time:
   *
   *   [EFFECT] navigating to /appointments
   *   [render] search {} -> destination /overview
   *   [EFFECT] navigating to /overview
   *
   * The merchant was put back on `/overview` by the second hop of the very fix
   * meant to stop that. Traced, not guessed — the sequence above is the log.
   *
   * Checking the pathname makes the transitional render inert: `onDoor` is
   * false, both effects return, and the destination decided while the search was
   * still ours stands. It is the same correction `MerchantShell` needed at the
   * other end of this flow, which is the honest summary of both — a value read
   * live from the router is only true for the render it was read in.
   */
  const onDoor = location.pathname === SCOPES.merchant.signIn;

  /*
   * THE CAUSE. `null` for a deliberate sign-out, for a cold arrival, and for any
   * word that is not one of the two — all three want silence, and none of them
   * is distinguishable from the others by anything on this screen, which is
   * exactly why they render the same nothing.
   */
  const cause = sessionEndReasonFrom(search);

  /*
   * THE DESTINATION, AND THIS CALL IS THE SECURITY GATE.
   *
   * Everything it returns is either `SCOPES.merchant.home` or an `item.to` out of
   * `NAV_ITEMS` — literals compiled into this app. A hostile `?from=` cannot
   * produce a string that is not already in that table, so an absolute URL, a
   * protocol-relative `//evil.example` and a path this shell does not serve all
   * arrive at the same place a missing parameter does. `signInSearch.ts` carries
   * the argument for why that is a closed set rather than a filter.
   */
  const destination = returnPathFor('merchant', (search as { from?: unknown } | null)?.from);

  // The workspace pre-fill: the last workspace that signed in successfully on
  // this browser, else the host's subdomain label (config.ts states the order
  // and why). A default, never a verdict — the field carrying it is always
  // rendered. See below.
  const [salonId, setSalonId] = useState(() => suggestedWorkspace());
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [keepSignedIn, setKeepSignedIn] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [welcome, setWelcome] = useState<string | null>(null);

  /*
   * Already signed in — skip the form entirely.
   *
   * `destination`, NOT `SCOPES.merchant.home`, AND BOTH EFFECTS HAD TO CHANGE.
   * This is the one that actually lands after a successful sign-in: `sessionFor`
   * changes identity the moment `adopt` commits, so this effect fires before the
   * welcome timer below ever expires. Fixing only the timer would have left the
   * return path working nowhere.
   */
  useEffect(() => {
    if (!onDoor) return;
    if (sessionFor('merchant')) void navigate({ to: destination });
  }, [onDoor, navigate, sessionFor, destination]);

  // The signed-in landing holds for a beat, then opens the dashboard.
  useEffect(() => {
    if (welcome === null || !onDoor) return;
    const timer = window.setTimeout(() => void navigate({ to: destination }), 900);
    return () => window.clearTimeout(timer);
  }, [welcome, onDoor, navigate, destination]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;

    if (!username.trim() || !password) {
      setError(COPY.bothFields);
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(COPY.shortPassword);
      return;
    }
    if (!salonId.trim()) {
      setError(COPY.missingWorkspace);
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const session = await signIn(
        'merchant',
        { salonId: salonId.trim(), username: username.trim(), password },
        keepSignedIn,
      );
      // Non-negotiable #6: the password leaves the client's memory the moment
      // the request resolves, whichever way it resolved.
      setPassword('');
      // The salon that gets remembered is the one the SERVER put on the session,
      // not the one that was typed. They match today; if they ever stop, the
      // server's answer is the right one to keep.
      rememberWorkspace(session.salonId);
      setWelcome(session.displayName || displayNameFor(username));
    } catch (cause) {
      setPassword('');
      /*
       * The API answers every credential failure identically and on purpose —
       * "wrong password", "no such user" and "no such salon" are one 401 with
       * one body, because distinguishing them turns this form into a staff-list
       * oracle. So this branch does not try to be more specific than the server
       * was: one message for a refusal, one for not reaching it at all.
       */
      if (cause instanceof ApiError && cause.isUnauthenticated) setError(COPY.rejected);
      else if (cause instanceof ApiError && cause.status === 400) setError(COPY.missingWorkspace);
      else setError(COPY.unreachable);
    } finally {
      setSubmitting(false);
    }
  }

  if (welcome !== null) {
    return (
      <div className="signin">
        <div className="signin__card signin__card--done">
          <span className="signin__check" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <path
                d="M5 12.5l4.5 4.5L19 7.5"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <h1 className="signin__title avo-display">
            Welcome back{welcome ? `, ${welcome}` : ''}
          </h1>
          <p className="signin__sub" role="status">
            Opening the dashboard…
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="signin">
      <form className="signin__card" onSubmit={onSubmit} noValidate>
        <div className="signin__brand">
          <span className="signin__mark" aria-hidden="true">
            A
          </span>
          <span>
            <span className="signin__wordmark">AVO</span>
            <span className="signin__scope">Merchant workspace</span>
          </span>
        </div>

        {/*
          THE SENTENCE THAT WAS MISSING, ABOVE THE TITLE BECAUSE IT IS THE REASON
          SHE IS READING THE TITLE. She did not ask for this screen.

          `InlineError` IS THIS DOOR'S OWN VOCABULARY — the `AVO Login.dc.html`
          banner, already the way this screen says something to the person in
          front of it. Deliberately NOT the sections' `ErrorState`:
          `stateCensus.test.ts` § DOORS rules that a sign-in screen "must NOT
          render the sections' error vocabulary", and borrowing it here to
          announce a session would be the fourth way of telling somebody
          something went wrong that §4 exists to prevent.

          `role="alert"` comes with it, which is the half that matters on arrival:
          she was moved here by something she did not do, so the explanation is
          announced rather than left to be noticed.

          IT IS NOT WIRED INTO `setError('')` LIKE THE FORM'S OWN BANNER BELOW.
          This is a statement about how she got here, not a complaint about what
          she typed, so it does not clear on the first keystroke — and it does not
          occupy the slot a wrong password needs a moment later.
        */}
        {cause ? (
          <div className="signin__error">
            <InlineError message={SESSION_ENDED_COPY[cause]} />
          </div>
        ) : null}

        <h1 className="signin__title avo-display">Sign in to your salon</h1>
        <p className="signin__sub">Enter the credentials for your salon workspace.</p>

        <div className="signin__fields">
          {/*
            ALWAYS RENDERED. This was `{fromHost ? null : <TextField … />}`, and
            the hint it trusted is documented one file away as authoritative for
            nobody — config.ts: *"A HINT, NOT A RESOLUTION. It assumes the
            subdomain label equals the salon id, which is true for nobody today."*
            A value that weak may pre-fill a control. It may not remove one.

            What the conditional actually did: `workspaceHintFromHost` returns
            the first DNS label of any host with three or more labels, so every
            hosted domain — not just a per-salon subdomain — deleted the field
            and submitted its own first label as the salon id. Driven, on the
            hosts that matter:

              localhost                        null   the only one that worked
              98a0-39-49-146-53.ngrok-free.app "98a0-39-49-146-53"
              abc-def.trycloudflare.com        "abc-def"
              avo-dashboard.onrender.com       "avo-dashboard"
              dashboard.avo.beauty             "dashboard"
              amara.avo.app                    "amara"

            The deployed sign-in page rendered two inputs, username and password,
            and POSTed a salon id that is not a salon: one 401, deliberately
            unspecific (see the catch above), and no control on the screen able
            to correct it. Not an ngrok artefact — `onrender.com` fails
            identically, and so does `dashboard.avo.beauty`, which is the host
            the design itself draws in the browser chrome of AVO Login.dc.html 5a.

            The hint keeps its whole job on a per-salon subdomain: on
            `amara.avo.app` nobody types the workspace, it is already in the box.
            It just no longer decides whether the box exists.
          */}
          <TextField
            label="Workspace"
            placeholder="SAL-AMARA"
            autoComplete="organization"
            autoCapitalize="characters"
            spellCheck={false}
            value={salonId}
            describedBy={error ? errorId : undefined}
            onChange={(event) => {
              setSalonId(event.target.value);
              setError('');
            }}
          />

          <TextField
            label="Username"
            placeholder="amara"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            describedBy={error ? errorId : undefined}
            onChange={(event) => {
              setUsername(event.target.value);
              setError('');
            }}
          />

          <TextField
            label="Password"
            type={showPassword ? 'text' : 'password'}
            placeholder="••••••••"
            autoComplete="current-password"
            value={password}
            describedBy={error ? errorId : undefined}
            action={
              <Button
                variant="quiet"
                onClick={() => setShowPassword((shown) => !shown)}
                aria-pressed={showPassword}
              >
                {showPassword ? 'Hide' : 'Show'}
              </Button>
            }
            onChange={(event) => {
              setPassword(event.target.value);
              setError('');
            }}
          />
        </div>

        <div className="signin__row">
          <Toggle checked={keepSignedIn} onChange={setKeepSignedIn} label="Keep me signed in" />
          {/*
            NOT A LINK. This was `<a href="/forgot-password">`, and no such route
            exists in router.tsx — a raw anchor full-loads the app into the
            router's not-found, from the sign-in door itself. Found by the row-365
            census: the link's target sits in no route table.

            It cannot honestly BE a link yet: staff resets are issued by a manager
            from the Team screen ("Reset password" on her row), and the redeem
            screen for the emailed link is queued as DECISIONS.md #13 — so there
            is no page self-service could land on. ConsoleSignIn already made
            this exact call (a span that says so) and is the merged precedent.
            The title sentence is flagged for copy review in the lane report.
          */}
          <span
            className="signin__link"
            title="Ask a manager — password resets are sent from the Team screen."
          >
            Forgot password?
          </span>
        </div>

        {error ? (
          <div className="signin__error">
            <InlineError id={errorId} message={error} />
          </div>
        ) : null}

        <Button type="submit" block disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>

        <p className="signin__foot">
          Team member? Open the <b>AVO Scanner</b> app instead.
        </p>
      </form>
    </div>
  );
}
