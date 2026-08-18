/**
 * Which salon's wallet this build is.
 *
 * `POST /auth/member/session` needs a `salonId` alongside the phone and password,
 * and the design's sign-in screen shows no salon picker. That is the design being
 * right rather than incomplete: `member_salon_phone_uq` is on (salon_id, phone)
 * because the same woman can hold a wallet at two salons, so a phone number does
 * not identify a member — but each salon ships its own white-labelled build, so
 * the app always already knows which salon it is.
 *
 * The same reasoning apps/scanner writes down in `config/brand.ts`: "That is not a
 * gap — it is the white-label model working as designed."
 *
 * `EXPO_PUBLIC_AVO_SALON` selects it, so a second salon is a build variable rather
 * than a fork. The default is Amara, the fixture every lane drives.
 */
export const SALON_ID: string = process.env['EXPO_PUBLIC_AVO_SALON'] ?? 'SAL-AMARA';
