// @vitest-environment jsdom

/**
 * Merchant → Settings → Social links, and the one rule the panel must never
 * restate: STORE THE HANDLE, DERIVE THE URL.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `Settings.tsx`' own header said social links were "NOT BUILT HERE,
 * DELIBERATELY" and named a separate slice. This is that slice, against
 * `PATCH /v1/salons/{id}/social/{linkId}` — which the API has had since decision
 * 17 and which nothing in `apps/dashboard/` reached for. The header is corrected
 * in the same commit, and one test below keeps it corrected: a shipped panel with
 * a header claiming it does not exist is the seventh stale "not built" claim this
 * dashboard has found, and the cheapest one to prevent.
 *
 * THE TWO PROPERTIES WORTH MORE THAN THE REST
 * -------------------------------------------
 * 1. THE URL IS DERIVED, AND THE DERIVATION IS `socialUrl` IN `@avo/types`.
 *    api-contract.md: "Never persist a URL: a salon that edits its handle would
 *    leave the icon pointing at a dead profile." A hand-built
 *    `https://instagram.com/${handle}` in this column passes every screenshot and
 *    fails on the day TikTok moves a path segment — and it would fail SILENTLY,
 *    as a dead icon in a customer's app rather than as a red test. So the
 *    derivation is MUTATED here (§ the mutation) rather than merely compared:
 *    `socialUrl` is replaced with one that answers a different domain, and the
 *    rendered link has to move with it. A component holding its own copy of the
 *    four rules cannot pass that.
 * 2. `on: false` HIDES WITHOUT LOSING THE HANDLE. `SocialLinkSchema` states it as
 *    a property of the field, and the merchant-facing consequence is that a
 *    switch which reads as a delete is a lie: Snapchat off and on again must give
 *    her handle back. Pinned on what the toggle SENDS — `{ on }` alone, never the
 *    handle with it — because that is what makes `applySocialPatch` copy the
 *    stored handle through untouched.
 *
 * WHAT IS NOT ASSERTED HERE, NAMED SO THE ABSENCE IS A DECISION
 * ------------------------------------------------------------
 * THAT THE FOUR HANDLE FORMATS ARE VALID. `parseSocialHandle` decides that, on
 * the server, as the ONE parser both server doors share — and this panel
 * deliberately keeps no copy of it. A test here asserting "@amara.kw is accepted"
 * would be asserting a rule this column does not own and cannot see change. What
 * IS asserted is that the screen SAYS which format each network wants before she
 * types, and that a refusal comes back naming the network.
 *
 * COMMENTS ARE BLANKED BEFORE EVERY SOURCE SEARCH — `settingsModules.test.ts`'
 * reason, and this file is the sharpest case of it in the repo: the block you are
 * reading contains `https://instagram.com/` inside a sentence explaining why the
 * source must not, and a naive `includes()` would read the explanation as the
 * defect.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fils, socialUrl, type Salon, type SocialLink } from '@avo/types';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';
import { stripComments } from '../testing/stripComments.js';
import { SocialLinksPanel } from './Settings.js';

/**
 * THE MUTATION HOOK. By default this is the real `socialUrl` — every test below
 * runs against the shipped derivation. § the mutation swaps it for one test and
 * the render has to follow.
 *
 * `...actual` rather than a bare stub, because `Settings.tsx` also imports
 * `fils`, `formatFils` and `visibleSocialLinks` from this module and a narrow
 * mock would blank the screen instead of testing it.
 */
let derive: ((id: SocialLink['id'], handle: string) => string | null) | null = null;

vi.mock('@avo/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@avo/types')>();
  return {
    ...actual,
    socialUrl: (id: SocialLink['id'], handle: string) =>
      derive ? derive(id, handle) : actual.socialUrl(id, handle),
  };
});

/* `shopRender.test.tsx`: vitest does not run with `globals`, so nothing registers
 * @testing-library's own cleanup and every render would accumulate in one document. */
afterEach(() => {
  cleanup();
  derive = null;
  vi.useRealTimers();
});

/** `apps/dashboard/src/routes` → repo root. */
const REPO = join(__dirname, '..', '..', '..', '..');
const read = (rel: string) => stripComments(readFileSync(join(REPO, rel), 'utf8'));
const SETTINGS = 'apps/dashboard/src/routes/Settings.tsx';

