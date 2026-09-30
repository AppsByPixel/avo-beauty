/**
 * The build's DEFAULT workspace — no longer "which salon's wallet this build is".
 *
 * This used to be the salon, full stop: each salon was to ship its own
 * white-labelled build, so sign-in, reset and the shop all read it. Aftab,
 * 2026-09-29, reversed that — "different wallet themes for different workspaces
 * … not a separate app". One wallet app serves every workspace, and the
 * SIGNED-IN ACCOUNT decides which: `POST /auth/member/session` takes no
 * `salonId`, the session names one, and every read after sign-in uses it
 * (`api/session.ts § sessionOwner`).
 *
 * What is left for this constant, and nothing else may read it:
 *
 *   1. SIGN-UP's workspace. A new customer has no account to decide it, so she
 *      joins this one. That is a PRODUCT QUESTION, flagged to trunk rather than
 *      settled here: with one app for every workspace, a new Forest customer
 *      who taps Create account is registered at Amara. See `SignUpScreen`.
 *   2. The pre-cache branding: a phone that has never been signed in titles its
 *      sign-in screen with `DEFAULT_SALON_NAME` below and paints the token
 *      file's default palette. After one sign-in it is the last workspace's
 *      instead (`state/lastWorkspace.ts`, `state/workspaceName.ts`).
 *
 * `EXPO_PUBLIC_AVO_SALON` still selects it. The default is Amara, the fixture
 * every lane drives.
 */
export const SALON_ID: string = process.env['EXPO_PUBLIC_AVO_SALON'] ?? 'SAL-AMARA';

/**
 * The default workspace's NAME, in both languages — the last resort of
 * `state/workspaceName.ts`, and the name sign-up shows because sign-up joins
 * `SALON_ID` (item 1 above).
 *
 * It lives here, beside the id it names, and NOT in the copy files. It used to
 * be `copy.salonName: 'Amara'`, which made one workspace's name look like
 * product copy, and five sentences beside it wrote the name in literally — so a
 * Forest member's Account said "prepaid credit for Amara Salon only". This is
 * data about one workspace, not a word of the app's.
 *
 * The same shape as the API's `Salon` (`name`, nullable `nameAr`), because the
 * salon read cannot answer before sign-in: `GET /salons/{id}` is session-scoped.
 * `EXPO_PUBLIC_AVO_SALON_NAME` / `_NAME_AR` travel with `EXPO_PUBLIC_AVO_SALON`
 * — a build that moves the default id must move its name too, or a new sign-up
 * at that workspace reads another salon's name. An overridden Latin name with
 * no Arabic one leaves `nameAr` null, so Arabic falls back to the Latin name
 * rather than to Amara's Arabic.
 */
const envName = process.env['EXPO_PUBLIC_AVO_SALON_NAME'];
export const DEFAULT_SALON_NAME: { name: string; nameAr: string | null } = {
  name: envName ?? 'Amara',
  nameAr: process.env['EXPO_PUBLIC_AVO_SALON_NAME_AR'] ?? (envName ? null : 'أمارا'),
};
