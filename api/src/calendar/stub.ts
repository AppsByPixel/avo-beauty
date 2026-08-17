/**
 * The stub calendar driver. The only one that exists, and the honest one.
 *
 * It refuses every write and returns nothing for every read, because there are
 * no Google credentials and inventing some would mean:
 *
 *   - `listBusy` returning [] while CLAIMING to have read a calendar, which
 *     makes an artist look free at times she is booked. A customer books, the
 *     artist has a client already, and the salon finds out at the door. That is
 *     the single worst failure this feature can have, and it is silent.
 *   - `createEvent` returning a fabricated id, which would set the booking's
 *     `calendar_sync_state` to `synced` and `google_event_id` to a string no
 *     cancel can ever delete.
 *
 * So `configured` is false and the callers branch on it. Availability falls back
 * to salon hours and raises a merchant notification — build-plan.md phase 6
 * § Done when — rather than silently offering a Google-sourced artist's stale
 * windows as though they had been checked.
 */

import {
  CalendarNotConfiguredError,
  type CalendarBusyBlock,
  type CalendarConnectionRef,
  type CalendarEventDraft,
  type CalendarProvider,
} from './types';

/** The sentence every refusal carries. It names what the client must provide. */
const NOT_CONFIGURED =
  'Google Calendar is not connected for this deployment. It needs a Google Cloud ' +
  'project owned by AVO: an OAuth client id and secret, a verified consent screen ' +
  'carrying AVO\'s name and privacy policy, the calendar.readonly and calendar.events ' +
  'scopes, and redirect URIs registered against AVO\'s domains. Until those exist, ' +
  'artists are bookable on salon hours.';

export class StubCalendar implements CalendarProvider {
  readonly id = 'stub';
  readonly configured = false;

  async beginConnect(): Promise<{ authorizeUrl: string; state: string }> {
    throw new CalendarNotConfiguredError(NOT_CONFIGURED);
  }

  async completeConnect(): Promise<{
    accountEmail: string | null;
    externalCalendarId: string | null;
    credentialRef: string;
  }> {
    throw new CalendarNotConfiguredError(NOT_CONFIGURED);
  }

  /**
   * EMPTY, NOT AN ERROR — and the caller is expected to know the difference from
   * `configured`, not from this return value. Availability is a read that must
   * keep working; a throw here would take a salon's whole booking surface down
   * because an integration nobody has bought yet is absent.
   */
  async listBusy(
    _connection: CalendarConnectionRef,
    _from: Date,
    _to: Date,
  ): Promise<CalendarBusyBlock[]> {
    return [];
  }

  async createEvent(
    _connection: CalendarConnectionRef,
    _draft: CalendarEventDraft,
  ): Promise<{ eventId: string }> {
    throw new CalendarNotConfiguredError(NOT_CONFIGURED);
  }

  async deleteEvent(_connection: CalendarConnectionRef, _eventId: string): Promise<void> {
    throw new CalendarNotConfiguredError(NOT_CONFIGURED);
  }
}