const LINKS: SocialLink[] = [
  { id: 'instagram', label: 'Instagram', handle: '@amara.kw', on: true },
  { id: 'tiktok', label: 'TikTok', handle: '@amarasalon', on: true },
  { id: 'snapchat', label: 'Snapchat', handle: 'amarasalon', on: true },
  { id: 'whatsapp', label: 'WhatsApp', handle: '+965 2233 4455', on: true },
];

/* The same tenant `settingsReceiptChannels.test.ts` uses, field for field, so
 * the two Settings fixtures cannot describe two different salons. `#7A5C8E` is
 * SAL-LUMIERE's own hex and deliberately not a preset — see that file. */
const SALON: Salon = {
  id: 'SAL-AMARA',
  name: 'Amara Salon',
  nameAr: 'صالون أمارة',
  plan: 'growth',
  city: 'Kuwait City',
  brandColor: '#7A5C8E',
  modules: { booking: false, shop: false },
  loyaltyMode: 'tiers',
  tiers: [{ name: 'bronze', minVisits: 0, bonusPercent: 0 }],
  depositFils: fils(5000),
  noShowReturnMinutes: 60,
  timezone: 'Asia/Kuwait',
  businessHours: { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] },
  branches: [{ id: 'BR-SAL', salonId: 'SAL-AMARA', name: 'Salmiya', nameAr: 'السالمية' }],
  social: LINKS,
  whatsappEnabled: true,
  emailEnabled: false,
};

const salonWith = (social: SocialLink[]): Salon => ({ ...SALON, social });

type Sent = Array<{ id: SocialLink['id']; handle?: string; on?: boolean }>;

function panel(over: Partial<React.ComponentProps<typeof SocialLinksPanel>> = {}, sent: Sent = []) {
  return (
    <SocialLinksPanel
      salon={SALON}
      saving={null}
      saved={null}
      failed={null}
      onSave={(p) => sent.push(p)}
      {...over}
    />
  );
}

const box = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement;

/* ========================================================================== */
describe('the four networks, and the row each one gets', () => {
  it('draws all four rows even for a salon that has set none of them', () => {
    // `social: []` is the COLUMN DEFAULT for a salon onboarded through the
    // wizard, and `applySocialPatch` creates a link rather than 404ing precisely
    // so she can set her first handle. Rendering the server's array would have
    // shown her an empty card.
    render(panel({ salon: salonWith([]) }));
    expect(screen.getAllByRole('textbox')).toHaveLength(4);
    expect(screen.getAllByRole('switch')).toHaveLength(4);
  });

  it('shows each network its own stored handle', () => {
    render(panel());
    expect(box('Instagram handle').value).toBe('@amara.kw');
    expect(box('TikTok handle').value).toBe('@amarasalon');
    expect(box('Snapchat handle').value).toBe('amarasalon');
    expect(box('WhatsApp number').value).toBe('+965 2233 4455');
  });

  /**
   * THE FORMAT IS STATED BEFORE SHE TYPES, PER NETWORK — the alternative being a
   * box that takes anything and fails on save. Twice: the design's placeholder,
   * and the accessible name, which is where the WhatsApp row stops saying
   * "handle" for a field that wants E.164.
   */
  it('says which format it wants, and says NUMBER for the one that is E.164', () => {
    render(panel());
    expect(box('Instagram handle').placeholder).toBe('@handle');
    expect(box('TikTok handle').placeholder).toBe('@handle');
    expect(box('Snapchat handle').placeholder).toBe('@handle');

    const wa = box('WhatsApp number');
    expect(wa.placeholder).toBe('+965 ····');
    // A phone keypad, and no "WhatsApp handle" anywhere on the row.
    expect(wa.getAttribute('inputmode')).toBe('tel');
    expect(screen.queryByRole('textbox', { name: 'WhatsApp handle' })).toBeNull();
  });
});

