import { StaffUserSchema, type StaffPerms, type StaffUser } from '@avo/types';
import type { PlatformRole, PlatformSections } from './platformAdmin.js';
import { SCOPES, isAuthScope, type AuthScope } from './scopes.js';

/**
 * The signed-in session, as a DISCRIMINATED UNION ON SCOPE.
 *
 * Non-negotiable #6: a password is never stored, never returned by an endpoint,
 * never shown in a UI. Nothing on these shapes can hold one, and the sign-in
 * form clears the field the moment it submits.
 *
 * Non-negotiable #7: `perms` and `sections` here drive what the UI *shows*.
 * They are courtesies. Every gated call is enforced again server-side, and a 403
 * renders as an explain-state rather than a retry — see ErrorState.
 *
 * WHY A UNION AND NOT ONE INTERFACE WITH OPTIONAL FIELDS. This was a single
 * `Session` with a required `salonId`, which is correct for a merchant and
 * impossible for a platform admin: `PlatformPrincipal` in api/src/auth has NO
 * `salonId`, deliberately, so that `requireSameSalon` on it does not compile.
 * Lane A reported that adding the third member to its `Principal` union turned
 * five call sites red, each relying on a field that happened to exist on every
 * branch. The client had the same latent bug, and an optional `salonId?` would
 * have hidden it — every existing reader would still compile and would read
 * `undefined` at runtime for a console session.
 *
 * So the split is structural. `useSalonId()` takes a `MerchantSession` and there
 * is no `salonId` on an `OwnerSession` to read, which makes "which salon is the
 * owner console looking at" a question you cannot ask by accident. It is a real
 * question — the console's Salons section opens one — but it is answered by a
 * route parameter the admin chose, never by the credential.
 */
interface SessionBase {
  /** Short-lived JWT, ~15 minutes. Sent as the bearer on every request. */
  accessToken: string;
  /** Opaque, single-use, rotates on every refresh. Never sent as a bearer. */
  refreshToken: string;
  /**
   * ISO expiry of the REFRESH token (~30 days), which is what the API's
   * `expiresAt` actually is. It is not the access token's expiry, so it cannot
   * be used to refresh ahead of time — see refresh.ts.
   */
  refreshExpiresAt: string;
  username: string;
  displayName: string;
}

/**
 * `staff_user.role` — the vocabulary of `staffRole` in api/src/db/schema/staff.ts.
 *
 * DERIVED FROM THE CONTRACT, NOT RESTATED. The five words are already written
 * down in `StaffUserSchema`, and `auth/platformAdmin.ts` is the standing example
 * of what a hand-kept second copy costs: it said `founder` where the API's enum
 * said `owner`, and only a boundary parse caught it. There is no reason for this
 * file to hold another copy when the trunk schema is right there.
 *
 * NOTE THAT THIS IS NOT `PlatformRole`. The two vocabularies share the word
 * `owner` and agree on nothing else, which is precisely why the merchant rail
 * cannot borrow the console's `ROLE_LABEL` — see MerchantShell.tsx.
 */
export type StaffRole = StaffUser['role'];

function isStaffRole(value: unknown): value is StaffRole {
  return StaffUserSchema.shape.role.safeParse(value).success;
}

/**
 * `salonId` IS REQUIRED AND IT COMES FROM THE SERVER. It is `staff.salonId` off
 * the `POST /auth/web/session` response, which the API reads from the staff row
 * rather than echoing the `salonId` the sign-in form sent. A merchant session
 * cannot exist without one.
 */
export interface MerchantSession extends SessionBase {
  scope: 'merchant';
  staffId: string;
  salonId: string;
  /**
   * `staff.role` off the same sign-in response, and the authority the sidebar
   * prints. It was missing from this shape entirely, so `MerchantShell` printed
   * the literal "Owner" for everybody — a seeded front-desk account was labelled
   * "Owner" on the same screen where four of the five Reports cards refused her
   * for lacking an owner's permissions. The value was on the wire the whole time
   * and was being dropped here at sign-in.
   *
   * NULL, NOT OPTIONAL, AND NEVER DEFAULTED TO A ROLE. Three separate reasons:
   *
   *   - A DEFAULT IS THE BUG AGAIN. `role ?? 'owner'` is the hardcoded literal
   *     with extra steps, and `?? 'frontdesk'` is the same lie pointing the other
   *     way. There is no safe guess — the point of the field is that the server
   *     knows the answer and the client does not.
   *   - `| null` RATHER THAN `?`, per this file's header. An optional field lets
   *     every existing reader keep compiling while reading `undefined` at
   *     runtime, which is the failure the `salonId` split exists to prevent. A
   *     nullable required field makes each reader say what it does when the role
   *     is unknown, and there is currently one such reader.
   *   - NULL IS REACHABLE, so it is not a formality. A session minted before this
   *     field existed is sitting in `localStorage` with no `role` key and a
   *     refresh expiry up to thirty days out, and `refresh.ts` rebuilds the
   *     session with `...current`, so it never gains one. See `isStoredSession`.
   */
  role: StaffRole | null;
  perms: StaffPerms;
}

