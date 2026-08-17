/**
 * Driver selection. One switch, resolved once at boot — the same shape as
 * src/gateway/index.ts, for the same reason.
 *
 * Adding Google is: a new file next to stub.ts implementing `CalendarProvider`,
 * one case here, and `CALENDAR_DRIVER=google` plus the credentials in the
 * environment. Nothing in routes/ or services/ changes.
 *
 * NO PRODUCTION ASSERTION, unlike `GATEWAY_DRIVER=sandbox`, and the asymmetry is
 * deliberate. A sandbox gateway in production SETTLES PAYMENTS NOBODY MADE, so
 * env.ts refuses to boot. A stub calendar in production settles nothing: it
 * makes every artist bookable on the salon's own hours and says so out loud
 * through a merchant notification. That is a degraded feature, not a money bug,
 * and a salon can trade on it — which is exactly what "do not block the rest of
 * booking on it" means.
 */

import { env } from '../env';
import { StubCalendar } from './stub';
import type { CalendarProvider } from './types';

function build(): CalendarProvider {
  switch (env.calendarDriver) {
    case 'stub':
      return new StubCalendar();
    default: {
      // Exhaustive: adding a driver to the env enum without wiring it here is a
      // type error, not a runtime surprise on the first connect.
      const never: never = env.calendarDriver;
      throw new Error(`Unknown CALENDAR_DRIVER: ${String(never)}`);
    }
  }
}

export const calendar: CalendarProvider = build();

export * from './types';
