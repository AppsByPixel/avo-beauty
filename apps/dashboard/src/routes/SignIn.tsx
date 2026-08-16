import { useEffect, useId, useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button, InlineError, TextField, Toggle } from '@avo/ui';
import { ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthProvider.js';
import { displayNameFor } from '../auth/api.js';
import { SCOPES } from '../auth/scopes.js';
import { rememberWorkspace, suggestedWorkspace, workspaceHintFromHost } from '../config.js';

/** AVO Login.dc.html 5a. Copy is verbatim; do not paraphrase it. */
const COPY = {
  bothFields: 'Enter both your username and password.',
  shortPassword: 'Password must be at least 6 characters.',
  unreachable: "We couldn't reach your workspace. Check your connection and try again.",
  rejected: 'That username and password do not match. Try again.',
  /*
   * NOT FROM THE DESIGN — flagged in the lane report.
   *
   * AVO Login.dc.html 5a draws two fields, username and password. The API needs
   * three: `staff_user_salon_handle_uq` is on (salon_id, handle), so "noura" is
   * not a unique person and a two-field form cannot address a second salon. On
   * a per-salon subdomain this field is derived from the host and hidden, which
   * is the deployed shape and matches the design exactly; on a bare host it has
   * to be asked for. The alternative was a build-time constant, which is the
   * thing this change removes.
   */
  missingWorkspace: 'Enter the workspace for your salon.',
} as const;

const MIN_PASSWORD_LENGTH = 6;

export function SignIn() {
  const navigate = useNavigate();
  const { signIn, sessionFor } = useAuth();
  const errorId = useId();

  /*
   * A subdomain is authoritative enough to hide the field: on `amara.avo.app`
   * the merchant did not choose the workspace, the URL did. On `localhost` and
   * on the apex there is no host to read, so the field is shown and pre-filled
   * with whatever last signed in here.
   */
  const fromHost = workspaceHintFromHost(window.location.hostname);
  const [salonId, setSalonId] = useState(() => suggestedWorkspace());
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [keepSignedIn, setKeepSignedIn] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [welcome, setWelcome] = useState<string | null>(null);

  // Already signed in — skip the form entirely.
  useEffect(() => {
    if (sessionFor('merchant')) void navigate({ to: SCOPES.merchant.home });
  }, [navigate, sessionFor]);

  // The signed-in landing holds for a beat, then opens the dashboard.
  useEffect(() => {
    if (welcome === null) return;
    const timer = window.setTimeout(() => void navigate({ to: SCOPES.merchant.home }), 900);
    return () => window.clearTimeout(timer);
  }, [welcome, navigate]);

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

        <h1 className="signin__title avo-display">Sign in to your salon</h1>
        <p className="signin__sub">Enter the credentials for your salon workspace.</p>

        <div className="signin__fields">
          {fromHost ? null : (
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
          )}

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
          <a className="signin__link" href="/forgot-password">
            Forgot password?
          </a>
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
