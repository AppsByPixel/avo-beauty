/**
 * The money boundary.
 *
 * `fils()` from @avo/types throws on a non-integer. That is exactly right for a
 * programming error and exactly wrong for a request body: a client sending
 * `18.5` (meaning 18.500 KD) gets a 500 and the sentence "Money must be an
 * integer number of fils, got 18.5. Did a float or a KWD amount reach this
 * call?" — an internal message, on an internal-error status, for a mistake the
 * client could fix if we told it.
 *
 * So nothing calls `fils()` on untrusted input directly. Input crosses through
 * here first, and this module answers with an ApiError carrying a 400 and copy
 * a client can act on. Lane D's finding #4.
 */

import { fils, type Fils } from '@avo/types';
import { badRequest } from '../http/errors';

/**
 * A positive whole number of fils, from a request body.
 *
 * Rejects, with a 400 each: a non-number, NaN/Infinity, a fraction (the KWD
 * mix-up), zero and anything negative. A negative amount is called out
 * separately because "top up −10.000" is not a typo, it is a drain path dressed
 * as a top-up, and Lane D found the mock issuing an intent for it.
 */
export function parseAmountFils(value: unknown, field = 'amountFils'): Fils {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw badRequest(
      'invalid_amount',
      `${field} must be a number of fils, e.g. 10000 for 10.000 KD.`,
    );
  }
  if (!Number.isFinite(value)) {
    throw badRequest('invalid_amount', `${field} must be a finite number of fils.`);
  }
  if (!Number.isInteger(value)) {
    throw badRequest(
      'invalid_amount',
      `${field} must be a whole number of fils. 10.000 KD is 10000, not 10.5.`,
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw badRequest('invalid_amount', `${field} is out of range.`);
  }
  if (value <= 0) {
    throw badRequest('invalid_amount', `${field} must be greater than zero.`);
  }
  return fils(value);
}

/** A non-negative amount — a held deposit or a bonus may legitimately be zero. */
export function parseNonNegativeFils(value: unknown, field: string): Fils {
  if (value === 0) return fils(0);
  return parseAmountFils(value, field);
}

/** A required, non-empty string field. */
export function requireString(value: unknown, field: string, max = 500): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest('invalid_request', `${field} is required.`);
  }
  if (value.length > max) {
    throw badRequest('invalid_request', `${field} is too long.`);
  }
  return value.trim();
}

/** A required array of non-empty strings, with a sane cap. */
export function requireStringArray(value: unknown, field: string, max = 50): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest('invalid_request', `${field} must be a non-empty array.`);
  }
  if (value.length > max) {
    throw badRequest('invalid_request', `${field} has too many entries.`);
  }
  for (const v of value) {
    if (typeof v !== 'string' || v.trim() === '') {
      throw badRequest('invalid_request', `${field} must contain only non-empty strings.`);
    }
  }
  return value.map((v: string) => v.trim());
}
