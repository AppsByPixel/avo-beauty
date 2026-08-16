import { useEffect } from 'react';
import { deriveBrandSet } from '@avo/tokens';

/**
 * White-label at runtime.
 *
 * `packages/tokens` emits exactly five overridable custom properties and says so
 * in the stylesheet: "a per-salon build overrides only these five". A salon
 * supplies one hex; `deriveBrandSet` produces the rest and refuses a hex whose
 * `deep` cannot clear 4.5:1 against white — non-negotiable #9, enforced by the
 * shared package rather than re-implemented here.
 *
 * A refusal leaves the sage defaults in place rather than shipping an
 * unreadable button. Onboarding is where a bad hex gets rejected *at the point
 * of entry*; by the time it reaches the dashboard the only safe move is to
 * ignore it and keep going.
 */
export function useBrandTheme(brandHex: string | null | undefined): void {
  useEffect(() => {
    if (!brandHex) return;
    const result = deriveBrandSet(brandHex);
    if (!result.ok) {
      console.warn(`[avo] Ignoring salon brand colour ${brandHex}: ${result.reason}`);
      return;
    }
    const root = document.documentElement;
    const applied: Array<[string, string]> = [
      ['--avo-brand', result.set.brand],
      ['--avo-brand-deep', result.set.deep],
      ['--avo-brand-tint', result.set.tint],
      ['--avo-card-from', result.set.cardFrom],
      ['--avo-card-to', result.set.cardTo],
    ];
    for (const [name, value] of applied) root.style.setProperty(name, value);
    return () => {
      for (const [name] of applied) root.style.removeProperty(name);
    };
  }, [brandHex]);
}
