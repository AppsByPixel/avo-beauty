/**
 * THE ACTION ICONS — one set, in the dashboard's existing idiom.
 *
 * `@avo/ui` had no icon set and the repo has no icon dependency. Every icon the
 * product already draws (the sidebar's `navItems.tsx`, the Appointments clock,
 * the week chevrons, the bell) is an inline SVG transcribed from the design
 * file: a 20×20 viewBox, `currentColor`, a 1.6 stroke with round caps and joins,
 * no fill. These follow that idiom exactly, so they sit beside the nav icons as
 * one family and inherit colour — including a white-label palette — from the
 * control they are in. No new dependency (DECISIONS.md, lane C 2026-09-29).
 *
 * DECORATIVE BY CONSTRUCTION: `aria-hidden`, always. The control carries the
 * name; an icon that also announced itself would say it twice.
 */

import type { ReactElement, SVGProps } from 'react';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number };

const stroke = {
  stroke: 'currentColor',
  strokeWidth: 1.6,
  fill: 'none',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function Svg({ size = 16, children, ...rest }: IconProps & { children: ReactElement | ReactElement[] }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

/** Change date/time. The Appointments banner's clock, at control size. */
export function IconClock(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="7.5" {...stroke} />
      <path d="M10 6v4l2.5 1.5" {...stroke} />
    </Svg>
  );
}

/** Reassign. Two opposed arrows: this appointment passes to someone else. */
export function IconSwap(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 7h12l-3-3" {...stroke} />
      <path d="M16.5 13h-12l3 3" {...stroke} />
    </Svg>
  );
}

/** Mark done. */
export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 10.5 8 14l7.5-8" {...stroke} />
    </Svg>
  );
}

/** Cancel appointment. A struck circle, not a bare ✕, so it does not read as "close". */
export function IconCancel(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="7.5" {...stroke} />
      <path d="m7.4 7.4 5.2 5.2M12.6 7.4l-5.2 5.2" {...stroke} />
    </Svg>
  );
}

/** Mark no-show. The Team icon's figure with a cross: a person who did not come. */
export function IconNoShow(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="6.5" r="3" {...stroke} />
      <path d="M2.5 17c0-3 2.4-5 5.5-5 1 0 1.9.2 2.7.6" {...stroke} />
      <path d="m13 12.5 4 4M17 12.5l-4 4" {...stroke} />
    </Svg>
  );
}

/**
 * Export / download. An arrow down onto a tray — the Reports screen's "Export
 * CSV" glyph, redrawn in this set's stroke so it sits beside the others.
 */
export function IconDownload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 3.5v9m0 0 3.5-3.5M10 12.5 6.5 9" {...stroke} />
      <path d="M4 15.5h12" {...stroke} />
    </Svg>
  );
}
