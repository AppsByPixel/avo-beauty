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

/**
 * What a switch has to WRITE, as opposed to what it has to say.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * `directionOutcome` answers "does she have to restart?". That is not the same
 * question as "what should the persisted flag say?", and treating it as one is a
 * defect that was DRIVEN on the dev client rather than reasoned about:
 *
 *   start: mirrored Arabic app       forceRTL: true   isRTL: true
 *   tap EN                           forceRTL: false  isRTL: true   notice shown
 *   tap العربية                       forceRTL: FALSE  isRTL: true   notice GONE
 *
 * The second tap asks `directionOutcome` and is told 'unchanged' — truthfully,
 * because Yoga is already laying out RTL and Arabic wants RTL, so no restart is
 * owed. The old call site took that as "nothing to do" and wrote no flag. But
 * the flag had already been moved to `false` by the EN tap, and nothing moved it
 * back. She is left on a screen that looks settled — Arabic copy, mirrored
 * layout, no notice — whose NEXT launch comes back left-to-right.
 *
 * The confusion is between two different "currents": the direction Yoga is
 * laying out with (`I18nManager.isRTL`, fixed at bridge start) and the direction
 * PERSISTED for the next launch (`forceRTL`). They are equal on a quiet launch
 * and diverge the moment a switch is pending, which is exactly when a customer
 * is most likely to tap again.
 *
 * So the flag is written on EVERY native switch, to `isRtl(next)`, and the
 * comparison decides only whether a restart is still owed. `forceRTL` is an
 * idempotent NSUserDefaults write; writing it when it already agrees costs
 * nothing, and NOT writing it costs a wrong layout.
 *
 * `flag: null` on web is the same guard `directionOutcome` already carries, in
 * the form the call site needs: web must not touch `I18nManager` at all, not
 * "touch it with the value it already had".
 * ═════════════════════════════════════════════════════════════════════════════
 */
export interface DirectionEffect {
  /**
   * The value to pass to `I18nManager.forceRTL`, or null to touch nothing.
   * Null only on web, where direction changes live and `I18nManager` is not the
   * mechanism.
   */
  flag: boolean | null;
  /** Whether the restart notice is owed — the layout in force is still wrong. */
  pendingRestart: boolean;
}

export function directionEffect(input: DirectionInput): DirectionEffect {
  const outcome = directionOutcome(input);
  if (outcome === 'live') return { flag: null, pendingRestart: false };
  return { flag: isRtl(input.next), pendingRestart: outcome === 'restart-required' };
}
