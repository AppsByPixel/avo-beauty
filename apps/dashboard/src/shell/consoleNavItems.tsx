import type { ReactNode } from 'react';
import type { PlatformSection } from '../auth/platformAdmin.js';

export interface ConsoleNavItem {
  id: string;
  label: string;
  to: string;
  icon: ReactNode;
  /** Built in this phase. The rest are in the nav because the console design has them. */
  built: boolean;
  title: string;
  subtitle: string;
  /**
   * The `requirePlatform` section the API gates this with, or null where no
   * endpoint exists yet.
   *
   * NULL IS NOT "UNGATED", IT IS "UNBUILT ON THE SERVER". Billing has no route at
   * all, and Analytics, Activity and Audit are listed by the design but their
   * endpoints (`GET /platform/metrics`, the platform-wide audit read) do not
   * exist — so there is nothing to gate yet and nothing to render. Writing the
   * distinction down is the lesson from Settings sitting in the wrong column for
   * weeks: an absent gate and a gate nobody needed look identical in a diff.
   */
  section: PlatformSection | null;
}

const stroke = { stroke: 'currentColor', strokeWidth: 1.7, fill: 'none' } as const;

/** Icons and copy transcribed from AVO Owner Console.dc.html. */
export const CONSOLE_NAV_ITEMS: ConsoleNavItem[] = [
  {
    id: 'analytics',
    label: 'Analytics',
    to: '/console/analytics',
    built: true,
    section: 'analytics',
    title: 'Analytics',
    subtitle: 'How AVO is performing across every salon',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M3 17V9M8 17V4M13 17v-6M18 17V7" {...stroke} strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'activity',
    label: 'Activity',
    to: '/console/activity',
    built: false,
    section: 'activity',
    title: 'Activity',
    subtitle: 'Live events across every salon',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M2.5 10h4l2-4 3 8 2.5-4h3.5" {...stroke} strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'salons',
    label: 'Salons',
    to: '/console/salons',
    built: false,
    section: 'salons',
    title: 'Salons',
    subtitle: 'Open a salon to edit its setup and loyalty',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M3 17V8l7-4 7 4v9" {...stroke} strokeLinejoin="round" />
        <path d="M8 17v-4h4v4" {...stroke} strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'accounts',
    label: 'Accounts',
    to: '/console/accounts',
    built: false,
    section: 'accounts',
    title: 'Accounts',
    subtitle: 'Every customer and staff account on the platform',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="7.5" cy="7.5" r="4" {...stroke} />
        <path d="M10.5 10.5 16 16" {...stroke} strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'admins',
    label: 'Admins',
    to: '/console/admins',
    built: true,
    section: 'admins',
    title: 'Admins',
    subtitle: 'Owner-console users and their authority',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="7" cy="7" r="3" {...stroke} />
        <path d="M2.5 16.5c0-2.6 2-4.2 4.5-4.2s4.5 1.6 4.5 4.2" {...stroke} strokeLinecap="round" />
        <path d="M14 5.5l1.4 1.4L18 4.3" {...stroke} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'approvals',
    label: 'Approvals',
    to: '/console/approvals',
    built: true,
    section: 'approvals',
    title: 'Approvals',
    subtitle: 'Salon campaigns waiting on AVO, and the platform throttle',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M4 10.5l3.2 3.2L16 5" {...stroke} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M3 16.5h9" {...stroke} strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'policies',
    label: 'Policies',
    to: '/console/policies',
    built: true,
    section: 'policies',
    title: 'Policies',
    subtitle: 'The legal documents every wallet shows — draft, version and publish',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M5 2.5h7l3 3v12H5z" {...stroke} strokeLinejoin="round" />
        <path d="M7.5 8.5h5M7.5 11.5h5M7.5 14.5h3" {...stroke} strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'billing',
    label: 'Billing',
    to: '/console/billing',
    built: false,
    // No endpoint of any kind, so no section to name. See the interface docstring.
    section: null,
    title: 'Billing',
    subtitle: 'Commission and platform revenue',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
        <rect x="2.5" y="5" width="15" height="10.5" rx="2" {...stroke} />
        <path d="M2.5 8.5h15" {...stroke} />
      </svg>
    ),
  },
  {
    id: 'audit',
    label: 'Audit log',
    to: '/console/audit',
    built: true,
    section: 'audit',
    title: 'Audit log',
    subtitle: 'Every action on the platform, and who took it',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M5 3h10v14l-2.5-1.7L10 17l-2.5-1.7L5 17z" {...stroke} strokeLinejoin="round" />
        <path d="M8 7.5h4M8 10.5h4" {...stroke} strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'controls',
    label: 'Controls',
    to: '/console/controls',
    built: true,
    section: 'controls',
    title: 'Controls',
    subtitle: 'Platform-wide settings',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M3 6h9M15 6h2M3 14h2M8 14h9" {...stroke} strokeLinecap="round" />
        <circle cx="13.5" cy="6" r="2" {...stroke} />
        <circle cx="6.5" cy="14" r="2" {...stroke} />
      </svg>
    ),
  },
];

export function consoleNavItemFor(pathname: string): ConsoleNavItem | undefined {
  return CONSOLE_NAV_ITEMS.find(
    (item) => pathname === item.to || pathname.startsWith(`${item.to}/`),
  );
}
