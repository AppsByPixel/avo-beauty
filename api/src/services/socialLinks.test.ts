/**
 * `PATCH /v1/salons/{id}/social/{linkId}` — the parts that are a pure function of
 * a body and an array, which is most of what the endpoint is.
 *
 * A UNIT SPEC ON PURPOSE, and it runs in `pnpm check` — unlike the rate-limiter
 * specs next door, which need rows. `routes/support.test.ts` set this precedent
 * for `queueScope`: a boundary rule extracted to a function that takes arguments
 * and returns a value can be asserted with no database, no docker and no env file,
 * and that is the version of the rule that gets run on every commit.
 *
 * WHAT THIS CANNOT COVER, stated rather than implied, because the endpoint's
 * headline property is a concurrency property. "Two managers editing different
 * links do not overwrite each other" has two halves:
 *
 *   THE PURE HALF — given an array and a patch for ONE id, the other links come
 *   through byte-identical. Asserted below, and it is what makes the endpoint
 *   different in kind from `PATCH /salons/{id}` with a whole `social` array.
 *
 *   THE RACE — two requests reading the same array in the same instant. That is
 *   carried by `SELECT … FOR UPDATE` on the salon row in `routes/salons.ts`, and
 *   proving it needs two concurrent connections. It belongs in `e2e/`, which has
 *   `support/race.ts` for exactly this and which is Lane D's column. OWED, and
 *   named in the lane report.
 */

import { describe, expect, it } from 'vitest';
import type { SocialLink } from '@avo/types';
import { socialUrl } from '@avo/types';
import { ApiError } from '../http/errors';
import {
  applySocialPatch,
  isSocialId,
  parseSocialHandle,
  parseSocialLinks,
  parseSocialOn,
  SOCIAL_IDS,
  SOCIAL_LABELS,
} from './socialLinks';

/** The seeded Amara array — `db/seed.ts`, verbatim, so the fixture is the product's. */
const SEEDED: SocialLink[] = [
  { id: 'instagram', label: 'Instagram', handle: '@amara.kw', on: true },
  { id: 'tiktok', label: 'TikTok', handle: '@amara.kw', on: true },
  { id: 'snapchat', label: 'Snapchat', handle: '', on: false },
  { id: 'whatsapp', label: 'WhatsApp', handle: '+96522334455', on: true },
];

function refusal(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected a refusal, got none');
}

describe('the id space is closed by the contract', () => {
  it('is exactly the four channels api-contract.md § SocialLink names', () => {
    expect(SOCIAL_IDS).toEqual(['instagram', 'tiktok', 'snapchat', 'whatsapp']);
  });

  it('rejects anything else, including a plausible fifth', () => {
    expect(isSocialId('facebook')).toBe(false);
    expect(isSocialId('')).toBe(false);
    expect(isSocialId(null)).toBe(false);
    /**
     * `Object.hasOwn` and not `in`, which is why this case is here: `'toString' in
     * SOCIAL_LABELS` is true through the prototype chain, and a membership test
     * written that way would have accepted `linkId = toString` and then indexed
     * `SOCIAL_LABELS['toString']` into a function.
     */
    expect(isSocialId('toString')).toBe(false);
    expect(isSocialId('constructor')).toBe(false);
  });
});

