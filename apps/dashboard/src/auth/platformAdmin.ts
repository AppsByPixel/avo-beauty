/**
 * The owner console's admin shape.
 *
 * DEFINED HERE RATHER THAN IN `packages/types`, AND THAT IS A REPORTED GAP.
 *
 * Every other entity this app parses comes from the trunk contract, which is
 * what makes `STATUS.md`'s recurring trap — "a schema narrower than the wire is
 * not a smaller contract, it is a lossy one" — catchable by
 * `e2e/contract.test.ts`. There is no `PlatformAdminSchema` in `packages/types`,
 * so this one is local, which means the drift guard cannot see it and a field the
 * API adds to `serialisePlatformAdmin` would be stripped here silently.
 *
 * `packages/types` is trunk-owned and a change there is a four-way rebase, so
 * this is not smuggled in from a lane. It is in the lane report: the schema
 * belongs beside `StaffUserSchema`, and until it moves, this file is the thing
 * to update when the API's admin shape changes.
 *
 * It is still a PARSE and not a cast. `serialisePlatformAdmin` in
 * api/src/routes/platformAdmins.ts is the shape, field for field, and parsing at
 * the boundary means a response missing `sections` fails at sign-in rather than
 * rendering a console with an empty sidebar one route later.
 */

/** api/src/db/schema/platformAdmin.ts § PLATFORM_SECTIONS — nine, not the design's six. */
export const PLATFORM_SECTIONS = [
  'analytics',
  'activity',
  'salons',
  'accounts',
  'admins',
  'controls',
  'approvals',
  'policies',
  'audit',
] as const;

export type PlatformSection = (typeof PLATFORM_SECTIONS)[number];
export type PlatformSections = Record<PlatformSection, boolean>;

/**
 * api/src/db/schema/platformAdmin.ts:82, verbatim.
 *
 * `owner` and NOT `founder`. This file said `founder` — the word the design uses
 * for the row it renders apart — and the API's enum says `owner`. The boundary
 * parse caught it before the console was ever driven: `parsePlatformAdmin`
 * returned null for the seeded founder, so sign-in would have failed with
 * "couldn't read your account" rather than rendering a console with a blank role.
 *
 * That is the whole argument for parsing a shape this file has to keep in step
 * with by hand — and the argument for `PlatformAdminSchema` belonging in
 * `packages/types`, where `e2e/contract.test.ts` would have caught it instead of
 * me. See the header.
 */
export const PLATFORM_ROLES = ['owner', 'admin', 'analyst', 'support'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

function isSections(value: unknown): value is PlatformSections {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  // EVERY section must be present and boolean. A missing one is not "false" —
  // it is a response this client does not understand, and defaulting it would
  // silently hide a section the admin holds.
  return PLATFORM_SECTIONS.every((s) => typeof v[s] === 'boolean');
}

function isRole(value: unknown): value is PlatformRole {
  return typeof value === 'string' && (PLATFORM_ROLES as readonly string[]).includes(value);
}

export interface PlatformAdmin {
  id: string;
  name: string;
  /** With the '@' the console renders. The column stores it without. */
  handle: string;
  role: PlatformRole;
  owner: boolean;
  /** False means invited and not yet signed in. Never a hash, never a hint — #6. */
  passwordSet: boolean;
  active: boolean;
  sections: PlatformSections;
}

/**
 * Hand-written rather than a zod schema, and deliberately so: `@avo/dashboard`
 * does not depend on zod directly, and taking one on for a single shape would add
 * a workspace dependency and a lockfile change to a lane branch. `session.ts`
 * validates its stored shapes the same way, so this matches the file next door.
 *
 * Returns the narrowed value or null. It does NOT throw: the caller is sign-in,
 * and "the server sent something I cannot read" has to become an authentication
 * failure with a sentence, not an unhandled exception in a form submit.
 */
export function parsePlatformAdmin(value: unknown): PlatformAdmin | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['id'] !== 'string' || v['id'] === '') return null;
  if (typeof v['name'] !== 'string' || v['name'] === '') return null;
  if (typeof v['handle'] !== 'string') return null;
  if (!isRole(v['role'])) return null;
  if (typeof v['owner'] !== 'boolean') return null;
  if (typeof v['passwordSet'] !== 'boolean') return null;
  if (typeof v['active'] !== 'boolean') return null;
  if (!isSections(v['sections'])) return null;
  return {
    id: v['id'],
    name: v['name'],
    handle: v['handle'],
    role: v['role'],
    owner: v['owner'],
    passwordSet: v['passwordSet'],
    active: v['active'],
    sections: v['sections'],
  };
}

/** No sections at all, for rendering a console that grants nothing. */
export const NO_SECTIONS: PlatformSections = Object.fromEntries(
  PLATFORM_SECTIONS.map((s) => [s, false]),
) as PlatformSections;
