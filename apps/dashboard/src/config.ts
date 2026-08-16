/** Runtime configuration. Nothing secret lives here — see go-live-checklist § Security. */

export const API_BASE_URL: string =
  (import.meta.env['VITE_AVO_API_URL'] as string | undefined) ?? 'http://localhost:4000';

/**
 * THE SALON IS NOT CONFIGURED HERE, AND MUST NEVER BE.
 *
 * This file used to export a `FALLBACK_SALON_ID`. It is gone. A constant salon
 * id works for exactly one salon and silently breaks every other one, which
 * defeats the premise of a white-label product: the second salon onboarded
 * would read the first one's workspace out of the bundle.
 *
 * The salon a merchant is working in comes from the authenticated session and
 * nowhere else — `Session.salonId`, stamped by the server from the `staff_user`
 * row at sign-in. `useSalonId()` in auth/AuthProvider.tsx is the single accessor.
 *
 * The one thing the client legitimately needs *before* a session exists is which
 * workspace the sign-in credential belongs to, because `POST /auth/web/session`
 * takes a credential triple — `staff_user_salon_handle_uq` is on
 * (salon_id, handle), so "noura" is not a unique person. That value is a
 * credential component, not an authorisation: naming someone else's salon
 * produces a 401, and the salon on the resulting session is read from the staff
 * row rather than from what was typed.
 */

/**
 * A pre-fill for the workspace field, taken from the host when the dashboard is
 * served on a per-salon subdomain (`amara.avo.app` → `amara`).
 *
 * A HINT, NOT A RESOLUTION. It assumes the subdomain label equals the salon id,
 * which is true for nobody today: the seeded salon is `SAL-AMARA` on a host of
 * `localhost`. The field stays editable and the API decides whether the triple
 * is real. Making the subdomain authoritative needs a public
 * `GET /workspaces/{subdomain}` on the API to map a host to a salon id — see the
 * lane report.
 */
export function workspaceHintFromHost(hostname: string): string | null {
  if (!hostname) return null;
  if (hostname === 'localhost' || /^[\d.]+$/.test(hostname)) return null;
  const labels = hostname.split('.');
  if (labels.length < 3) return null;
  const first = labels[0];
  if (!first || first === 'www' || first === 'app') return null;
  return first;
}

/**
 * The last workspace that signed in successfully on this browser. Convenience
 * only — it pre-fills a text field on a shared front-desk machine so nobody
 * retypes the workspace twice a day. It is never consulted after sign-in, and it
 * grants nothing: the credential still has to match.
 */
const LAST_WORKSPACE_KEY = 'avo.workspace.last';

export function rememberWorkspace(salonId: string): void {
  try {
    window.localStorage.setItem(LAST_WORKSPACE_KEY, salonId);
  } catch {
    // A browser with storage disabled just retypes it. Not worth failing over.
  }
}

export function suggestedWorkspace(): string {
  const fromHost = workspaceHintFromHost(window.location.hostname);
  if (fromHost) return fromHost;
  try {
    return window.localStorage.getItem(LAST_WORKSPACE_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * A stable per-browser identifier, sent as `deviceId` on sign-in so the session
 * row and the audit trail can name the machine. Not a credential and not a
 * second factor — the web session is username+password; only the scanner's PIN
 * is device-bound.
 */
const DEVICE_KEY = 'avo.device';

export function deviceId(): string | null {
  try {
    const existing = window.localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const minted = crypto.randomUUID();
    window.localStorage.setItem(DEVICE_KEY, minted);
    return minted;
  } catch {
    return null;
  }
}
