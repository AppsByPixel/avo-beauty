/**
 * Settings → Booking policy — the editor's rules against the server's.
 *
 * `api/src/services/bookingPolicy.ts` is the specification. The bounds and the
 * sentences are READ OUT OF THAT FILE rather than retyped here: a copy of the
 * server's rule inside the test agrees with the client exactly until the day
 * api/ retunes it, which is the drift this file exists to refuse.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.js';
import { stripComments } from '../testing/stripComments.js';
import {
  MAX_CANCELLATION_RULES,
  MAX_HOURS_BEFORE,
  MAX_POLICY_TEXT,
  MESSAGES,
  draftFrom,
  draftToInput,
  fieldForServerError,
  ruleSentence,
  validateDraft,
  validateRules,
  type DraftRule,
} from './bookingPolicyRules.js';

const REPO = join(__dirname, '..', '..', '..', '..');
const SERVICE = stripComments(
  readFileSync(join(REPO, 'api/src/services/bookingPolicy.ts'), 'utf8'),
);

function serverConstant(name: string): number {
  const found = new RegExp(`export const ${name}\\s*=\\s*([\\d_]+)`).exec(SERVICE);
  expect(found?.[1], `${name} not found in services/bookingPolicy.ts`).toBeTruthy();
  return Number((found?.[1] ?? '').replace(/_/g, ''));
}

/**
 * The service's source with `'…' +\n '…'` joins collapsed and the three bounds
 * substituted into its templates, so a message can be looked for as the string
 * a merchant actually receives.
 */
const SERVER_TEXT = SERVICE.replace(/'\s*\+\s*'/g, '')
  .replace(/\$\{MAX_HOURS_BEFORE\}/g, String(serverConstant('MAX_HOURS_BEFORE')))
  .replace(/\$\{MAX_CANCELLATION_RULES\}/g, String(serverConstant('MAX_CANCELLATION_RULES')))
  .replace(/\$\{MAX_POLICY_TEXT\}/g, String(serverConstant('MAX_POLICY_TEXT')));

const rows = (...pairs: Array<[string, string]>): DraftRule[] =>
  pairs.map(([hours, percent]) => ({ hours, percent }));

describe('the bounds and the sentences are the server’s', () => {
  it('uses the server’s three bounds', () => {
    expect(MAX_CANCELLATION_RULES).toBe(serverConstant('MAX_CANCELLATION_RULES'));
    expect(MAX_HOURS_BEFORE).toBe(serverConstant('MAX_HOURS_BEFORE'));
    expect(MAX_POLICY_TEXT).toBe(serverConstant('MAX_POLICY_TEXT'));
  });

  it.each(Object.entries(MESSAGES))('says %s in the server’s words', (_key, message) => {
    expect(SERVER_TEXT, `"${message}" is not a sentence services/bookingPolicy.ts sends`).toContain(
      message,
    );
  });
});

describe('form validation matches the server’s rules', () => {
  it('accepts up to three strictly descending cut-offs with non-increasing percents', () => {
    expect(validateRules(rows(['48', '100'], ['24', '50'], ['2', '50']))).toEqual([null, null, null]);
    expect(validateRules([])).toEqual([]);
  });

  it.each([
    ['0', 'zero'],
    ['721', 'over thirty days'],
    ['1.5', 'a fraction'],
    ['', 'empty'],
    ['12abc', 'not a number'],
    ['-3', 'negative'],
  ])('refuses hours of %s (%s) with the server’s sentence', (hours) => {
    expect(validateRules(rows([hours, '100']))).toEqual([{ field: 'hours', message: MESSAGES.hours }]);
  });

  it('accepts the bounds themselves: 1 hour and 720 hours', () => {
    expect(validateRules(rows(['720', '100'], ['1', '0']))).toEqual([null, null]);
  });

  it.each([['101'], ['-1'], ['50.5'], ['']])('refuses a percent of %s', (percent) => {
    expect(validateRules(rows(['24', percent]))).toEqual([
      { field: 'percent', message: MESSAGES.percent },
    ]);
  });

  it('accepts 0% and 100%', () => {
    expect(validateRules(rows(['24', '100'], ['2', '0']))).toEqual([null, null]);
  });

  it('refuses a cut-off that is not strictly earlier than the one above — equal included', () => {
    expect(validateRules(rows(['24', '100'], ['24', '50']))[1]).toEqual({
      field: 'hours',
      message: MESSAGES.descending,
    });
    expect(validateRules(rows(['2', '100'], ['24', '50']))[1]).toEqual({
      field: 'hours',
      message: MESSAGES.descending,
    });
  });

  it('refuses a later cut-off that returns more than an earlier one', () => {
    expect(validateRules(rows(['24', '50'], ['2', '100']))[1]).toEqual({
      field: 'percent',
      message: MESSAGES.increasing,
    });
  });

  it('checks hours before order, as the server does', () => {
    // Row 2's hours are both out of order AND its percent too high: hours wins.
    expect(validateRules(rows(['24', '50'], ['48', '100']))[1]?.message).toBe(MESSAGES.descending);
  });

  it('does not compare a row with a row above it that is itself invalid', () => {
    expect(validateRules(rows(['0', '100'], ['48', '100']))).toEqual([
      { field: 'hours', message: MESSAGES.hours },
      null,
    ]);
  });

  it('refuses a fourth cut-off', () => {
    const draft = { ...draftFrom(null), textEn: 'x', rules: rows(['4', '100'], ['3', '90'], ['2', '80'], ['1', '70']) };
    expect(validateDraft(draft).rules).toBe(MESSAGES.tooMany);
    expect(draftToInput(draft)).toBeNull();
  });

  it('needs English text, trimmed, and at most 1000 characters in either language', () => {
    const base = draftFrom(null);
    expect(validateDraft({ ...base, textEn: '   ' }).textEn).toBe(MESSAGES.textEn);
    expect(validateDraft({ ...base, textEn: 'a'.repeat(1001) }).textEn).toBe(MESSAGES.textTooLong);
    expect(validateDraft({ ...base, textEn: `  ${'a'.repeat(1000)}  ` }).textEn).toBeNull();
    expect(validateDraft({ ...base, textEn: 'ok', textAr: 'ب'.repeat(1001) }).textAr).toBe(
      MESSAGES.textTooLong,
    );
    // Arabic is optional.
    expect(validateDraft({ ...base, textEn: 'ok', textAr: '' }).textAr).toBeNull();
  });

  it('builds the PUT body the server expects, trimmed, with nothing extra', () => {
    const input = draftToInput({
      noShow: 'keep',
      rules: rows([' 24 ', '100'], ['2', '50']),
      textEn: '  Cancel a day ahead.  ',
      textAr: '  ',
    });
    expect(input).toEqual({
      noShow: 'keep',
      cancellation: [
        { hoursBefore: 24, returnPercent: 100 },
        { hoursBefore: 2, returnPercent: 50 },
      ],
      text: { en: 'Cancel a day ahead.', ar: '' },
    });
  });
});

