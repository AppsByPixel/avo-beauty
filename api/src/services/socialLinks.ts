/**
 * The salon's four social handles — api-contract.md § SocialLink.
 *
 *     id      "instagram" | "tiktok" | "snapchat" | "whatsapp"
 *     label   string
 *     handle  string     // "@amara.kw", or E.164 for whatsapp
 *     on      bool       // false hides the icon without losing the handle
 *
 *     PATCH /v1/salons/{id}/social/{linkId}   { handle?, on? }
 *
 * That endpoint is named twice in the contract (§ SocialLink, and § Operations
 * "Merchant | Social links") and did not exist. The only way to edit a handle was
 * the whole `social` array through `PATCH /salons/{id}`, which is a different
 * endpoint, a different granularity and a different permission from the one
 * specified. Aftab's call, DECISIONS.md #17: build the endpoint to match the
 * contract. The contract is the specification; the array field was the
 * improvisation.
 *
 * WHY GRANULARITY IS NOT A DETAIL HERE
 * ------------------------------------
 * `routes/salons.ts` already makes this argument for the product catalogue, in as
 * many words: "'SAVES AS YOU TYPE' IS A PATCH PER FIELD, NOT A BULK PUT of the
 * whole catalog. A PUT would make one keystroke in one row a rewrite of every
 * product the salon sells, so two managers editing different rows would silently
 * overwrite each other — and the loser's product would come back at the old price
 * with nothing recording that it had moved."
 *
 * It is the same problem with four rows instead of forty. The design's own
 * reference implementation says so too — `AVO Merchant Dashboard.dc.html` calls
 * `API.setSocial(so.id, { handle })` on every keystroke and
 * `API.setSocial(so.id, { on })` on every toggle, one link at a time — and the
 * dashboard sending the whole array on each of those turns a manager typing an
 * Instagram handle into a writer of the WhatsApp number a colleague is editing in
 * the next tab.
 *
 * THIS MODULE IS THE ONE TRANSLATOR for both doors. The per-link endpoint and the
 * whole-array field both go through `parseSocialHandle`, for the reason
 * `routes/salons.ts § buildSalonPatch` gives about the tier ladder: the copy that
 * drifts is the one nobody is reading, and a second unvalidated entrance makes the
 * validated one decorative.
 *
 * =========================================================================
 * THE ARRAY DOOR WAS COMPLETELY UNVALIDATED, AND STILL EXISTS
 * =========================================================================
 * `social` has been in `MERCHANT_EDITABLE` since that route was written and
 * NOTHING checked it — `buildSalonPatch` did `patch[k] = normaliseArabic(k, body[k])`
 * and handed the result to a jsonb column. So `{"social": "banana"}` was storable,
 * and `visibleSocialLinks` in `@avo/types` then calls `.flatMap` on it in the
 * wallet. That is the same shape of defect as the `businessHours` door that file
 * closed — "one bad Settings save turned every availability read for that salon
 * into a 500, on the booking screen, three screens from the field that was typed
 * wrong" — and it is closed here the same way, by `parseSocialLinks`.
 *
 * WHY THE ARRAY DOOR IS KEPT RATHER THAN NARROWED AWAY. It is reported, not
 * removed, and the reasoning is deliberate:
 *
 *   - `social` sits in `MERCHANT_EDITABLE`, and `PLATFORM_EDITABLE` is that set
 *     plus two fields, so removing it would silently remove it from the owner
 *     console's salon editor as well — which a separate session is building right
 *     now in `apps/dashboard/`. Deleting a field out from under another lane's
 *     in-flight work is the exact failure the lane rule exists to prevent.
 *   - Nothing in `api/` knows which clients still send the array. Narrowing it is
 *     a consumer-visible break and belongs to trunk with the consumers in view.
 *
 * So both doors exist, both are validated, and the recommendation to trunk is
 * that once `apps/dashboard` uses the per-link endpoint, `social` should leave
 * `MERCHANT_EDITABLE` and the array should become console-only. Until then a
 * merchant who sends the array still overwrites her colleague — the per-link
 * endpoint fixes that for callers that use it, and cannot fix it for callers that
 * do not.
 */

