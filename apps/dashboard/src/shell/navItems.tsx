import type { ReactNode } from 'react';

export interface NavItem {
  id: string;
  label: string;
  /** Route path inside the merchant shell. */
  to: string;
  icon: ReactNode;
  /** Built in this phase. The rest are in the nav because the shell design has them. */
  built: boolean;
  /** Header title and subtitle — AVO Merchant Dashboard.dc.html `titles`. */
  title: string;
  subtitle: string;
}

const stroke = { stroke: 'currentColor', strokeWidth: 1.6, fill: 'none' } as const;

/** Icons transcribed from the design file. Sized 18px, currentColor throughout. */
export const NAV_ITEMS: NavItem[] = [
  {
    id: 'overview',
    label: 'Overview',
    to: '/overview',
    built: true,
    title: 'Overview',
    subtitle: 'How {salon} is doing today',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
        <rect x="2.5" y="2.5" width="6" height="6" rx="1.6" {...stroke} />
        <rect x="11.5" y="2.5" width="6" height="6" rx="1.6" {...stroke} />
        <rect x="2.5" y="11.5" width="6" height="6" rx="1.6" {...stroke} />
        <rect x="11.5" y="11.5" width="6" height="6" rx="1.6" {...stroke} />
      </svg>
    ),
  },
  {
    id: 'appointments',
    label: 'Appointments',
    to: '/appointments',
    built: true,
    title: 'Appointments',
    subtitle: 'Every booking and its deposit status',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
        <rect x="2.5" y="4" width="15" height="13" rx="2.2" {...stroke} />
        <path d="M2.5 8h15M6.5 2.5v3M13.5 2.5v3" {...stroke} strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'team',
    label: 'Team',
    to: '/team',
    built: true,
    title: 'Team',
    subtitle: 'Artists and calendar availability',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="7" cy="7" r="3" {...stroke} />
        <circle cx="13.5" cy="8.5" r="2.4" {...stroke} />
        <path
          d="M2.5 17c0-2.8 2-4.5 4.5-4.5s4.5 1.7 4.5 4.5M13 12.6c2.2.1 4 1.6 4 4.4"
          {...stroke}
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    id: 'shop',
    label: 'Shop',
    to: '/shop',
    built: false,
    title: 'Shop',
    subtitle: 'Flat product catalog',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M5 6.5h10l-.8 10.5H5.8z" {...stroke} strokeLinejoin="round" />
        <path d="M7.5 7V5a2.5 2.5 0 0 1 5 0v2" {...stroke} strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'loyalty',
    label: 'Loyalty',
    to: '/loyalty',
    built: true,
    title: 'Loyalty',
    subtitle: 'The reward mechanic for this salon',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
        <rect
          x="10"
          y="2.6"
          width="10.4"
          height="10.4"
          rx="2"
          transform="rotate(45 10 2.6)"
          {...stroke}
        />
      </svg>
    ),
  },
  {
    id: 'marketing',
    label: 'Marketing',
    to: '/marketing',
    built: false,
    title: 'Marketing',
    subtitle: 'Campaigns, branch boosts and happy hours',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M3 8v4h3l5 3.5V4.5L6 8z" {...stroke} strokeLinejoin="round" />
        <path d="M14.5 7.5a3.5 3.5 0 0 1 0 5" {...stroke} strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'audit',
    label: 'Audit log',
    to: '/audit',
    built: true,
    title: 'Audit log',
    subtitle: 'Every money and permission change, and who made it',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M5 3h10v14l-2.5-1.7L10 17l-2.5-1.7L5 17z" {...stroke} strokeLinejoin="round" />
        <path d="M8 7.5h4M8 10.5h4" {...stroke} strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'reports',
    label: 'Reports',
    to: '/reports',
    built: false,
    title: 'Reports',
    subtitle: 'Export any list as a CSV',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M3 17V9M8 17V4M13 17v-6M18 17V7" {...stroke} strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'accounts',
    label: 'Accounts',
    to: '/accounts',
    built: true,
    title: 'Accounts',
    subtitle: 'Staff access and customer profiles',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="7.5" cy="7.5" r="4" {...stroke} />
        <path d="M10.5 10.5 16 16M13.5 13.5l1.7 1.7" {...stroke} strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'settings',
    label: 'Settings',
    to: '/settings',
    built: true,
    title: 'Settings',
    subtitle: 'Brand kit, modules, deposits, hours and billing',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M3 6h9M15 6h2M3 14h2M8 14h9" {...stroke} strokeLinecap="round" />
        <circle cx="13.5" cy="6" r="2" {...stroke} />
        <circle cx="6.5" cy="14" r="2" {...stroke} />
      </svg>
    ),
  },
];

export function navItemFor(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
}