/* ========================================================================== */
describe("each network's handle round-trips", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));

  /**
   * TYPED → SENT UNDER ITS OWN ID → RENDERED BACK OFF THE SERVER'S SALON.
   *
   * The second half is what a `fireEvent.change` alone would not prove: the box
   * holds a draft while she types, and a panel that never re-read the salon would
   * look identical until a colleague edited the row in the next tab. So the
   * re-render is against a NEW salon carrying the saved value.
   */
  for (const [id, label, typed] of [
    ['instagram', 'Instagram handle', '@amara.beauty'],
    ['tiktok', 'TikTok handle', '@amara.tiktok'],
    ['snapchat', 'Snapchat handle', 'amara.snap'],
    ['whatsapp', 'WhatsApp number', '+965 9900 1122'],
  ] as const) {
    it(`${id}`, () => {
      const sent: Sent = [];
      const { rerender } = render(panel({}, sent));

      fireEvent.change(box(label), { target: { value: typed } });
      // Debounced: `DepositPanel`'s mechanism, and the reason is an audit row per
      // keystroke rather than a money write per click.
      expect(sent).toEqual([]);
      act(() => void vi.advanceTimersByTime(600));

      expect(sent).toEqual([{ id, handle: typed }]);
      // ONE KEY. A patch carrying `on` as well would make a keystroke a write of
      // a switch she did not touch.
      expect(Object.keys(sent[0]!).sort()).toEqual(['handle', 'id']);

      const saved = LINKS.map((l) => (l.id === id ? { ...l, handle: typed } : l));
      rerender(panel({ salon: salonWith(saved) }, sent));
      expect(box(label).value).toBe(typed);
    });
  }

  it('sends the settled string once, not one write per keystroke', () => {
    const sent: Sent = [];
    render(panel({}, sent));
    const input = box('Instagram handle');
    for (const v of ['@a', '@am', '@ama', '@amar']) {
      fireEvent.change(input, { target: { value: v } });
    }
    act(() => void vi.advanceTimersByTime(600));
    expect(sent).toEqual([{ id: 'instagram', handle: '@amar' }]);
  });

  /**
   * EMPTY IS A VALUE. `parseSocialHandle` admits `''` on purpose — "Send '' to
   * clear it" — so emptying the box must reach the server rather than being
   * swallowed as a no-op by a truthiness check on the way out.
   */
  it('sends an emptied box as a cleared handle rather than swallowing it', () => {
    const sent: Sent = [];
    render(panel({}, sent));
    fireEvent.change(box('Instagram handle'), { target: { value: '' } });
    act(() => void vi.advanceTimersByTime(600));
    expect(sent).toEqual([{ id: 'instagram', handle: '' }]);
  });
});

/* ========================================================================== */
describe('the switch hides the icon and does not delete the handle', () => {
  /**
   * THE PROPERTY, AS THE CONTRACT STATES IT: "false hides the icon without losing
   * the handle." A merchant who turns Snapchat off and on again gets her handle
   * back, and what makes that true on the server is that the flip sends `{ on }`
   * and NOTHING ELSE — `applySocialPatch` copies `handle` through untouched when
   * the patch does not mention it.
   *
   * Asserted on the key set, not just on the value: `{ on: false, handle: '' }`
   * would satisfy a naive check for `on: false` and would be the delete.
   */
  it('sends only `on`, so the stored handle is copied through', () => {
    const sent: Sent = [];
    render(panel({}, sent));
    fireEvent.click(screen.getByRole('switch', { name: 'Show Snapchat in the customer app' }));
    expect(sent).toEqual([{ id: 'snapchat', on: false }]);
    expect(Object.keys(sent[0]!).sort()).toEqual(['id', 'on']);
  });

  it('keeps the handle in the box and in the row while the channel is off', () => {
    const off = LINKS.map((l) => (l.id === 'snapchat' ? { ...l, on: false } : l));
    render(panel({ salon: salonWith(off) }));

    expect(screen.getByRole('switch', { name: 'Show Snapchat in the customer app' })
      .getAttribute('aria-checked')).toBe('false');
    // The handle did not go anywhere — this is the whole difference between this
    // control and a delete.
    expect(box('Snapchat handle').value).toBe('amarasalon');
  });

  it('gives the handle back when she turns it on again', () => {
    const sent: Sent = [];
    const off = LINKS.map((l) => (l.id === 'snapchat' ? { ...l, on: false } : l));
    render(panel({ salon: salonWith(off) }, sent));
    fireEvent.click(screen.getByRole('switch', { name: 'Show Snapchat in the customer app' }));
    expect(sent).toEqual([{ id: 'snapchat', on: true }]);
    expect(box('Snapchat handle').value).toBe('amarasalon');
  });

  /**
   * IT READS AS A VISIBILITY CONTROL, IN WORDS, IN THREE PLACES — because a bare
   * switch is ambiguous and the ambiguity here costs a merchant her handle.
   */
  it('is named for visibility and never for removal', () => {
    render(panel());
    for (const name of ['Instagram', 'TikTok', 'Snapchat', 'WhatsApp']) {
      expect(screen.getByRole('switch', { name: `Show ${name} in the customer app` })).toBeTruthy();
    }
    // The design's own sentence, and the panel's statement of the rule.
    expect(
      screen.getByText(
        'Shown as icons in the customer app under Help. Off hides the icon but keeps the handle.',
      ),
    ).toBeTruthy();
    // No delete affordance anywhere on the card.
    expect(screen.queryByRole('button', { name: /remove|delete/i })).toBeNull();
  });

  /**
   * AND THE ROW SAYS WHICH OF THE TWO IT IS, BY THE SHARED PREDICATE.
   *
   * `visibleSocialLinks` is `on` AND a handle that derives a URL. A row that read
   * its switch alone would print "Shown" over a channel the wallet renders
   * nothing for — the On-with-no-handle case, which is exactly what a merchant
   * would never think to check.
   */
  it('calls an On row with no handle what it is, which is not shown', () => {
    const blank = LINKS.map((l) => (l.id === 'tiktok' ? { ...l, handle: '', on: true } : l));
    render(panel({ salon: salonWith(blank) }));
    const row = box('TikTok handle').closest('.settings__social-row')!;
    expect(row.textContent).toContain('Not set');
    expect(row.textContent).not.toContain('Shown');
  });

  it('distinguishes a shown row from a hidden one that still has its handle', () => {
    const off = LINKS.map((l) => (l.id === 'snapchat' ? { ...l, on: false } : l));
    render(panel({ salon: salonWith(off) }));
    expect(box('Instagram handle').closest('.settings__social-row')!.textContent).toContain('Shown');
    const hidden = box('Snapchat handle').closest('.settings__social-row')!;
    expect(hidden.textContent).toContain('Hidden');
    expect(hidden.textContent).toContain('snapchat.com/add/amarasalon');
  });
});

