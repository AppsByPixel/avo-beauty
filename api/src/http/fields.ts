/**
 * Request fields that more than one surface has to read the same way.
 *
 * `parseE164` lived in routes/members.ts, which was fine while the phone number
 * only ever arrived on a profile edit. Signup takes one too — and phone is the
 * login identity (api-contract.md § Profile edit, rule 1), so the two doors into
 * `member.phone` must agree about what a phone number is. A second copy of this
 * regex would be a second definition of the login identity, and the one that
 * drifted would be the one nobody was reading.
 *
 * It is here rather than exported from routes/members.ts because members.ts
 * already imports `serialiseMember` from routes/auth.ts, and auth.ts is the file
 * that needs this — importing back would make the two route modules mutually
 * dependent for the sake of one regex.
 */

import { BusinessHoursSchema } from '@avo/types';
import { badRequest } from './errors';

/**
 * E.164, the exact shape `member_phone_is_e164` enforces in the database.
 *
 * Spaces and dashes are stripped first because a customer typing her own number
 * puts them in, and refusing `+965 9912 4408` for punctuation would be a
 * validation error about nothing. The CHECK is the authority on the shape; this
 * is the same pattern, so a value that passes here cannot be refused by the
 * database with a 500.
 */
export function parseE164(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().replace(/[\s-]/g, '') : '';
  if (!/^\+[1-9][0-9]{6,14}$/.test(raw)) {
    throw badRequest(
      'invalid_phone',
      'Enter the number with its country code, like +96599123456.',
    );
  }
  return raw;
}

/**
 * THE 24-HOUR WALL CLOCK, "HH:MM" — one definition, after three.
 *
 * `routes/artists.ts` and `routes/platform.ts` each carried a private copy of
 * this regex (identical but for a capture group nothing read), and
 * `parseBusinessHours` below was about to be a third. That is the same two-doors
 * defect `routes/salons.ts` records against the tier ladder, wearing a regex: the
 * copy that drifts is the one nobody is reading, and "what counts as a time" is
 * one fact about this product.
 *
 * `HHMM_OR_END_OF_DAY` exists because "24:00" is a real END and never a real
 * START — `db/schema/promotion.ts` carries the argument, and `hhmmToMinutes`
 * resolves it to 1440. A window that starts at end-of-day has no length.
 */
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const HHMM_OR_END_OF_DAY = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

/**
 * `businessHours`, validated — the last unvalidated jsonb door on the salon.
 *
 * THE DEFECT: `businessHours` has been in `EDITABLE` on `PATCH /salons/{id}`
 * since that route was written, checked by nothing. The column is jsonb, so
 * `{ morning: ["banana", 7], evening: null }` was storable — and this is not a
 * cosmetic hole, because of who reads the column next:
 *
 *     services/availability.ts:296   tradingSpans(s.businessHours)
 *     services/availability.ts:91    hhmmToMinutes(from)   ->  throws TypeError
 *
 * `hhmmToMinutes` throws on anything that is not HH:MM, and it is called inside
 * `computeAvailability`. So one bad Settings save turns EVERY availability read
 * for that salon into a 500 — not at the field that was typed wrong, but on the
 * booking screen, which is exactly the failure `salon.timezone`'s comment
 * describes and exactly the shape `brandColor` had. `parseTimeZone` and
 * `parseBrandColor` are the two doors already closed; this is the third.
 *
 * THE SHARED SCHEMA FIRST, THEN MORE. `BusinessHoursSchema` from `@avo/types` is
 * what every client parses this against, so the API must not refuse a shape the
 * clients accept. But that schema is `z.tuple([z.string(), z.string()])` — it
 * says "two strings", not "two clock times", because zod is describing the wire
 * and the API is the authority on what may be STORED. So the shape comes from the
 * shared schema and the clock check is added here.
 *
 * WHAT IS DELIBERATELY NOT REFUSED: a zero-length span. `tradingSpans` already
 * drops one (`if (span.to > span.from)`), which makes
 * `evening: ["21:00", "21:00"]` the established way to say "no evening session" —
 * so refusing `to <= from` here would break a salon with no afternoon closure and
 * no second sitting. The artist-windows route DOES refuse it, and correctly: an
 * open day with no bookable slot in it is a merchant who meant something else.
 * These two are different questions about the same-looking data.
 */
export function parseBusinessHours(
  value: unknown,
  field = 'businessHours',
): { morning: [string, string]; evening: [string, string] } {
  const parsed = BusinessHoursSchema.safeParse(value);
  if (!parsed.success) {
    throw badRequest(
      'invalid_business_hours',
      `${field} must be { morning: ["10:00","13:00"], evening: ["16:00","21:00"] }.`,
    );
  }

  for (const session of ['morning', 'evening'] as const) {
    const [from, to] = parsed.data[session];
    if (!HHMM.test(from)) {
      throw badRequest(
        'invalid_business_hours',
        `${field}.${session} opens at "${from}", which is not a 24-hour time like "10:00".`,
      );
    }
    if (!HHMM_OR_END_OF_DAY.test(to)) {
      throw badRequest(
        'invalid_business_hours',
        `${field}.${session} closes at "${to}", which is not a 24-hour time like "21:00".`,
      );
    }
  }

  return parsed.data;
}
