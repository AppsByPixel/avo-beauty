import type { BookingPolicy, CancellationRule } from '@avo/types';
import { ApiError } from '../api/client.js';
import type { BookingPolicyInput } from '../api/bookingPolicy.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BOOKING POLICY EDITOR'S RULES — THE SERVER'S, RESTATED, NEVER RELAXED
 * ═══════════════════════════════════════════════════════════════════════════
 * `api/src/services/bookingPolicy.ts § parseCancellationRules` and `parseText`
 * are the specification. The form checks the same things in the same order and
 * says them in THE SERVER'S OWN SENTENCES, so a merchant reads one message for
 * one mistake whichever side catches it. The form is a courtesy; the `PUT` is the
 * control, and every server `400` is still mapped back to the row it names —
 * `fieldForServerError` below — because the next client will not have this file.
 *
 * `bookingPolicyRules.test.ts` reads the server's messages and bounds out of
 * `services/bookingPolicy.ts` and checks this file against them, so a retuned
 * bound or a reworded sentence fails at this lane's gate rather than as a
 * mismatch under a merchant's hand.
 */

/** "Up to three" — DECISIONS, the fourth list. `MAX_CANCELLATION_RULES` on the server. */
export const MAX_CANCELLATION_RULES = 3;
/** Thirty days. `MAX_HOURS_BEFORE` on the server. */
export const MAX_HOURS_BEFORE = 720;
/** Per language, after trimming. `MAX_POLICY_TEXT` on the server. */
export const MAX_POLICY_TEXT = 1000;

/** The server's sentences, verbatim. */
export const MESSAGES = {
  hours: `hoursBefore must be a whole number of hours from 1 to ${MAX_HOURS_BEFORE}.`,
  percent: 'returnPercent must be a whole number from 0 to 100.',
  descending:
    'List the cancellation rules from the earliest cut-off to the latest: each ' +
    'hoursBefore must be smaller than the one before it.',
  increasing:
    'A later cancellation cannot return more than an earlier one: each ' +
    'returnPercent must be no higher than the one before it.',
  tooMany: `A policy can have at most ${MAX_CANCELLATION_RULES} cancellation rules.`,
  textEn: 'The policy needs its English text.',
  textTooLong: `The policy text can be at most ${MAX_POLICY_TEXT} characters.`,
} as const;

/** One row as the merchant typed it. Strings, because an input holds a string. */
export interface DraftRule {
  hours: string;
  percent: string;
}

export interface PolicyDraft {
  noShow: BookingPolicy['noShow'];
  rules: DraftRule[];
  textEn: string;
  textAr: string;
}

export interface RowError {
  field: 'hours' | 'percent';
  message: string;
}

export interface DraftErrors {
  /** Index-aligned with `draft.rules`; `null` where the row is fine. */
  rows: (RowError | null)[];
  /** A fault with the list as a whole — too many rows. */
  rules: string | null;
  textEn: string | null;
  textAr: string | null;
  noShow: string | null;
  /** A refusal the editor cannot place on a field. Rendered verbatim. */
  general: string | null;
}

export const NO_ERRORS: DraftErrors = {
  rows: [],
  rules: null,
  textEn: null,
  textAr: null,
  noShow: null,
  general: null,
};

export function hasErrors(errors: DraftErrors): boolean {
  return (
    errors.rows.some((r) => r !== null) ||
    errors.rules !== null ||
    errors.textEn !== null ||
    errors.textAr !== null ||
    errors.noShow !== null ||
    errors.general !== null
  );
}

/**
 * A whole number, or null. `Number('')` is 0 and `Number('1.5')` is 1.5, so the
 * test is the digits, not the conversion: the server refuses anything that is not
 * `Number.isSafeInteger`, and "12abc" or "1e2" must not slip through as a number.
 */
