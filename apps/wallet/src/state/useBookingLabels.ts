/**
 * Turning the ids on a booking into words.
 *
 * `BookingSchema` carries `serviceId` and `artistId` and nothing readable —
 * which is right for an entity and useless for a card that has to say
 * "Balayage & gloss with Rana". There is no expanded booking endpoint for the
 * customer (the SCANNER's `GET /artists/me/bookings` does join the names, and
 * so does the merchant's list, but the wallet's `GET /bookings` does not), so
 * the two lists are read and the ids looked up here.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT FAILS SOFT, AND THE FAILURE IT WAS WRITTEN FOR NO LONGER HAPPENS
 * ═══════════════════════════════════════════════════════════════════════════
 * This header used to say the artist fetch was a 403 for every real member,
 * because the only roster endpoint was `perms.team`. The customer-scoped list it
 * asked for EXISTS — `GET /salons/{id}/artists/bookable`, see api/booking.ts §
 * getArtists — so the expected path now resolves and the card says "with Rana"
 * rather than an em dash.
 *
 * The soft failure stays, because it was never really about the 403: this is a
 * decoration on a card whose load-bearing facts — the appointment, its time, its
 * deposit — are all in the booking itself. A roster read that fails for any other
 * reason (offline, a 500, an aborted signal) must not take those down with it, so
 * a failure yields an empty map and the name renders as an em dash.
 *
 * One consequence worth naming: `/artists/bookable` lists ACTIVE artists only, so
 * a past appointment with an artist who has since left the salon resolves to no
 * name and shows the dash. That is the right trade — the alternative is the
 * merchant roster, which a customer may not read at all — and the fix, if it ever
 * matters, is names on the booking rather than a wider roster.
 */

import { useEffect, useState } from 'react';
import type { BookableArtist, Language } from '@avo/types';
import { getArtists, getServices, type BookableService } from '../api/booking';
import { artistName, serviceName } from '../domain/booking';

export interface BookingLabels {
  artists: Map<string, BookableArtist>;
  services: Map<string, BookableService>;
  /** The artist's name in the reading language, or null when unresolvable. */
  artistLabel: (artistId: string, lang: Language) => string | null;
  /**
   * The service's name in the reading language, or null when unresolvable.
   *
   * `lang` is new: this returned `service.name` unconditionally because
   * `Service` had no `nameAr` to prefer. It has one now, so the Upcoming card
   * reads "قص وتصفيف" in an Arabic wallet instead of "Cut & style".
   */
  serviceLabel: (serviceId: string, lang: Language) => string | null;
}

const EMPTY = new Map<string, never>();

export function useBookingLabels(salonId: string | null, enabled: boolean): BookingLabels {
  const [artists, setArtists] = useState<Map<string, BookableArtist>>(EMPTY);
  const [services, setServices] = useState<Map<string, BookableService>>(EMPTY);

  useEffect(() => {
    if (!enabled || !salonId) return;
    const controller = new AbortController();

    getArtists(salonId, controller.signal)
      .then((list) => setArtists(new Map(list.map((a) => [a.id, a]))))
      .catch(() => {
        /* Offline, a 500, an abort — see the header. The card copes. */
      });

    getServices(salonId, controller.signal)
      .then((list) => setServices(new Map(list.map((s) => [s.id, s]))))
      .catch(() => {
        /* Same: a missing service name is a dash, not a broken card. */
      });

    return () => controller.abort();
  }, [salonId, enabled]);

  return {
    artists,
    services,
    artistLabel: (id, lang) => {
      const artist = artists.get(id);
      return artist ? artistName(artist, lang) : null;
    },
    serviceLabel: (id, lang) => {
      const service = services.get(id);
      return service ? serviceName(service, lang) : null;
    },
  };
}
