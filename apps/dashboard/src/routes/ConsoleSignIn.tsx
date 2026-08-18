import { useId, useState } from 'react';
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
  const { signInToConsole } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [keep, setKeep] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const errorId = useId();

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
      await navigate({ to: SCOPES.owner.home });
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
            Points at nothing yet, and says so rather than 404ing: there is no
            console password-reset endpoint. #6 permits only a link, never a
            temporary password, so this cannot be built client-side.
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