/* ========================================================================== */
describe('store the handle, derive the URL', () => {
  /**
   * THE LINK EACH ROW POINTS AT IS `socialUrl`'s ANSWER, FOR ALL FOUR. Compared
   * against the function rather than against a string, so a contract change to
   * any of the four rules moves the expectation with the code.
   *
   * The four are not variations on one template, which is the reason a hand-built
   * copy is so easy to get wrong: TikTok keeps an `@` the others drop, Snapchat
   * inserts `/add/`, and WhatsApp strips every non-digit — so `+965 2233 4455`
   * has to become `wa.me/96522334455` and not `wa.me/+965 2233 4455`.
   */
  it('renders the shared derivation for every network', () => {
    render(panel());
    for (const link of LINKS) {
      const label = link.id === 'whatsapp' ? 'WhatsApp number' : `${link.label} handle`;
      const row = box(label).closest('.settings__social-row')!;
      const anchor = row.querySelector('a')!;
      expect(anchor.getAttribute('href')).toBe(socialUrl(link.id, link.handle));
    }
  });

  it("normalises WhatsApp's E.164 into wa.me digits rather than pasting the number in", () => {
    render(panel());
    const anchor = box('WhatsApp number').closest('.settings__social-row')!.querySelector('a')!;
    expect(anchor.getAttribute('href')).toBe('https://wa.me/96522334455');
  });

  /**
   * ======================================================================
   * THE MUTATION. The derivation is replaced; the render has to follow it.
   * ======================================================================
   * This is the test a hand-built URL fails and NOTHING ELSE IN THIS FILE DOES.
   * Every assertion above compares the rendered href to `socialUrl`'s output, and
   * a component that built the same string itself would satisfy all of them for
   * as long as the two agreed — which is precisely the window in which the defect
   * is invisible. Moving `socialUrl` underneath the component separates "agrees
   * with the rule today" from "asks the rule", and only the second survives a
   * network changing its domain.
   */
  it('follows socialUrl when socialUrl moves', () => {
    derive = (id, handle) => `https://moved.example/${id}/${handle.trim()}`;
    render(panel());
    const anchor = box('Instagram handle').closest('.settings__social-row')!.querySelector('a')!;
    expect(anchor.getAttribute('href')).toBe('https://moved.example/instagram/@amara.kw');
  });

  it('renders nothing rather than a broken link when the derivation answers null', () => {
    // `socialUrl` returns null for an empty handle, and the route asks for that
    // to be rendered rather than hidden: "a fact the form should render".
    derive = () => null;
    render(panel());
    expect(document.querySelectorAll('.settings__social-row a')).toHaveLength(0);
    expect(screen.getAllByText(/Not set/).length).toBeGreaterThan(0);
  });

  /**
   * AND THE COLUMN KEEPS NO COPY OF THE FOUR DOMAINS. The static half of the
   * mutation above: a literal here is a second source of truth whether or not it
   * is reached, and the next reader would maintain it.
   */
  it('spells no social domain anywhere in the screen', () => {
    const src = read(SETTINGS);
    for (const domain of ['instagram.com', 'tiktok.com', 'snapchat.com', 'wa.me']) {
      expect(src, `${domain} is spelled in ${SETTINGS}`).not.toContain(domain);
    }
    expect(src).toContain('socialUrl(');
    expect(src).toContain('visibleSocialLinks(');
  });

  /**
   * AND IT NEVER SENDS ONE EITHER. `parseSocialHandle` refuses a URL by name, but
   * the client that would trip it is one that helpfully "completes" the handle
   * into a link before sending — so the write path is pinned to the raw box.
   */
  it('sends the handle it was given, never a link built from it', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sent: Sent = [];
    render(panel({}, sent));
    fireEvent.change(box('Instagram handle'), { target: { value: '@amara.beauty' } });
    act(() => void vi.advanceTimersByTime(600));
    expect(sent).toEqual([{ id: 'instagram', handle: '@amara.beauty' }]);
    expect(sent[0]!.handle).not.toMatch(/^https?:/);
  });
});

