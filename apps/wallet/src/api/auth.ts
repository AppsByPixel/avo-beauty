/**
 * Sign in, refresh, sign out — `POST /auth/member/session`, `/auth/refresh`,
 * `/auth/sign-out`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE IDENTITY IS A PHONE NUMBER, AND THE DESIGN SAYS USERNAME. REPORTED.
 *
 * `design/AVO Wallet Home.dc.html:100` labels the sign-in field `t.username` with
 * the placeholder `dana.k`, in both languages (`username: 'Username'` :1247,
 * `'اسم المستخدم'` :1354). Its signup screen collects Name, Username, Password,
 * Confirm — and no phone number at all.
 *
 * Every other source disagrees, including the design itself:
 *
 *   design/api-contract.md:76   phone — "also the login identity"
 *   design/api-contract.md:95   rule 1: "Phone is the login identity."
 *   AVO Wallet Home.dc.html:1187  "Your phone number is how you log in."
 *   ...:1294 (ar)                 "رقم هاتفك هو وسيلة تسجيل الدخول."
 *   api/src/routes/auth.ts:81   POST /auth/member/session -> { salonId, phone, password }
 *
 * And it is not a preference: **there is no member username anywhere** — not a
 * column on `member`, not a field on `MemberSchema`. Rule 1 is load-bearing rather
 * than aspirational; it is why `PATCH /members/me` must *reject* a `phone` field
 * rather than ignore it. So the design's screen as drawn cannot authenticate
 * against this system at all, and the conflict is inside the bundle rather than
 * between the bundle and us.
 *
 * Built with phone, because that is what the contract states twice, what the
 * design's own profile screen states in both languages, and the only thing the
 * API can serve. ESCALATED to trunk rather than settled here — if the client
 * wants usernames it is a schema change and a contract change, not a client edit.
 *
 * The copy cost of the resolution, stated so it is not invisible: `rowPhone`
 * ("Phone" / "رقم الهاتف", :1201/:1308) is the bundle's own bilingual label and is
 * reused verbatim, so the FIELD needs nothing invented. The design's validation
 * string does — `errEmpty` names the username in both languages — so one new pair
 * is added and the Arabic is listed in `AR_GAPS` like the other 31, rather than
 * machine-translated into a women's-salon product.
 *
 * THE SALON IS NOT A FIELD. `POST /auth/member/session` needs `salonId` because
 * `member_salon_phone_uq` is on (salon_id, phone) — the same woman can hold a
 * wallet at two salons, so a phone number alone does not identify a member. The
 * design shows no salon picker, and that is correct rather than an omission: each
 * salon ships its own white-labelled build, so the salon is configuration. See
 * `config/salon.ts`.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { z } from 'zod';
import { MemberSchema } from '@avo/types';
import { postAction, postNoContent } from './client';
import { clearSession, setSession } from './session';

/**
 * `POST /auth/refresh`, re-exported rather than reimplemented.
 *
 * The implementation lives in `client.ts` because that is where the 401 retry
 * needs it, and it carries the single-flight latch that stops a burst of expired
 * requests from rotating the refresh token several times over. A second copy here
 * would be two implementations of one rule — the exact shape of the drift this
 * project keeps finding — so this is an alias and not a wrapper.
 */
export { refreshSession } from './client';

/**
 * What sign-in returns. `member` comes back with the session so the first screen
 * has her name and balance without a second round trip.
 */
const MemberSessionSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.string(),
  member: MemberSchema,
});

export type Member = z.infer<typeof MemberSchema>;

/**
 * `POST /auth/member/session`.
 *
 * `password` is a parameter and never anything else — not state, not a field on a
 * stored object, not a log line (non-negotiable #6). It exists for the duration of
 * this call.
 *
 * No idempotency key: this moves no money, and a repeated sign-in is not a
 * duplicate to collapse — it legitimately mints a second session, which is what
 * signing in on a second device is.
 */
export async function signIn(
  credentials: { salonId: string; phone: string; password: string },
  signal?: AbortSignal,
): Promise<Member> {
  const body = await postAction(
    '/auth/member/session',
    credentials,
    MemberSessionSchema,
    // Spread rather than `{ signal }`: under `exactOptionalPropertyTypes` an
    // explicit `undefined` is not the same as an absent key.
    signal === undefined ? {} : { signal },
  );
  await setSession({
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    salonId: body.member.salonId,
    memberId: body.member.id,
  });
  return body.member;
}

/**
 * `POST /auth/sign-out` — revoke server-side, THEN forget locally.
 *
 * The order is the whole point. A local-only clear leaves a valid token on a
 * device the customer believes she has signed out of, and this app's refresh token
 * is recoverable from an unlocked handset (see session.ts). Revoking makes the
 * lifted token useless.
 *
 * The local clear happens even when the revoke fails. Refusing to sign her out
 * because the network is down would be the wrong answer to "get me off this
 * phone" — she is signed out locally, and the token she leaves behind is the
 * residual risk the revoke was there to remove. Reported rather than hidden: an
 * offline sign-out cannot revoke, so the session stays alive server-side until it
 * expires.
 */
export async function signOut(signal?: AbortSignal): Promise<void> {
  try {
    await postNoContent('/auth/sign-out', {}, signal);
  } catch {
    /* see above — the local clear is unconditional */
  }
  await clearSession(false);
}
