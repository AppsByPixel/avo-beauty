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
