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
 * IT FAILS SOFT, ON PURPOSE
 * ═══════════════════════════════════════════════════════════════════════════
 * `GET /salons/{id}/artists` is gated on `perms.team` and a customer does not
 * have it (see api/booking.ts § getArtists), so on a real member session this
 * fetch is a 403. That must not take the Upcoming card down with it: the
 * appointment, its time and its deposit are all real and all readable, and the
 * artist's name is the one part that is missing. So a failure yields an empty
 * map and the card renders an em dash where the name would be.
 *
 * REPORTED. The fix is either a customer-scoped artist list or names on the
 * booking, and both are contract changes — `packages/types` and `api/` are not
 * this lane's to write.
 */

import { useEffect, useState } from 'react';
import type { Artist, Language } from '@avo/types';
import { getArtists, getServices, type BookableService } from '../api/booking';
import { artistName, serviceName } from '../domain/booking';

export interface BookingLabels {
  artists: Map<string, Artist>;
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
  const [artists, setArtists] = useState<Map<string, Artist>>(EMPTY);
  const [services, setServices] = useState<Map<string, BookableService>>(EMPTY);

  useEffect(() => {
    if (!enabled || !salonId) return;
    const controller = new AbortController();

    getArtists(salonId, controller.signal)
      .then((list) => setArtists(new Map(list.map((a) => [a.id, a]))))
      .catch(() => {
        /* 403 for a customer today — see the header. The card copes. */
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
