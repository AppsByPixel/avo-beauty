/**
 * THE DIGIT RULE. Read this before you interpolate a number into Arabic copy.
 *
 * Non-negotiable #12 says "Western digits for money". That sentence is precise,
 * not general: **money is the exception, not the rule.** Everything else in
 * Arabic uses Eastern Arabic-Indic numerals, and the design says so in its own
 * copy (design/AVO Wallet Home.dc.html, the `ar` block at line 1274):
 *
 *     '٦ زيارات للذهبية'            6 visits to Gold          Eastern
 *     'فضية · مكافأة +١٠٪'          Silver · bonus +10%       Eastern, and ٪ not %
 *     'السبت ١٢ يوليو · ٤:٣٠ م'      Sat 12 July · 4:30 PM     Eastern
 *     'أدخلي الرمز المكوّن من ٤ أرقام'  the 4-digit code          Eastern
 *     'عربون 5.000 د.ك'             deposit 5.000 KD          WESTERN — money
 *
 * So there are two ways to get this wrong and they look equally foreign to a
 * Kuwaiti reader:
 *
 *   1. Eastern digits in a money figure  → "٢٤٫٥٠٠ د.ك". Wrong.
 *   2. Western digits in a count/date    → "6 زيارات للذهبية". Wrong.
 *
 * WHICH SIDE EACH HELPER IS ON IS IN ITS NAME.
 *
 *   toEasternDigits()   Western → Eastern.  For counts, dates, times,
 *                       percentages, PIN lengths, ordinals — never money.
 *   formatMoney()       from @avo/types. Already Western in both languages,
 *                       already carries the right unit (KD / د.ك). Its output
 *                       must NEVER be passed through toEasternDigits().
 *
 * There is deliberately no `toWesternDigits`. Nothing in this app ever needs to
 * convert back — money is produced Western at the display boundary and stays
 * that way. A round-trip helper would only ever be used to undo a mistake that
 * should not have been made.
 */

/** Index = the Western digit it replaces. U+0660–U+0669. */
const EASTERN = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'] as const;

/**
 * The Arabic percent sign, U+066A. The design writes `مكافأة +١٠٪`, never
 * `+10%` and never `+١٠%` — the sign is mirrored along with the digits.
 */
export const ARABIC_PERCENT = '٪';

/**
 * Western digits → Eastern Arabic-Indic digits.
 *
 * NOT FOR MONEY. Everything else: `${toEasternDigits(6)} زيارات`.
 *
 * Non-digit characters pass through untouched, so this is safe to run over a
 * whole formatted string ("4:30 م" → "٤:٣٠ م").
 */
export function toEasternDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (d) => EASTERN[Number(d)]!);
}

/**
 * Does this string contain a Western digit?
 *
 * Used by the copy tests, which is where the rule is actually enforced: every
 * Arabic string that takes a number is called with a number and asserted to
 * come back with no `[0-9]` in it. That catches the naive build directly rather
 * than relying on a reviewer noticing a `6` in a line of Arabic.
 */
export function hasWesternDigits(value: string): boolean {
  return /[0-9]/.test(value);
}

/** The mirror check, for the English copy tests. */
export function hasEasternDigits(value: string): boolean {
  return /[٠-٩]/.test(value);
}