describe('applySocialPatch — the other links are not touched', () => {
  it('changes one handle and returns the other three byte-identical', () => {
    const { links } = applySocialPatch(SEEDED, 'instagram', { handle: '@amara.salon' });

    expect(links[0]).toEqual({
      id: 'instagram',
      label: 'Instagram',
      handle: '@amara.salon',
      on: true,
    });
    // THE POINT OF THE ENDPOINT. A whole-array PUT would have rewritten these.
    expect(links.slice(1)).toEqual(SEEDED.slice(1));
  });

  it('changes one toggle without disturbing that link\'s handle', () => {
    // api-contract.md: "false hides the icon without losing the handle."
    const { links, link } = applySocialPatch(SEEDED, 'instagram', { on: false });
    expect(link).toEqual({ id: 'instagram', label: 'Instagram', handle: '@amara.kw', on: false });
    expect(links.slice(1)).toEqual(SEEDED.slice(1));
  });

  it('does not mutate the array it was given', () => {
    const before = structuredClone(SEEDED);
    applySocialPatch(SEEDED, 'whatsapp', { handle: '+96599887766', on: false });
    expect(SEEDED).toEqual(before);
  });

  it('preserves order, and never reorders into canonical position', () => {
    // A per-link PATCH that reordered would be touching links it was not asked
    // about — the behaviour it exists to eliminate, performed by the fix.
    const shuffled: SocialLink[] = [SEEDED[3]!, SEEDED[0]!];
    const { links } = applySocialPatch(shuffled, 'instagram', { on: false });
    expect(links.map((l) => l.id)).toEqual(['whatsapp', 'instagram']);
  });

  describe('a salon that has never opened Settings', () => {
    it('creates the link rather than 404ing, because onboarding seeds none', () => {
      /**
       * `services/salonOnboarding.ts` gives a new salon `social: []` — the column
       * default — while the Settings screen draws all four rows always. A 404 here
       * would mean a newly onboarded salon could never set its first handle.
       */
      const { links, link } = applySocialPatch([], 'tiktok', { handle: '@lumiere' });
      expect(links).toEqual([{ id: 'tiktok', label: 'TikTok', handle: '@lumiere', on: false }]);
      expect(link.on).toBe(false);
    });

    it('gives a created link the canonical label, which the client cannot supply', () => {
      const { link } = applySocialPatch([], 'snapchat', { on: true });
      expect(link.label).toBe(SOCIAL_LABELS.snapchat);
      expect(link.handle).toBe('');
    });

    it('appends rather than inserting, so existing links keep their positions', () => {
      const { links } = applySocialPatch(SEEDED.slice(0, 1), 'whatsapp', { handle: '+96522334455' });
      expect(links.map((l) => l.id)).toEqual(['instagram', 'whatsapp']);
    });
  });

  it('keeps a stored label rather than rewriting it to the canonical one', () => {
    // Rewriting would be a second field changed by a request that asked about one.
    const custom: SocialLink[] = [{ id: 'tiktok', label: 'TikTok KW', handle: '@a', on: true }];
    const { link } = applySocialPatch(custom, 'tiktok', { handle: '@b' });
    expect(link.label).toBe('TikTok KW');
  });
});

describe('parseSocialHandle — store the handle, derive the URL', () => {
  it('accepts a handle with or without the @', () => {
    expect(parseSocialHandle('instagram', '@amara.kw')).toBe('@amara.kw');
    expect(parseSocialHandle('instagram', 'amara.kw')).toBe('amara.kw');
  });

  it('accepts the empty string as "clear this handle"', () => {
    // Not `requireString`: the toggle and the text box are independent controls,
    // so clearing the box must be expressible while the toggle stays put.
    expect(parseSocialHandle('instagram', '')).toBe('');
    expect(parseSocialHandle('instagram', '   ')).toBe('');
  });

  describe('a pasted URL is refused by name', () => {
    /**
     * api-contract.md: "Never persist a URL: a salon that edits its handle would
     * leave the icon pointing at a dead profile." Storing one is worse than that
     * sentence suggests — `socialUrl` would build
     * `https://instagram.com/https://instagram.com/amara.kw`, a dead icon in every
     * customer's app, caused by a field that accepted her input without comment.
     */
    it.each([
      'https://instagram.com/amara.kw',
      'http://instagram.com/amara.kw',
      '//instagram.com/amara.kw',
      'instagram.com/amara.kw',
    ])('%s', (pasted) => {
      const err = refusal(() => parseSocialHandle('instagram', pasted));
      expect(err.code).toBe('handle_is_a_url');
      expect(err.statusCode).toBe(400);
      // The refusal names the channel, so the merchant knows which row is wrong.
      expect(err.message).toContain('Instagram');
    });

    it('proves the damage the refusal prevents', () => {
      expect(socialUrl('instagram', 'https://instagram.com/amara.kw')).toBe(
        'https://instagram.com/https://instagram.com/amara.kw',
      );
    });
  });

  it('refuses whitespace inside a handle', () => {
    expect(refusal(() => parseSocialHandle('tiktok', '@amara kw')).code).toBe('invalid_handle');
  });

  it('refuses a non-string, because a JSON number is not a cleared field', () => {
    expect(refusal(() => parseSocialHandle('tiktok', 42)).code).toBe('invalid_handle');
    expect(refusal(() => parseSocialHandle('tiktok', null)).code).toBe('invalid_handle');
  });

  describe('whatsapp is E.164, because socialUrl builds wa.me from the digits', () => {
    it('normalises a number typed with spaces the way a person types it', () => {
      expect(parseSocialHandle('whatsapp', '+965 2233 4455')).toBe('+96522334455');
    });

    it('refuses a number with no country code', () => {
      // A wa.me link built from local digits reaches the WRONG person, which is
      // worse than a broken one.
      expect(refusal(() => parseSocialHandle('whatsapp', '22334455')).code).toBe('invalid_phone');
    });

    it('still accepts the empty string, so the number can be cleared', () => {
      expect(parseSocialHandle('whatsapp', '')).toBe('');
    });
  });
});

