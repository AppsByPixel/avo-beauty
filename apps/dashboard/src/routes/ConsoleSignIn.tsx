import { useEffect, useId, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button, InlineError, TextField } from '@avo/ui';
import { ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthProvider.js';
import { SCOPES } from '../auth/scopes.js';

/**
 * AVO Login.dc.html 5b — the DARK console sign-in. Copy is verbatim.
 *
 * A SEPARATE SCREEN FROM `SignIn.tsx`, NOT A THEMED ONE. The two take different
 * credentials: the merchant form needs a workspace because
 * `staff_user_salon_handle_uq` is on (salon_id, handle), and the console does not
 * because `platform_admin.handle` is globally unique. Parameterising one form over
 * "sometimes there is a third field, and it changes which endpoint we post to"
 * would be one component pretending to be one thing — the same reasoning
 * `signInToConsole` is separate from `signIn` in auth/api.ts.
 *
 * NO "TEMPORARY PASSWORD" AND NO PASSWORD FIELD ANYWHERE BUT HERE — #6. The
 * design's Admins section draws an invite with a temporary password; the API
 * refuses a `password` key by name. An invited admin therefore CANNOT SIGN IN
 * YET: there is no console password-reset endpoint, so `passwordSet: false` is a
 * state the product can create and not resolve. That is Lane A's gap and it is in
 * the lane report; this screen does not paper over it with a field the server
 * would reject.
 */
export function ConsoleSignIn() {
  const { signInToConsole, sessionFor } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [keep, setKeep] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const errorId = useId();

  /*
   * THE REDIRECT IS AN EFFECT, NOT A LINE IN THE SUBMIT HANDLER, AND THAT IS THE
   * WHOLE OF A BUG THAT SHIPPED.
   *
   * It used to be `await navigate({ to: SCOPES.owner.home })` on the line after
   * `await signInToConsole(...)`. The POST returned 200, the session was written,
   * and the admin stayed on this form — clicking Sign in a second time was
   * impossible, because the success path clears the password and the button
   * disables itself on an empty one.
   *
   * The mechanism, observed rather than guessed (console instrumentation, lane C
   * repro against a real API on 2026-08-27):
   *
   *   [DIAG] pre-navigate  href= /console/signin
   *   [DIAG] requireScope owner sessionFor= false keys= Array(0)
   *   [DIAG] requireScope BOUNCE -> /console/signin
   *   [DIAG] post-navigate href= /console/signin
   *
   * `signInToConsole` calls `setSessions` in AuthProvider. The router reads auth
   * from `RouterProvider context={{ auth }}` in main.tsx, so the guard sees the
   * new session only after React has COMMITTED that state update and re-rendered
   * `RoutedApp`. Navigating on the next line runs inside the same continuation,
   * before that commit: `requireScope('owner')` in router.tsx therefore reads the
   * PREVIOUS context — an empty session map, `keys= Array(0)`, not merely a
   * missing owner key — throws `redirect({ to: SCOPES.owner.signIn })`, and the
   * router lands back on this screen. The session is real; the guard was asked
   * about it one commit too early.
   *
   * NOT A RACE, though it looks like one. There is no interleaving and no jitter:
   * the ordering is React's commit boundary and it is the same every time, which
   * is why this reproduced twice in two sessions rather than intermittently. A
   * `setTimeout(0)` or a second `await` would appear to fix it by letting the
   * commit land first, and would be a coincidence dressed as a fix.
   *
   * An effect keyed on the session cannot be early by construction: it runs after
   * the commit that carries the session, which is the same commit that gives
   * `RouterProvider` its new context. `SignIn.tsx` navigates from an effect too
   * and was never affected — the difference between the two screens WAS the bug,
   * and the two are now the same shape.
   *
   * It also closes a second gap this screen had and the merchant one did not: an
   * admin who already holds an owner session and opens `/console/signin` used to
   * be shown the form. Same effect, no extra branch — a session is a session
   * whether it arrived a second ago or a week ago.
   */
  const signedIn = sessionFor('owner') !== null;
  useEffect(() => {
    if (signedIn) void navigate({ to: SCOPES.owner.home });
  }, [signedIn, navigate]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      await signInToConsole({ username: username.trim(), password }, keep);
      // #6: the password leaves memory the moment the request resolves, whichever
      // way it resolved.
      setPassword('');
      // The redirect is the effect above. See the comment on it.
    } catch (cause) {
      setPassword('');
      /*
       * A 401 here is "those credentials are wrong", and the server deliberately
       * does not say which half — an unknown handle and a wrong password burn the
       * same verify time and return the same body. Rendering the server's own
       * message keeps that property; inventing "no such admin" would leak it.
       */
      setError(
        cause instanceof ApiError
          ? cause.isConnectivity
            ? "Can't reach AVO. Check your connection and try again."
            : cause.message
          : 'Something went wrong signing in.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="csignin avo-dark">
      <form className="csignin__card" onSubmit={onSubmit} noValidate>
        <div className="csignin__brand">
          <span className="csignin__mark" aria-hidden="true">
            A
          </span>
          <span>
            <span className="csignin__brandname avo-display">AVO Platform</span>
            <span className="csignin__brandsub">Owner console</span>
          </span>
        </div>

        <h1 className="csignin__title avo-display">Sign in</h1>
        <p className="csignin__lede">The super-admin view above every salon.</p>

        <TextField
          label="Username"
          placeholder="yousef"
          autoComplete="off"
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

        <div className="csignin__row">
          <label className="csignin__keep">
            <input
              type="checkbox"
              checked={keep}
              onChange={(e) => setKeep(e.currentTarget.checked)}
            />
            <span>Keep me signed in</span>
          </label>
          {/*
            Points at nothing yet, and says so rather than 404ing. THE REASON HAS
            MOVED SINCE THIS WAS WRITTEN and is corrected in place (the stale-claim
            habit): the console reset ENDPOINTS exist now — `POST
            /v1/platform/admins/{id}/password-reset` issues and `POST
            /auth/platform/password-reset` redeems — but issuance requires an admin
            holding the `admins` section (the Reset password button on her row),
            and the redeem screen for the emailed link is queued as DECISIONS.md
            #13. Self-service "forgot" from this door still has no endpoint and no
            landing page, so the span stands; only its justification changed.
          */}
          <span className="csignin__forgot" title="Ask another platform admin — AVO has no console reset link yet.">
            Forgot password?
          </span>
        </div>

        {error ? <InlineError id={errorId} message={error} /> : null}

        <Button type="submit" disabled={busy || username.trim() === '' || password === ''}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>

        <p className="csignin__restricted">Restricted — authorized platform admins only.</p>
      </form>
    </div>
  );
}