/**
 * The owner console. NO `salonId` — see the header.
 *
 * `sections` is the nine of `PLATFORM_SECTIONS`, not the design's six chips:
 * the console draws ten sidebar sections and the API gates nine of them, and #7
 * does not permit an ungated endpoint. `owner` is the founder flag, which the
 * API uses to refuse an admin removing themselves.
 */
export interface OwnerSession extends SessionBase {
  scope: 'owner';
  adminId: string;
  role: PlatformRole;
  owner: boolean;
  sections: PlatformSections;
}

export type Session = MerchantSession | OwnerSession;

/** Narrowing helper, so a caller reads the discriminant rather than a field. */
export function isOwnerSession(session: Session): session is OwnerSession {
  return session.scope === 'owner';
}

export function isMerchantSession(session: Session): session is MerchantSession {
  return session.scope === 'merchant';
}

/**
 * `type` and an intersection, not `interface ... extends`: an interface cannot
 * extend a union, and the union is the point. This distributes over both members,
 * so a stored merchant session keeps `salonId` and a stored owner session keeps
 * `sections`.
 */
type StoredSession = Session & {
  /** Which store it came from, so a rotation writes back to the same one. */
  persistent: boolean;
};

function stores(): Storage[] {
  if (typeof window === 'undefined') return [];
  return [window.localStorage, window.sessionStorage];
}

/**
 * A MISSING `role` IS TOLERATED AND DOES NOT SIGN ANYBODY OUT. This is the
 * decision the field forces, and it goes the other way from every other rule in
 * `isStoredSession`.
 *
 * The alternative — requiring `role` in the validator — is a silent mass
 * sign-out on deploy. `readSession` drops and `removeItem`s anything that fails
 * validation, so every merchant currently holding a "Keep me signed in" session
 * would be bounced to the sign-in screen the first time they loaded the new
 * build, with no explanation and no error, because the shell would simply see no
 * session. That is a worse outcome than a rail that is briefly honest about not
 * knowing: the session's tokens are still valid, its `salonId` and `perms` are
 * still correct, and every gate that matters is server-side anyway (#7). The
 * only thing missing is one line of chrome.
 *
 * So the field is filled in on the way out of storage instead. An old session
 * reads `role: null` and keeps working; the role arrives on its own at the next
 * sign-in, which is also the only moment it could be re-read, since `refresh.ts`
 * carries the stored session forward with `...current` rather than re-fetching
 * the staff row.
 *
 * A ROLE OUTSIDE THE ENUM IS ALSO NULLED rather than passed through. This runs
 * over `localStorage`, which a front-desk user can edit; `"Regional Director"`
 * would otherwise print itself straight into the sidebar. Authority in this app
 * is `perms`, checked server-side — but the label should not be forgeable
 * either, and the vocabulary is closed, so anything outside it is not a role.
 *
 * Takes and returns `unknown`: it runs BEFORE validation, so it has no session
 * to speak of yet, and typing it otherwise would need a cast to the very shape
 * the guard below exists to establish.
 */
function withKnownRole(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const v = value as Record<string, unknown>;
  if (v['scope'] !== 'merchant') return value;
  return { ...v, role: isStaffRole(v['role']) ? v['role'] : null };
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const common =
    isAuthScope(v['scope']) &&
    typeof v['accessToken'] === 'string' &&
    typeof v['refreshToken'] === 'string' &&
    typeof v['username'] === 'string' &&
    typeof v['refreshExpiresAt'] === 'string';
  if (!common) return false;

  /*
   * Validated PER SCOPE, because the two shapes have different required fields
   * and a check that accepted the loosest of them would let a console session
   * out of storage with no `sections` — which the shell would then read as "no
   * access to anything" and render an empty sidebar rather than signing out.
   *
   * No salon, no merchant session — the original rule, unchanged.
   */
  if (v['scope'] === 'merchant') {
    /*
     * `role` IS CHECKED BUT NOT REQUIRED TO BE PRESENT, because `withKnownRole`
     * ran first and has already turned "absent" and "not one of the five" into
     * `null`. What is left to assert is that this object now satisfies
     * `StaffRole | null`, which is what makes the cast below sound.
     */
    return (
      typeof v['salonId'] === 'string' &&
      v['salonId'].length > 0 &&
      (v['role'] === null || isStaffRole(v['role']))
    );
  }
  return (
    typeof v['adminId'] === 'string' &&
    v['adminId'].length > 0 &&
    typeof v['sections'] === 'object' &&
    v['sections'] !== null
  );
}