describe('server 400s are placed on the row they name, verbatim', () => {
  const refusal = (code: string, message: string, details: Record<string, unknown> = {}) =>
    new ApiError(message, { status: 400, code, details });

  it.each([
    ['invalid_hours_before', 'hours'],
    ['hours_before_not_descending', 'hours'],
    ['invalid_return_percent', 'percent'],
    ['return_percent_increasing', 'percent'],
  ] as const)('puts %s on its row’s %s field', (code, field) => {
    const placed = fieldForServerError(refusal(code, 'The server’s own sentence.', { index: 2 }));
    expect(placed?.rows).toEqual([null, null, { field, message: 'The server’s own sentence.' }]);
    expect(placed?.general).toBeNull();
  });

  it('puts too many rules on the list, not a row', () => {
    const placed = fieldForServerError(
      refusal('too_many_cancellation_rules', MESSAGES.tooMany, { max: 3, got: 4 }),
    );
    expect(placed?.rules).toBe(MESSAGES.tooMany);
  });

  it('puts an over-long text on the language the server names', () => {
    expect(
      fieldForServerError(refusal('policy_text_too_long', MESSAGES.textTooLong, { lang: 'ar' }))?.textAr,
    ).toBe(MESSAGES.textTooLong);
    expect(
      fieldForServerError(refusal('policy_text_too_long', MESSAGES.textTooLong, { lang: 'en' }))?.textEn,
    ).toBe(MESSAGES.textTooLong);
    expect(fieldForServerError(refusal('invalid_policy_text', MESSAGES.textEn))?.textEn).toBe(
      MESSAGES.textEn,
    );
  });

  it('keeps an unknown 400 as a general message, and leaves anything else to WriteError', () => {
    expect(fieldForServerError(refusal('invalid_policy', 'Unknown field on the policy: x.'))?.general).toBe(
      'Unknown field on the policy: x.',
    );
    expect(fieldForServerError(new ApiError('No.', { status: 403, code: 'forbidden' }))).toBeNull();
    expect(fieldForServerError(new Error('boom'))).toBeNull();
  });
});

describe('the preview sentence', () => {
  it('reads each cut-off and ends with later: nothing', () => {
    expect(
      ruleSentence([
        { hoursBefore: 24, returnPercent: 100 },
        { hoursBefore: 2, returnPercent: 50 },
      ]),
    ).toBe('Cancel 24h+ before: 100% back · 2h+: 50% back · later: nothing');
  });

  it('reads a single cut-off', () => {
    expect(ruleSentence([{ hoursBefore: 48, returnPercent: 80 }])).toBe(
      'Cancel 48h+ before: 80% back · later: nothing',
    );
  });

  it('says so when there are no cut-offs at all', () => {
    expect(ruleSentence([])).toBe('Cancel at any time: nothing back');
  });
});

describe('the starting draft', () => {
  it('loads a published policy as itself', () => {
    expect(
      draftFrom({
        id: 'BP-1',
        salonId: 'SAL-AMARA',
        version: 3,
        noShow: 'keep',
        cancellation: [{ hoursBefore: 24, returnPercent: 100 }],
        text: { en: 'EN', ar: 'AR' },
        publishedAt: '2026-09-29T09:00:00.000Z',
      }),
    ).toEqual({ noShow: 'keep', rules: [{ hours: '24', percent: '100' }], textEn: 'EN', textAr: 'AR' });
  });

  it('starts a salon with none on its current terms — return on a no-show, full return on a cancel', () => {
    expect(draftFrom(null)).toEqual({
      noShow: 'return',
      rules: [{ hours: '1', percent: '100' }],
      textEn: '',
      textAr: '',
    });
  });
});
