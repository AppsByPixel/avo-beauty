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
import type { z } from 'zod';
import { ApiError, badRequest } from './errors';

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
 * THE DIVISION OF LABOUR, AND IT MOVED ONCE — read this before editing.
 *
 * It used to read "that schema is `z.tuple([z.string(), z.string()])` — it says
 * two strings, not two clock times… so the shape comes from the shared schema and
 * the clock check is added here". That was true when it was written and is not any
 * more: trunk tightened `BusinessHoursSchema` to validate the clock (`e8ea6b3`,
 * Lane D's finding 3), because a schema that said "two strings" while meaning "two
 * times" made every client and `packages/mock` validate against something that
 * disagreed with this endpoint.
 *
 * So the line is now:
 *
 *   `packages/types`  the SHAPE and the CLOCK. Is this two sessions of two
 *                     well-formed 24-hour times, "00:00".."23:59" or "24:00"?
 *   here              POSITION, and every MESSAGE. "24:00" is a closing time and
 *                     never an opening one, which the shared schema accepts in
 *                     both places — verified at runtime against the built package,
 *                     not inferred. That is the only rule left on this side.
 *
 * WHY THE MESSAGES ARE STILL THIS FUNCTION'S JOB, and why that took a fix. The
 * tightening broke two specs in `fields.test.ts` — correctly. `safeParse` ran
 * first, so a non-clock string now failed THERE and returned the generic shape
 * sentence, and the loop below that names the session and the offending value was
 * never reached. A merchant fixing a typo got `businessHours must be { morning:
 * … }` instead of `businessHours.morning opens at "banana"`, which is the
 * difference between finding the typo and re-reading the docs. The schema's
 * verdict is authoritative; its PHRASING is not, because zod does not know this
 * field is a salon's trading day. `businessHoursRefusal` below turns the verdict
 * into a sentence, driven by zod's own issue PATH so there is nothing here that
 * has to be kept in step with the schema by hand.
 *
 * THE TWO REGEX CHECKS BELOW STAY, in this arrangement, deliberately. Post-schema
 * neither can fire on a clock error any more, and both are still worth their two
 * lines: `HHMM` on `from` IS the position rule (it is the one that excludes
 * "24:00"), and `HHMM_OR_END_OF_DAY` on `to` is the backstop that keeps this
 * endpoint from silently widening if `CLOCK` in `packages/types` is ever loosened
 * — the shared schema describes the wire, this function is the authority on what
 * may be STORED. They are also what Lane D's `endpointAccepts` model mirrors, by
 * name, lifted out of this file as text ("the handler's own two checks using the
 * handler's own two regexes"), and a behaviourally-equivalent rewrite here would
 * make that comment false in a file this lane cannot edit.
 *
 * NO THIRD COPY OF THE CLOCK RULE. `CLOCK` in `packages/types` and
 * `HHMM_OR_END_OF_DAY` here are the two that exist — trunk chose that over
 * inverting the `packages/types` → `api/` dependency — and Lane D computes their
 * agreement over a generated corpus rather than listing it.
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
  if (!parsed.success) throw businessHoursRefusal(value, parsed.error, field);

  for (const session of ['morning', 'evening'] as const) {
    const [from, to] = parsed.data[session];
    /**
     * THE POSITION RULE — the one thing left on this side of the line. The shared
     * schema accepts "24:00" in both slots because it validates one clock at a
     * time and has no notion of which end it is looking at; `HHMM` is the copy
     * that excludes it, so this is where a session that opens at end-of-day is
     * refused. The copy says WHY rather than "not a 24-hour time", which "24:00"
     * plainly is.
     */
    if (!HHMM.test(from)) {
      throw badRequest(
        'invalid_business_hours',
        `${field}.${session} cannot open at "${from}" — end-of-day is a closing time, not an opening one.`,
      );
    }
    /** Unreachable while `CLOCK` and `HHMM_OR_END_OF_DAY` agree. See the header. */
    if (!HHMM_OR_END_OF_DAY.test(to)) {
      throw badRequest(
        'invalid_business_hours',
        `${field}.${session} closes at "${to}", which is not a 24-hour time like "21:00".`,
      );
    }
  }

  return parsed.data;
}

/**
 * The shared schema's verdict, said in this field's own words.
 *
 * DRIVEN BY ZOD'S ISSUE PATH, not by a second copy of the rules. An issue on
 * `["morning", 0]` is all this needs to know to name the session and the end, and
 * the offending value is read back out of the CALLER'S input rather than out of
 * `parsed.data` — which does not exist on a failure. So when trunk tightens
 * `CLOCK` again, the messages keep working with nothing here to update: that is
 * the property the previous version lacked, having put its own check second and
 * let zod answer first.
 *
 * ONLY A STRING GETS THE POSITIONAL SENTENCE. `"banana"` and `"25:00"` are values
 * a person typed into one field, and naming that field is the whole point. A
 * number, a null or an absent element is a document the client assembled wrongly —
 * there is no typo to point at, and the shape sentence is the more useful answer.
 * Everything structural — not an object, a missing session, a range sent as one
 * string, a one-element window — falls through to it too.
 */
function businessHoursRefusal(
  value: unknown,
  error: z.ZodError,
  field: string,
): ApiError {
  for (const issue of error.issues) {
    const [session, index] = issue.path;
    if (
      (session === 'morning' || session === 'evening') &&
      (index === 0 || index === 1)
    ) {
      const supplied = (value as Record<string, unknown[]> | null | undefined)
        ?.[session]?.[index];
      if (typeof supplied === 'string') {
        return badRequest(
          'invalid_business_hours',
          `${field}.${session} ${index === 0 ? 'opens' : 'closes'} at "${supplied}", ` +
            `which is not a 24-hour time like "${index === 0 ? '10:00' : '21:00'}".`,
        );
      }
    }
  }

  return badRequest(
    'invalid_business_hours',
    `${field} must be { morning: ["10:00","13:00"], evening: ["16:00","21:00"] }.`,
  );
}
