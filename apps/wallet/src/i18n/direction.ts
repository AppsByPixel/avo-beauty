/**
 * What a language switch has to do about LAYOUT direction, per target.
 *
 * Lifted out of `LanguageProvider.setLang`, where it was three inline branches —
 * and one of them is a guard rather than a preference: the web build must never
 * ask a customer to restart. Web has no restart to offer, `expo-updates` is a
 * native module, and the direction has already changed by the time the question
 * could be asked. A guard that cannot be tested is a guard on trust.
 *
 * `i18n/language.tsx` carries the whole argument for why the two targets differ.
 * This carries only the decision.
 */

import type { Language } from '@avo/types';

/**
 * Arabic is the only RTL language the product ships.
 *
 * It LIVES HERE, and `language.tsx` re-exports it, rather than the other way
 * round. The direction rule is the thing this module is about, and importing it
 * from the provider would make every consumer of the rule pull a `.tsx` file
 * containing a React context in behind it — which is also, concretely, what
 * broke: vitest's SSR transform could not parse `language.tsx`, so a test of
 * three pure branches died on a JSX module it had no reason to load.
 */
export function isRtl(lang: Language): boolean {
  return lang === 'ar';
}

export type DirectionOutcome =
  /** The layout has already turned around, or will on this commit. Web. */
  | 'live'
  /** The native flag is written; Yoga will not read it until the next launch. */
  | 'restart-required'
  /** Nothing to do — the direction in force is already the one wanted. */
  | 'unchanged';

export interface DirectionInput {
  /** `Platform.OS`. */
  platform: string;
  /** `I18nManager.isRTL` — the direction Yoga is currently laying out with. */
  currentIsRtl: boolean;
  next: Language;
}

export function directionOutcome({ platform, currentIsRtl, next }: DirectionInput): DirectionOutcome {
  if (platform === 'web') return 'live';
  return currentIsRtl === isRtl(next) ? 'unchanged' : 'restart-required';
}
