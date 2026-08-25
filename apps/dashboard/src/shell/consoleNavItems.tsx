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
   * The endpoint this item's screen loads from — the one whose refusal decides
   * whether the screen can render at all, not every call it makes. `Audit` also
   * reads the salon list to fill a filter picker and `Salons` also reads platform
   * settings for the wizard's deposit default; both of those are courtesy-gated
   * at the call site and degrade to a narrower screen rather than an error.
   *
   * NULL MEANS "NO SUCH ROUTE ON THE SERVER", and it is the only honest reason to
   * leave `section` null. Billing is the sole case.
   *
   * THIS FIELD IS WHY THE GATE BELOW CANNOT GO STALE AGAIN. `consoleNavGates.test.ts`
   * parses `api/src/routes/` for this exact method and path and asserts `section`
   * equals the `requirePlatform` argument it finds there. So the item declares the
   * endpoint — a fact its own screen owns — and the gate is DERIVED rather than
   * transcribed. Transcribing it is what put this file eight weeks behind the API.
   */
  endpoint: string | null;
  /**
   * The `requirePlatform` section the API gates `endpoint` with, or null where
   * there is no endpoint at all.
   *
   * NULL IS NOT "UNGATED", IT IS "UNBUILT ON THE SERVER" — Billing has no route of
   * any kind. Writing the distinction down is the lesson from Settings sitting in
   * the wrong column for weeks: an absent gate and a gate nobody needed look
   * identical in a diff.
   *
   * DO NOT HAND-EDIT THIS TO MATCH A COMMENT. It is asserted against the routes;
   * if the test disagrees with you, the server is right and this field is wrong.
   * The previous docstring here claimed the metrics, activity and audit endpoints
   * "do not exist". All three exist and are gated — `platformConsole.ts:155`,
   * `:848`, `:1068` — and had for some time before anyone noticed, because nothing
   * checked.
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
    endpoint: 'GET /v1/platform/metrics',
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
    endpoint: 'GET /v1/platform/activity',
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
    built: true,
    endpoint: 'GET /v1/platform/salons',
    /*
     * `salons`, and it agrees with the server again.
     *
     * THIS FIELD SAID `analytics` FOR EIGHT WEEKS AFTER THAT STOPPED BEING TRUE,
     * and the story is worth keeping because the mechanism will recur. The old
     * comment here was correct when written: the list really was gated
     * `analytics`, the reasoning was argued, the refusal was driven against a real
     * API, and the note even named its own expiry — "when the per-salon editor and
     * the onboarding wizard land they will be gated on `salons`". Commit 4cc03c5
     * is the one that landed the editor and regated the list. The trigger fired
     * and nobody reread the note, because a comment cannot fail a build.
     *
     * So the fix is not this line. The fix is `consoleNavGates.test.ts`, which
     * derives the gate from `api/src/routes/` and would have gone red on the same
     * commit. This line is now a consequence of that test rather than a claim
     * anyone has to keep in their head.
     *
     * WHAT THE MISMATCH DID WHILE IT LASTED, against the shipped presets in
     * `api/src/db/schema/platformAdmin.ts:162-169` — both directions at once:
     *
     *   analyst   analytics:true  salons:false  sidebar SHOWED Salons → 403 on open
     *   support   analytics:false salons:true   sidebar HID Salons → allowed, never offered
     *
     * The second half is the one that hides: "Support — accounts & salons" is the
     * preset's own description, and the section it is named for was missing from
     * its sidebar. Nobody reports a door they were never shown.
     */
    section: 'salons',
    title: 'Salons',
    /*
     * The design's own subtitle, `AVO Owner Console.dc.html:1144` § titles:
     *
     *     salons: ['Salons', 'Open a salon to edit its setup and loyalty'],
     *
     * IT WAS DROPPED TWICE AND BOTH REASONS ARE NOW SPENT. The first was "there is
     * no endpoint a console admin can use to open one", which 4cc03c5 falsified. The
     * second was narrower and survived it — the endpoints exist but the SCREEN drew
     * no editor, and a header that offers one above a screen that has none is still
     * a false claim. `routes/console/SalonEditor.tsx` closes that, and the row action
     * on the list opens it, so the sentence is true and it is taken back verbatim.
     *
     * It reads correctly over BOTH views. `consoleNavItemFor` matches
     * `/console/salons/$id` through its `startsWith` branch, so this subtitle also
     * sits above the editor itself — where "open a salon to edit its setup and
     * loyalty" describes what the admin is already looking at.
     */
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
    endpoint: 'GET /v1/platform/accounts',
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
    endpoint: 'GET /v1/platform/admins',
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
    endpoint: 'GET /v1/platform/campaigns',
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
    /*
     * The DRAFT read, not `GET /v1/platform/policies` — the published set is
     * public (`platform.ts:526`, no gate at all, the wallet reads it), so gating
     * the sidebar on it would gate on nothing. The draft is what this screen
     * blocks on: `Policies.tsx:63` renders `SectionError` off `draft.isError`.
     * The Support panel below it is a subview and its writes are gated `policies`
     * too (`support.ts:514`), so one section covers the whole screen.
     */
    endpoint: 'GET /v1/platform/policies/draft',
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
    // The test pins both nulls together: a route appearing for Billing without a
    // section named here goes red rather than shipping an ungated-looking item.
    endpoint: null,
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
    endpoint: 'GET /v1/platform/audit',
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
    endpoint: 'GET /v1/platform/settings',
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