function wholeNumber(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * The server's four row checks, in the server's order, one message per row.
 *
 * THE SERVER STOPS AT THE FIRST BAD ROW; THIS CHECKS EVERY ROW. Same rules, but
 * a form that reveals one mistake per Publish press is a worse form, and the
 * sentences are per-row already. A row is compared with the row above only when
 * the row above is itself valid — which is what the server's `rules[index - 1]`
 * means, since it never holds a row that failed.
 */
export function validateRules(rows: readonly DraftRule[]): (RowError | null)[] {
  const out: (RowError | null)[] = [];
  let prev: CancellationRule | null = null;
  rows.forEach((row) => {
    const hours = wholeNumber(row.hours);
    const percent = wholeNumber(row.percent);
    let error: RowError | null = null;
    if (hours === null || hours < 1 || hours > MAX_HOURS_BEFORE) {
      error = { field: 'hours', message: MESSAGES.hours };
    } else if (percent === null || percent < 0 || percent > 100) {
      error = { field: 'percent', message: MESSAGES.percent };
    } else if (prev && hours >= prev.hoursBefore) {
      error = { field: 'hours', message: MESSAGES.descending };
    } else if (prev && percent > prev.returnPercent) {
      error = { field: 'percent', message: MESSAGES.increasing };
    }
    out.push(error);
    prev = error === null && hours !== null && percent !== null
      ? { hoursBefore: hours, returnPercent: percent }
      : null;
  });
  return out;
}

export function validateDraft(draft: PolicyDraft): DraftErrors {
  const en = draft.textEn.trim();
  const ar = draft.textAr.trim();
  return {
    rows: validateRules(draft.rules),
    rules: draft.rules.length > MAX_CANCELLATION_RULES ? MESSAGES.tooMany : null,
    textEn: en.length === 0 ? MESSAGES.textEn : en.length > MAX_POLICY_TEXT ? MESSAGES.textTooLong : null,
    textAr: ar.length > MAX_POLICY_TEXT ? MESSAGES.textTooLong : null,
    noShow: null,
    general: null,
  };
}

/** The valid rules, or null if any row is not. */
export function parsedRules(rows: readonly DraftRule[]): CancellationRule[] | null {
  if (validateRules(rows).some((e) => e !== null)) return null;
  return rows.map((r) => ({
    hoursBefore: Number(r.hours.trim()),
    returnPercent: Number(r.percent.trim()),
  }));
}

/** The `PUT` body, trimmed as the server trims. Null while the draft is invalid. */
export function draftToInput(draft: PolicyDraft): BookingPolicyInput | null {
  if (hasErrors(validateDraft(draft))) return null;
  const cancellation = parsedRules(draft.rules);
  if (cancellation === null) return null;
  return {
    noShow: draft.noShow,
    cancellation,
    text: { en: draft.textEn.trim(), ar: draft.textAr.trim() },
  };
}

/**
 * The editor's starting point.
 *
 * A PUBLISHED POLICY LOADS AS ITSELF. With none, the draft is the salon's
 * CURRENT terms written as a policy — the no-show returns, a cancel returns in
 * full — so the first thing she sees is what already happens rather than a
 * harsher rule she did not choose. It is a draft: nothing changes until Publish.
 */
export function draftFrom(policy: BookingPolicy | null): PolicyDraft {
  if (policy === null) {
    return { noShow: 'return', rules: [{ hours: '1', percent: '100' }], textEn: '', textAr: '' };
  }
  return {
    noShow: policy.noShow,
    rules: policy.cancellation.map((r) => ({
      hours: String(r.hoursBefore),
      percent: String(r.returnPercent),
    })),
    textEn: policy.text.en,
    textAr: policy.text.ar,
  };
}

/**
 * The rule as she will read it, e.g.
 * "Cancel 24h+ before: 100% back · 2h+: 50% back · later: nothing".
 *
 * Built from the PARSED rules, never from the inputs, so the sentence cannot
 * describe a row the server would refuse. No rules at all is a real policy —
 * every cancel keeps the whole deposit — and it says so.
 */
export function ruleSentence(rules: readonly CancellationRule[]): string {
  if (rules.length === 0) return 'Cancel at any time: nothing back';
  const parts = rules.map((r, i) =>
    i === 0
      ? `Cancel ${r.hoursBefore}h+ before: ${r.returnPercent}% back`
      : `${r.hoursBefore}h+: ${r.returnPercent}% back`,
  );
  return [...parts, 'later: nothing'].join(' · ');
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A SERVER `400`, PUT BACK ON THE ROW IT NAMES
 * ═══════════════════════════════════════════════════════════════════════════
 * The server attaches `index` (0-based) to every per-row refusal and `lang` to a
 * text that is too long. The MESSAGE is always the server's, verbatim — this only
 * decides where it goes. Anything unplaceable is `general`, still verbatim.
 * Returns null for an error that is not a `400` this editor knows, so the caller
 * falls back to the screen's `WriteError`.
 */
export function fieldForServerError(error: unknown): DraftErrors | null {
  if (!(error instanceof ApiError) || error.status !== 400) return null;
  const index = typeof error.details.index === 'number' ? error.details.index : null;
  const at = (field: RowError['field']): DraftErrors => {
    if (index === null) return { ...NO_ERRORS, rules: error.message };
    const rows: (RowError | null)[] = [];
    rows[index] = { field, message: error.message };
    return { ...NO_ERRORS, rows: Array.from(rows, (r) => r ?? null) };
  };
  switch (error.code) {
    case 'invalid_hours_before':
    case 'hours_before_not_descending':
      return at('hours');
    case 'invalid_return_percent':
    case 'return_percent_increasing':
      return at('percent');
    case 'invalid_cancellation_rules':
      return index === null ? { ...NO_ERRORS, rules: error.message } : at('hours');
    case 'too_many_cancellation_rules':
      return { ...NO_ERRORS, rules: error.message };
    case 'policy_text_too_long':
      return error.details.lang === 'ar'
        ? { ...NO_ERRORS, textAr: error.message }
        : { ...NO_ERRORS, textEn: error.message };
    case 'invalid_policy_text':
      return /text\.ar/.test(error.message)
        ? { ...NO_ERRORS, textAr: error.message }
        : { ...NO_ERRORS, textEn: error.message };
    case 'invalid_no_show_rule':
      return { ...NO_ERRORS, noShow: error.message };
    default:
      return { ...NO_ERRORS, general: error.message };
  }
}