import type { SocialLink } from '@avo/types';
import { badRequest } from '../http/errors';
import { parseE164 } from '../http/fields';

/**
 * The four ids, IN THE ORDER THE CONTRACT LISTS THEM, and their labels.
 *
 * THE LABEL IS DERIVED FROM THE ID AND IS NEVER CLIENT-SUPPLIED, which is the one
 * place this module is stricter than the contract's field list. `label` is a
 * string on the entity, but it is rendered under the salon's icons in the customer
 * app, and a merchant-settable string there is arbitrary copy in the wallet with
 * no review path. The id space is closed — four values — so the label is a lookup,
 * not an input.
 *
 * `satisfies` ties this to the shared enum, so a fifth channel added to
 * `SocialLinkSchema` in `packages/types` is a compile error here rather than a
 * link this file quietly refuses.
 */
export const SOCIAL_LABELS = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  snapchat: 'Snapchat',
  whatsapp: 'WhatsApp',
} as const satisfies Record<SocialLink['id'], string>;

export const SOCIAL_IDS = Object.keys(SOCIAL_LABELS) as SocialLink['id'][];

export function isSocialId(value: unknown): value is SocialLink['id'] {
  return typeof value === 'string' && Object.hasOwn(SOCIAL_LABELS, value);
}

/**
 * A handle for one channel, or `''` to clear it.
 *
 * EMPTY IS A VALUE, NOT A MISSING FIELD, and it is the difference between this and
 * `requireString`. The contract says `on: false` "hides the icon without losing the
 * handle", so the two controls are independent: clearing the text box must be able
 * to clear the handle while the toggle stays where the merchant left it. The design
 * draws exactly that — a text input and a switch, side by side, each writing on its
 * own. `visibleSocialLinks` then renders nothing for an empty handle whatever the
 * toggle says.
 *
 * A URL IS REFUSED BY NAME. api-contract.md: "Store the handle, derive the URL.
 * Never persist a URL: a salon that edits its handle would leave the icon pointing
 * at a dead profile." A merchant who pastes `https://instagram.com/amara.kw` is
 * doing the natural thing, and storing it produces
 * `https://instagram.com/https://instagram.com/amara.kw` out of `socialUrl` — a
 * dead icon in every customer's app, caused by a field that accepted her input
 * without comment. So she is told, with the fix in the sentence.
 *
 * WHATSAPP GOES THROUGH `parseE164`, because the contract says it is E.164 and
 * because `socialUrl` builds `wa.me/{digits}` — a number with no country code
 * produces a link to the wrong person, not a broken one, which is worse. It is the
 * same parser that produced the stored value at onboarding, so "+965 2233 4455"
 * typed with spaces is accepted the way a person types it and stored normalised.
 */
export function parseSocialHandle(id: SocialLink['id'], value: unknown): string {
  if (typeof value !== 'string') {
    throw badRequest('invalid_handle', 'A handle must be text. Send "" to clear it.');
  }
  const raw = value.trim();
  if (raw === '') return '';

  if (raw.length > 120) {
    throw badRequest('invalid_handle', 'That handle is too long.');
  }
  if (/^(https?:)?\/\//i.test(raw) || /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(raw)) {
    throw badRequest(
      'handle_is_a_url',
      `Enter just the ${SOCIAL_LABELS[id]} handle, not the link. AVO builds the link from it, so editing the handle can never leave a dead icon in the customer app.`,
    );
  }

  if (id === 'whatsapp') return parseE164(raw);

  /**
   * The `@` is optional and is stored as the merchant typed it, because
   * `socialUrl` strips a leading one either way and the design's placeholder is
   * `@handle`. What is refused is whitespace inside the handle, which no platform
   * permits and which silently produces a broken link rather than a wrong one.
   */
  if (/\s/.test(raw)) {
    throw badRequest('invalid_handle', 'A handle cannot contain spaces.');
  }
  return raw;
}

/** The `on` toggle. Refused if it is not a boolean, never coerced. */
export function parseSocialOn(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw badRequest('invalid_request', 'on must be true or false.');
  }
  return value;
}

