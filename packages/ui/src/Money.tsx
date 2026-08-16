import { formatFils, moneyAriaLabel, type Fils, type Language } from '@avo/types';

export interface MoneyProps {
  amount: Fils;
  lang?: Language;
  /** Render the `KD` / `د.ك` suffix inline. Off when the unit sits in its own slot. */
  withUnit?: boolean;
  className?: string;
}

/**
 * The display boundary, and the only one. Formatting comes from `@avo/types` —
 * `formatFils` is the single implementation of "3 decimals, Western digits, in
 * both languages" (non-negotiable #1 and #12).
 *
 * interaction-spec.md §2: `18.000` must read as "eighteen point zero zero zero
 * Kuwaiti dinars", not "eighteen thousand", so the aria-label is not optional.
 */
export function Money({ amount, lang = 'en', withUnit = false, className }: MoneyProps) {
  return (
    <span className={className} aria-label={moneyAriaLabel(amount, lang)}>
      <span aria-hidden="true">
        {formatFils(amount)}
        {withUnit ? ` ${lang === 'ar' ? 'د.ك' : 'KD'}` : ''}
      </span>
    </span>
  );
}
