/**
 * Development-only scenario switch.
 *
 * packages/mock/src/server.ts serves the four required states off an
 * `x-avo-scenario` header, and they combine (`empty,stamps` is a new member at a
 * stamps salon). Reading the value off the URL query string is what makes the
 * states reviewable — `?scenario=offline` reloads the app into the offline
 * design instead of someone unplugging a router to check it.
 *
 * This is stripped in production: `__DEV__` is false in a release bundle, so the
 * header is never sent and the query string is never read.
 */

const KNOWN = [
  'ok',
  'loading',
  'empty',
  'error',
  'offline',
  'stamps',
  'declined',
  'cancelled',
  'pending',
  'lowbal',
  'noperms',
] as const;

export type Scenario = (typeof KNOWN)[number];

function isScenario(value: string): value is Scenario {
  return (KNOWN as readonly string[]).includes(value);
}

/** The scenarios in force, in the order they were given. Empty in production. */
export function activeScenarios(): Scenario[] {
  if (!__DEV__) return [];
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return [];
  const raw = new URLSearchParams(window.location.search).get('scenario');
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(isScenario);
}

export function scenarioHeader(): Record<string, string> {
  const active = activeScenarios();
  return active.length > 0 ? { 'x-avo-scenario': active.join(',') } : {};
}