/**
 * Apply `{ handle?, on? }` to one link inside a salon's array, returning the new
 * array and the link as it now stands.
 *
 * THE OTHER THREE LINKS ARE COPIED THROUGH UNTOUCHED, which is the entire point of
 * the endpoint: two managers editing different channels must not overwrite each
 * other. The caller runs this inside a transaction holding `SELECT … FOR UPDATE` on
 * the salon row, which is what makes that true under a genuine race rather than
 * only under polite clients — a read-modify-write on a jsonb array without the lock
 * is precisely the overwrite being fixed, performed by the fix.
 *
 * A LINK THE SALON DOES NOT YET HAVE IS CREATED. It is not a 404, and the reason is
 * that a salon onboarded through the wizard starts with `social: []` — the column
 * default — while the Settings screen draws all four rows always. A 404 there would
 * mean a new salon could never set its first handle. The id space is closed and the
 * label is a lookup, so creation needs nothing from the client that it is entitled
 * to supply.
 *
 * A CREATED LINK IS APPENDED, not inserted in canonical position, and the array's
 * existing order is preserved exactly. Reordering would be this endpoint touching
 * links it was not asked about, which is the behaviour it exists to eliminate.
 */
export function applySocialPatch(
  links: SocialLink[],
  id: SocialLink['id'],
  patch: { handle?: string; on?: boolean },
): { links: SocialLink[]; link: SocialLink } {
  const index = links.findIndex((l) => l.id === id);
  const existing: SocialLink =
    index >= 0
      ? (links[index] as SocialLink)
      : { id, label: SOCIAL_LABELS[id], handle: '', on: false };

  const link: SocialLink = {
    ...existing,
    /**
     * The stored label is kept when there is one, and only a NEW link takes the
     * canonical string. Rewriting an existing salon's label would be a second
     * field changed by a request that asked about one — and the seeded labels
     * already match, so there is nothing to correct.
     */
    label: existing.label || SOCIAL_LABELS[id],
    ...(patch.handle !== undefined ? { handle: patch.handle } : {}),
    ...(patch.on !== undefined ? { on: patch.on } : {}),
  };

  const next = index >= 0 ? links.map((l, i) => (i === index ? link : l)) : [...links, link];
  return { links: next, link };
}

/**
 * The WHOLE array, for `PATCH /salons/{id}`'s `social` field.
 *
 * This is the door that had no validation at all. Every element goes through the
 * same handle parser the per-link endpoint uses, so the two cannot disagree about
 * what a handle is.
 *
 * DUPLICATE IDS ARE REFUSED. `applySocialPatch` and the design's own `setSocial`
 * both address a link BY ID, so two rows sharing one id means the second is
 * unreachable and unrenderable — the array equivalent of the repeated `serviceIds`
 * `POST /charges` refuses by name, and refused here for the same reason: a client
 * that has lost track of its own list should be told rather than quietly having
 * half of it applied.
 */
export function parseSocialLinks(value: unknown): SocialLink[] {
  if (!Array.isArray(value)) {
    throw badRequest(
      'invalid_social',
      'social must be an array of links. To change one channel, use PATCH /v1/salons/{id}/social/{linkId}.',
    );
  }
  if (value.length > SOCIAL_IDS.length) {
    throw badRequest('invalid_social', `A salon has at most ${SOCIAL_IDS.length} social links.`);
  }

  const seen = new Set<string>();
  return value.map((raw) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw badRequest('invalid_social', 'Each social link must be an object.');
    }
    const l = raw as Record<string, unknown>;
    if (!isSocialId(l.id)) {
      throw badRequest(
        'invalid_social',
        `Unknown social channel. AVO supports ${SOCIAL_IDS.join(', ')}.`,
      );
    }
    if (seen.has(l.id)) {
      throw badRequest('invalid_social', `${SOCIAL_LABELS[l.id]} appears more than once.`);
    }
    seen.add(l.id);

    return {
      id: l.id,
      // Derived, never taken from the body. See SOCIAL_LABELS.
      label: SOCIAL_LABELS[l.id],
      handle: parseSocialHandle(l.id, l.handle ?? ''),
      on: parseSocialOn(l.on ?? false),
    };
  });
}