export function readSession(scope: AuthScope): Session | null {
  const key = SCOPES[scope].storageKey;
  for (const store of stores()) {
    const raw = store.getItem(key);
    if (!raw) continue;
    try {
      // Normalise, THEN validate. `withKnownRole` settles what a stored session
      // with no `role` key means before the guard is asked whether the shape is
      // legal — see its header for why that direction is the tolerant one.
      const parsed: unknown = withKnownRole(JSON.parse(raw));
      // A refresh token past its expiry cannot mint anything. Drop the whole
      // session here rather than letting the first request discover it.
      if (isStoredSession(parsed) && Date.parse(parsed.refreshExpiresAt) > Date.now()) {
        return parsed;
      }
    } catch {
      // A corrupt entry is not a session. Drop it rather than crashing the shell.
    }
    store.removeItem(key);
  }
  return null;
}

/** Which store the session is living in, so a rotation does not migrate it. */
function storeFor(scope: AuthScope): Storage | null {
  const key = SCOPES[scope].storageKey;
  for (const store of stores()) if (store.getItem(key) !== null) return store;
  return null;
}

/**
 * `keep` is the "Keep me signed in" toggle from AVO Login.dc.html. Off means the
 * session dies with the tab, which is what a shared front-desk machine needs.
 */
export function writeSession(session: Session, keep: boolean): void {
  const key = SCOPES[session.scope].storageKey;
  clearSession(session.scope, { silent: true });
  const store = keep ? window.localStorage : window.sessionStorage;
  const stored: StoredSession = { ...session, persistent: keep };
  store.setItem(key, JSON.stringify(stored));
  notify(session.scope);
}

/**
 * Write back a rotated token pair without moving the session between stores.
 * "Keep me signed in" was answered at sign-in; a refresh must not quietly
 * promote a tab-lifetime session to a persistent one.
 */
export function updateSession(session: Session): void {
  const key = SCOPES[session.scope].storageKey;
  const store = storeFor(session.scope);
  // No row to update means the session was signed out underneath the rotation.
  // Writing one back would resurrect it.
  if (!store) return;
  const persistent = store === window.localStorage;
  const stored: StoredSession = { ...session, persistent };
  store.setItem(key, JSON.stringify(stored));
  notify(session.scope);
}

export function clearSession(scope: AuthScope, options: { silent?: boolean } = {}): void {
  const key = SCOPES[scope].storageKey;
  for (const store of stores()) store.removeItem(key);
  if (!options.silent) notify(scope);
}

/* -------------------------------------------------------------- subscription */

/**
 * Session changes have three sources and every one of them has to reach React:
 *
 *   1. this tab signing in or out          — `notify`, below
 *   2. this tab rotating a refresh token   — `updateSession`, called from the
 *      API layer rather than from an event handler, which is why the store owns
 *      the subscription instead of AuthProvider owning the only copy
 *   3. ANOTHER TAB doing either            — the `storage` event
 *
 * (3) is easy to skip and expensive to skip. Two dashboard tabs on a front-desk
 * machine share `localStorage`; signing out in one leaves the other rendering a
 * shell for a session that no longer exists until its next request 401s.
 */
/**
 * WHICH TAB THE CHANGE CAME FROM, and it is not bookkeeping.
 *
 * (3) above is the only session change this tab did not cause, and that is the
 * one fact separating two sentences a merchant needs told apart: "your session
 * expired" and "you were signed out in another tab". `AuthProvider` cannot
 * recover it downstream — by the time it re-reads the store, a session cleared
 * by a 401 in this tab and a session cleared by a sign-out next door look
 * identical, because they ARE identical: an absent key.
 *
 * So the distinction is carried from where it is still known. It costs one
 * argument, and it is the whole of non-negotiable-#6-safe cause reporting: the
 * cause is a CATEGORY derived from WHICH LISTENER FIRED, never from a token, a
 * status code or the call that failed.
 */
export type SessionChangeOrigin = 'this-tab' | 'other-tab';

type Listener = (scope: AuthScope, origin: SessionChangeOrigin) => void;

const listeners = new Set<Listener>();
const ALL_SCOPES = Object.keys(SCOPES) as AuthScope[];

function notify(scope: AuthScope): void {
  for (const listener of [...listeners]) listener(scope, 'this-tab');
}

export function subscribeToSessions(listener: Listener): () => void {
  listeners.add(listener);

  const onStorage = (event: StorageEvent) => {
    // `key === null` is storage.clear() in another tab — every scope is suspect.
    if (event.key === null) {
      for (const scope of ALL_SCOPES) listener(scope, 'other-tab');
      return;
    }
    for (const scope of ALL_SCOPES) {
      if (SCOPES[scope].storageKey === event.key) listener(scope, 'other-tab');
    }
  };

  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}
