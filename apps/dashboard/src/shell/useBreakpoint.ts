import { useSyncExternalStore } from 'react';

/**
 * interaction-spec.md §1. Web surfaces only.
 *
 *   wide        >= 1440   sidebar 232px, content capped at 1180px and centred
 *   base        1200-1439 sidebar 232px, fluid content with 32px gutters
 *   narrow      1024-1199 sidebar collapses to 68px icons, KPI row 2x2
 *   tablet       768-1023 sidebar becomes a top drawer, everything 1-up
 *   unsupported  < 768    "open the dashboard on a larger screen"
 *
 * The last row is the design, not a gap: merchants manage on desktop by design
 * and the phone surface is the staff scanner.
 */
export type Breakpoint = 'wide' | 'base' | 'narrow' | 'tablet' | 'unsupported';

export const SIDEBAR_WIDTH = { full: 232, collapsed: 68 } as const;

export function breakpointFor(width: number): Breakpoint {
  if (width >= 1440) return 'wide';
  if (width >= 1200) return 'base';
  if (width >= 1024) return 'narrow';
  if (width >= 768) return 'tablet';
  return 'unsupported';
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('resize', onChange);
  window.addEventListener('orientationchange', onChange);
  return () => {
    window.removeEventListener('resize', onChange);
    window.removeEventListener('orientationchange', onChange);
  };
}

export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(
    subscribe,
    () => breakpointFor(window.innerWidth),
    () => 'base' as const,
  );
}
