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
 *   2. The pre-cache branding, by way of the copy file: a phone that has never
 *      been signed in titles its sign-in screen `copy.salonName` and paints the
 *      token file's default palette. After one sign-in it is the last
 *      workspace's instead (`state/lastWorkspace.ts`).
 *
 * `EXPO_PUBLIC_AVO_SALON` still selects it. The default is Amara, the fixture
 * every lane drives.
 */
export const SALON_ID: string = process.env['EXPO_PUBLIC_AVO_SALON'] ?? 'SAL-AMARA';