/* ========================================================================== */
describe('the four states', () => {
  /** LOADING — skeletons at the control's real height, never an empty box that
   *  looks like a salon with no handles. */
  it('skeletons rather than painting four blank handles it does not have', () => {
    render(panel({ salon: undefined }));
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    // And it does not accuse a loading salon of having set nothing.
    expect(screen.queryByText(/No handles yet/)).toBeNull();
    expect(document.querySelectorAll('.avo-skeleton').length).toBe(8);
  });

  /** EMPTY — four editable rows, and a sentence naming what the customer app is
   *  doing meanwhile. A card of blank boxes says nothing to anyone. */
  it('names the empty state instead of showing four silent boxes', () => {
    render(panel({ salon: salonWith([]) }));
    expect(
      screen.getByText('No handles yet — the customer app shows no social icons for this salon.'),
    ).toBeTruthy();
    // Still editable: the empty state is not a refusal.
    expect(screen.getAllByRole('textbox')).toHaveLength(4);
  });

  it('drops the empty sentence as soon as one handle exists', () => {
    const one = LINKS.map((l) => (l.id === 'instagram' ? l : { ...l, handle: '' }));
    render(panel({ salon: salonWith(one) }));
    expect(screen.queryByText(/No handles yet/)).toBeNull();
  });

  /** ERROR — a refusal is the server's sentence, not ours. */
  it('quotes the server when the write is refused, and names the network', () => {
    const refusal = new ApiError(
      'Enter just the Instagram handle, not the link. AVO builds the link from it, so editing the handle can never leave a dead icon in the customer app.',
      { status: 400, code: 'handle_is_a_url' },
    );
    render(panel({ failed: { id: 'instagram', error: refusal } }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Enter just the Instagram handle, not the link.');
    expect(alert.textContent).toContain('Instagram is unchanged.');
  });

  /**
   * THE 403 IS A REAL STATE ON THIS PANEL. The screen's courtesy gate hides the
   * card from a merchant without `perms.loyalty`, but `perms` is a snapshot from
   * sign-in: revoke it while Settings is open and the next flip is refused. The
   * server's copy names who can grant it, so it renders verbatim.
   */
  it('renders a 403 as the server wrote it, with no retry offered', () => {
    const forbidden = new ApiError(
      "You don't have permission to change loyalty settings. A manager can grant it.",
      { status: 403, code: 'forbidden' },
    );
    render(panel({ failed: { id: 'whatsapp', error: forbidden } }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('A manager can grant it.');
    expect(alert.textContent).toContain('WhatsApp is unchanged.');
    expect(screen.queryByRole('button', { name: /try again|retry/i })).toBeNull();
  });

  /** OFFLINE — a dead network is not the salon's fault and not a refusal. */
  it('says the workspace is unreachable rather than blaming the handle', () => {
    const offline = new ApiError('Failed to fetch', {
      status: 0,
      code: 'network_error',
      offline: true,
    });
    render(panel({ failed: { id: 'tiktok', error: offline } }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain("We couldn't reach the workspace.");
    expect(alert.textContent).toContain('TikTok is unchanged.');
  });

  /** And a 401 renders nothing at all — the shell is already redirecting. */
  it('stays silent on an expired session', () => {
    const gone = new ApiError('Sign in again.', { status: 401, code: 'unauthenticated' });
    render(panel({ failed: { id: 'instagram', error: gone } }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

/* ========================================================================== */
describe('the write states', () => {
  it('says which row is saving, and only that row', () => {
    render(panel({ saving: 'instagram' }));
    const ig = box('Instagram handle').closest('.settings__social-row')!;
    expect(ig.textContent).toContain('Saving…');
    expect(box('TikTok handle').closest('.settings__social-row')!.textContent).not.toContain(
      'Saving…',
    );
  });

  it('says which row was saved, and only that row', () => {
    render(panel({ saved: 'tiktok' }));
    expect(box('TikTok handle').closest('.settings__social-row')!.textContent).toContain('Saved');
    expect(box('Instagram handle').closest('.settings__social-row')!.textContent).not.toContain(
      'Saved',
    );
  });

  /**
   * A FAILED WRITE LEAVES WHAT SHE TYPED IN THE BOX. The server value did not
   * change, so the resync effect does not re-fire — which `DepositPanel` records
   * as a flaw in a stepper and which is the right behaviour in a text field,
   * where the refused value is the thing she now has to edit.
   */
  it('keeps the refused draft under her hand rather than snapping it back', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sent: Sent = [];
    const { rerender } = render(panel({}, sent));
    fireEvent.change(box('Instagram handle'), { target: { value: 'https://instagram.example/x' } });
    act(() => void vi.advanceTimersByTime(600));

    const refusal = new ApiError('Enter just the Instagram handle, not the link.', {
      status: 400,
      code: 'handle_is_a_url',
    });
    rerender(panel({ failed: { id: 'instagram', error: refusal } }, sent));
    expect(box('Instagram handle').value).toBe('https://instagram.example/x');
  });
});

/* ========================================================================== */
describe('the wiring, and the claim this panel had to correct', () => {
  /**
   * ONE LINK PER WRITE, THROUGH THE ENDPOINT BUILT FOR IT. The bulk door still
   * exists — `social` is in `MERCHANT_EDITABLE` — and using it from here would
   * make a manager typing an Instagram handle a writer of the WhatsApp number a
   * colleague is editing in the next tab. `SalonPatch` not carrying `social` is
   * what makes that a compile error rather than a race.
   */
  it('writes through the per-link endpoint, never the whole-array field', () => {
    const api = read('apps/dashboard/src/api/settings.ts');
    expect(api).toContain('/v1/salons/${salonId}/social/${id}');
    expect(api).toContain("method: 'PATCH'");
    // The bulk key must not be reachable from this client's patch type.
    const open = api.indexOf('export type SalonPatch');
    expect(open).toBeGreaterThan(-1);
    expect(api.slice(open, api.indexOf('};', open))).not.toContain("'social'");
  });

  /**
   * THE HEADER NO LONGER CLAIMS THIS PANEL DOES NOT EXIST. Seven stale "not
   * built" claims have been found in this dashboard; this is the first one caught
   * by a test rather than by a reader, and the assertion costs two lines.
   */
  it('does not tell the next reader that social links are unbuilt', () => {
    const src = read(SETTINGS);
    expect(src).toContain('export function SocialLinksPanel');
    // Comments ARE the thing under test here, so the raw file is read.
    const raw = readFileSync(join(REPO, SETTINGS), 'utf8');
    const header = raw.slice(0, raw.indexOf('export function Settings()'));
    expect(header).not.toMatch(/NOT BUILT HERE, DELIBERATELY: the brand kit[^*]*social links/);
    expect(header).toContain('SOCIAL LINKS ARE BUILT HERE NOW');
  });

  /**
   * AND THE PERMISSION IS NAMED, WITH THE ROUTE'S OWN OBJECTION TO IT. A future
   * reader must not conclude this lane picked `loyalty` for a Settings panel.
   */
  it('records that the gate is loyalty and that the route calls the name wrong', () => {
    const raw = readFileSync(join(REPO, 'apps/dashboard/src/api/settings.ts'), 'utf8');
    expect(raw).toContain('perms.loyalty');
    expect(raw).toContain('THE ROUTE SAYS THE NAME IS WRONG');
    // And the escalation, so the next reader knows a decision is pending rather
    // than that this lane shrugged.
    expect(raw).toContain('perms.settings');
  });
});