describe('parseSocialOn — refused if it is not a boolean, never coerced', () => {
  it.each([['"false"', 'false'], ['1', 1], ['0', 0], ['null', null]])(
    '%s is a refusal',
    (_label, value) => {
      expect(refusal(() => parseSocialOn(value)).code).toBe('invalid_request');
    },
  );

  it('accepts both booleans', () => {
    expect(parseSocialOn(true)).toBe(true);
    expect(parseSocialOn(false)).toBe(false);
  });
});

describe('parseSocialLinks — the whole-array door, which had no validation at all', () => {
  it('accepts the seeded array unchanged', () => {
    expect(parseSocialLinks(SEEDED)).toEqual(SEEDED);
  });

  it('refuses a non-array, which used to reach the jsonb column', () => {
    /**
     * THE BUG THIS CLOSES. `social` was in `MERCHANT_EDITABLE` and nothing checked
     * it, so `buildSalonPatch`'s loop handed `"banana"` straight to the column —
     * and `visibleSocialLinks` in `@avo/types` then calls `.flatMap` on it, in the
     * WALLET, on the Help screen. The same shape as the `businessHours` door that
     * file closed one release earlier.
     */
    const err = refusal(() => parseSocialLinks('banana'));
    expect(err.code).toBe('invalid_social');
    // The message points at the endpoint that should have been used instead.
    expect(err.message).toContain('PATCH /v1/salons/{id}/social/{linkId}');
  });

  it.each([[null], [42], [{ id: 'instagram' }]])('refuses %s', (value) => {
    expect(refusal(() => parseSocialLinks(value)).code).toBe('invalid_social');
  });

  it('refuses a duplicated channel rather than applying half the list', () => {
    // The same refusal `POST /charges` gives a repeated `serviceId`, for the same
    // reason: a client that has lost track of its own list should be told.
    const err = refusal(() => parseSocialLinks([SEEDED[0], SEEDED[0]]));
    expect(err.code).toBe('invalid_social');
    expect(err.message).toContain('Instagram');
  });

  it('refuses an unknown channel by name, listing the four that exist', () => {
    const err = refusal(() => parseSocialLinks([{ id: 'facebook', handle: '@a', on: true }]));
    expect(err.message).toContain('instagram, tiktok, snapchat, whatsapp');
  });

  it('derives the label and ignores a client-supplied one', () => {
    // A merchant-settable label is arbitrary copy under the icons in every
    // customer's app, with no review path.
    const [link] = parseSocialLinks([
      { id: 'instagram', label: 'Follow us!!!', handle: '@amara.kw', on: true },
    ]);
    expect(link?.label).toBe('Instagram');
  });

  it('applies the same handle rules as the per-link endpoint', () => {
    // One translator, two doors. A second unvalidated entrance is what made the
    // tier ladder's validation decorative — routes/salons.ts records that defect.
    expect(refusal(() => parseSocialLinks([{ id: 'instagram', handle: 'https://x.com/a', on: true }])).code)
      .toBe('handle_is_a_url');
    expect(refusal(() => parseSocialLinks([{ id: 'whatsapp', handle: '22334455', on: true }])).code)
      .toBe('invalid_phone');
  });

  it('defaults a missing handle and toggle rather than storing undefined in jsonb', () => {
    expect(parseSocialLinks([{ id: 'snapchat' }])).toEqual([
      { id: 'snapchat', label: 'Snapchat', handle: '', on: false },
    ]);
  });

  it('refuses more entries than there are channels', () => {
    const five = [...SEEDED, SEEDED[0]];
    expect(refusal(() => parseSocialLinks(five)).code).toBe('invalid_social');
  });
});
