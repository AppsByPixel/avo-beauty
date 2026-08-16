/** Runtime configuration. Nothing secret lives here — see go-live-checklist § Security. */

export const API_BASE_URL: string =
  (import.meta.env['VITE_AVO_API_URL'] as string | undefined) ?? 'http://localhost:4000';

/**
 * The salon this workspace belongs to.
 *
 * TEMPORARY. This belongs on the session the auth endpoint returns — a merchant
 * signs in to *their* salon, and a client-supplied salon id is an access-control
 * hole the moment the real API lands. Tracked in the lane report as a required
 * `POST /auth/session` addition.
 */
export const FALLBACK_SALON_ID: string =
  (import.meta.env['VITE_AVO_SALON_ID'] as string | undefined) ?? 'SAL-AMARA';
