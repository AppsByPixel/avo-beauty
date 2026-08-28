// @vitest-environment jsdom

/**
 * The Shop screen's two guarantees that no source scan can reach.
 *
 * `stateCensus.test.ts` proves this file's screen HAS the four-state vocabulary;
 * `settingsModules.test.ts` proves the module field is real. Neither can prove
 * what a merchant actually reads, and both of the properties below are about
 * exactly that:
 *
 *   1. THE PRICE IS INTEGER FILS ALL THE WAY TO THE GLASS (non-negotiable #1).
 *      `priceFils: 8500` has to reach the editable cell as `8.500` — three
 *      decimals, trailing zeroes intact — and the confirmation has to announce
 *      it as money rather than as a number. Grepping for `formatFils` proves the
 *      call exists; only rendering proves the value lands in the input's `value`
 *      and the `Money` label lands on the confirmation.
 *
 *   2. THE TWO REFUSALS ARE DIFFERENT SCREENS, NOT DIFFERENT WORDS
 *      (non-negotiable #7, and the module gate beside it). A staff member without
 *      `perms.shop` is refused: nothing loads, and the server's own sentence is
 *      rendered with no retry. A salon with `modules.shop` off is NOT refused —
 *      `assertShopReadable` returns early for staff — so the catalog loads and
 *      the module state is a notice over a working editor. The failure mode this
 *      pins is the easy one: one shared "the shop is unavailable" block, which
 *      would tell a manager she lacks a permission she holds.
 *
 * Both are asserted against the RENDERED text, so a refactor that keeps the
 * imports and loses the behaviour fails here.
 */

import { fils } from '@avo/types';
import { ImageSlot } from '@avo/ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';
import { ProductRow, ShopModuleOffNotice, countLabel } from './Shop.js';
import { SectionError } from './sectionState.js';

/*
 * NOT AUTOMATIC — this project does not run vitest with `globals`, so
 * `@testing-library/react` never registers its own `afterEach(cleanup)`. Without
 * this line every `render()` in the file accumulates in one document and the
 * first query matching two nodes fails with "Found multiple elements", pointing
 * at the component instead of at the leftovers. `ui/moneyRender.test.tsx` carries
 * the same line and the same warning.
 */
afterEach(cleanup);

const PRODUCT = {
  id: 'PR-01',
  salonId: 'SAL-AMARA',
  name: 'Argan hair oil 100ml',
  priceFils: fils(8500),
  // Explicit null: the API sends the key even when there is no image, so a
  // fixture that omitted it would be the one product in the codebase whose
  // "no image" is indistinguishable from "field not sent".
  image: null,
};

function renderRow(overrides: Partial<Parameters<typeof ProductRow>[0]> = {}) {
  return render(
    <ProductRow
      product={PRODUCT}
      saving={false}
      retiring={false}
      onSave={async () => true}
      onRetire={() => {}}
      {...overrides}
    />,
  );
}

describe('a product price is integer fils to the last pixel', () => {
  it('renders 8500 fils in the editable cell as 8.500', () => {
    renderRow();
    const price = screen.getByLabelText<HTMLInputElement>(
      'Price in KD — Argan hair oil 100ml',
    );
    // Not 8.5, and not 8500. The trailing zeroes are what make it money.
    expect(price.value).toBe('8.500');
  });

  it('never shows a bare integer for a whole-dinar price', () => {
    renderRow({ product: { ...PRODUCT, priceFils: fils(12000) } });
    const price = screen.getByLabelText<HTMLInputElement>(
      'Price in KD — Argan hair oil 100ml',
    );
    expect(price.value).toBe('12.000');
  });

  it('announces the price as money in the removal confirmation, not as a number', () => {
    renderRow();
    // The ✕ is a bare glyph; it is reachable by the name the button carries.
    fireEvent.click(screen.getByLabelText('Remove Argan hair oil 100ml from the catalog'));

    /*
     * `Money` labels the wrapper and hides the glyphs, so the ANNOUNCED string is
     * a different string from the drawn one — `8.500 Kuwaiti dinars`, not
     * "eight point five". Found by its accessible name, which is the whole point:
     * if the confirmation formatted the number inline instead of using `Money`,
     * there would be no such label to find.
     */
    expect(screen.getByLabelText('8.500 Kuwaiti dinars')).not.toBeNull();
  });

  /**
   * THE WORD ON THE CONTROL, because the design's word is wrong about this server.
   * `AVO Merchant Dashboard.dc.html:310` gives the ✕ `title="Delete product"` and
   * `DELETE /salons/{id}/products/{pid}` sets `active = false`. A screen that says
   * "Delete" over a server that retires diverges the first time somebody asks why
   * an old receipt still names the product.
   */
  it('says the ✕ removes from the catalog, and never that it deletes', () => {
    const { container } = renderRow();
    expect(
      screen.getByLabelText('Remove Argan hair oil 100ml from the catalog'),
    ).not.toBeNull();
    expect(container.textContent ?? '').not.toMatch(/delete/i);
  });

  it('the confirmation says past orders keep the line, and that it is one-way', () => {
    renderRow();
    fireEvent.click(screen.getByLabelText('Remove Argan hair oil 100ml from the catalog'));
    const confirm = screen.getByRole('group', { name: 'Remove Argan hair oil 100ml?' });
    const text = confirm.textContent ?? '';
    // The two facts a merchant cannot guess and the server will not tell her.
    expect(text).toMatch(/old receipts still name it/);
    expect(text).toMatch(/cannot be brought back/);
  });
});

describe('a keystroke that cannot be money is refused before the request', () => {
  it('sends nothing and says why when the price has four decimals', () => {
    const onSave = vi.fn(async () => true);
    const { container } = renderRow({ onSave });
    const price = container.querySelector<HTMLInputElement>('.shop__price-input')!;
    // `fireEvent.change`, not `price.value = …`: React tracks the node's value
    // internally and a direct assignment produces no change event at all.
    fireEvent.change(price, { target: { value: '8.5001' } });

    expect(screen.getByRole('alert').textContent).toMatch(/up to 3 decimals/);
    // NO request. `parseKwdInput` refused it, so there is nothing to send and no
    // 400 for the merchant to collect.
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('the two refusals are different screens', () => {
  const forbidden = new ApiError(
    "You don't have permission to see the shop. A manager can grant it.",
    { status: 403, code: 'forbidden' },
  );

  it('a missing perms.shop renders the server sentence and offers no retry', () => {
    const onRetry = vi.fn();
    const { container } = render(
      <SectionError
        error={forbidden}
        forbiddenTitle="You don't have access to the shop"
        failedTitle="Couldn't load the product catalog"
        onRetry={onRetry}
        retrying={false}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain("You don't have access to the shop");
    // Server-authored, verbatim — it names who can grant the permission.
    expect(text).toContain('A manager can grant it.');
    // interaction-spec.md §4: an identical request produces an identical refusal,
    // so a retry button here is a lie about what she can do.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a module that is off says something else entirely, and blames no permission', () => {
    const { container } = render(<ShopModuleOffNotice />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/Shop module is off/);
    // The distinction that matters: she is not being refused, she is being told
    // what to switch on — and where.
    expect(text).toMatch(/Settings → Optional modules/);
    expect(text).not.toMatch(/permission/i);
    expect(text).not.toMatch(/manager can grant/i);
  });

  it('and they share no sentence', () => {
    const refusal = render(
      <SectionError
        error={forbidden}
        forbiddenTitle="You don't have access to the shop"
        failedTitle="Couldn't load the product catalog"
        onRetry={() => {}}
        retrying={false}
      />,
    ).container.textContent;
    cleanup();
    const notice = render(<ShopModuleOffNotice />).container.textContent;
    expect(refusal).not.toBe(notice);
    /*
     * The sharp version of the same check. If one block were reused for both, the
     * refusal's title would appear in the notice — which is the defect this pins:
     * a merchant who owns the Settings switch being told to go and ask a manager.
     *
     * APOSTROPHES ARE NORMALISED, and that correction was earned. Written against
     * the straight `'`, this assertion sailed through a deliberate mutation that
     * pasted the refusal's own words into the notice, because product copy renders
     * `&rsquo;` — so the two strings differed by one character that no reader can
     * see. A guard that a typographic apostrophe defeats is not a guard.
     */
    expect(flatten(notice)).not.toContain(flatten("You don't have access to the shop"));
    expect(flatten(notice)).not.toContain(flatten('A manager can grant it.'));
  });
});

/** Curly apostrophes out, so an assertion cannot be defeated by a glyph. */
function flatten(text: string | null): string {
  return (text ?? '').replace(/[\u2018\u2019]/g, "'");
}

describe('the count line', () => {
  // The design's `productCount`: singular at one, plural everywhere else.
  it('pluralises the way the design does', () => {
    expect(countLabel(0)).toBe('0 products');
    expect(countLabel(1)).toBe('1 product');
    expect(countLabel(5)).toBe('5 products');
  });
});


/* ------------------------------------------------------------ the picture */

/**
 * The square, and the four things about it a merchant can see.
 *
 * `ProductImageCell` is not rendered here — it reads a QueryClient and a session,
 * and `Shop.tsx` injects it into `ProductRow` precisely so this file can keep
 * asserting the row's price and copy guarantees without standing up half the app.
 * What IS rendered is the leaf it wraps, where every one of these properties
 * lives.
 *
 * THE DESIGN BUNDLE DRAWS NO PRODUCT IMAGE UI. The vocabulary is borrowed from
 * the Brand kit slot at `AVO Merchant Dashboard.dc.html:972` — square, rounded,
 * a placeholder word, drop-or-click. `ImageSlot.tsx` carries the whole argument
 * and the two forced departures.
 */
describe('a product with no photo is the common case, and must not look broken', () => {
  const noop = () => {};

  it('offers to add one, and says nothing about failure', () => {
    const { container } = render(
      <ImageSlot state="empty" label="Add a photo to Argan hair oil 100ml" onPick={noop} />,
    );
    expect(screen.getByLabelText('Add a photo to Argan hair oil 100ml')).not.toBeNull();
    // The design's own idiom: a quiet word inside the square, not an icon of a
    // torn page. An empty slot is an invitation, not an error.
    expect(container.textContent ?? '').toContain('Photo');
    expect(screen.queryByRole('alert')).toBeNull();
    // Nothing to take off a product that has nothing on it.
    expect(container.querySelector('.avo-slot__remove')).toBeNull();
  });

  it('draws a broken photo as broken, never as empty', () => {
    /*
     * THE DISTINCTION THAT MATTERS. An image that will not load rendered as an
     * empty slot tells a merchant her product has no photo when it has one —
     * so she uploads it again to fix a problem that was never hers.
     */
    const { container } = render(
      <ImageSlot state="error" label="Replace the photo on Argan hair oil 100ml" onPick={noop} />,
    );
    expect(container.querySelector('.avo-slot__broken')).not.toBeNull();
    expect(container.querySelector('.avo-slot__placeholder')).toBeNull();
  });

  it('shows her own picture while the bytes go up, and claims no percentage', () => {
    const { container } = render(
      <ImageSlot state="uploading" src="blob:local/1" label="x" onPick={noop} />,
    );
    // Her file, painted from a local object URL — not a spinner over a grey box.
    expect(container.querySelector<HTMLImageElement>('.avo-slot__img')?.src).toBe('blob:local/1');
    expect(container.querySelector('.avo-slot__busy')).not.toBeNull();
    // `fetch` reports no upload progress, so nothing here may look determinate.
    expect(container.querySelector('progress')).toBeNull();
    expect(container.textContent ?? '').not.toMatch(/\d+\s*%/);
    // And it cannot be clicked into a second upload while the first is in flight.
    expect(container.querySelector<HTMLButtonElement>('.avo-slot__hit')?.disabled).toBe(true);
  });

  it('offers the ✕ only over a photo the server actually has', () => {
    const withPhoto = render(
      <ImageSlot state="ready" src="blob:x" label="x" onRemove={noop} onPick={noop} />,
    );
    expect(withPhoto.container.querySelector('.avo-slot__remove')).not.toBeNull();
    cleanup();

    // Mid-upload the row is painting a LOCAL preview; a ✕ there would offer to
    // delete an image the server does not have yet.
    const uploading = render(
      <ImageSlot state="uploading" src="blob:x" label="x" onRemove={noop} onPick={noop} />,
    );
    expect(uploading.container.querySelector('.avo-slot__remove')).toBeNull();
  });
});

describe('the SVG a merchant drags off her desktop reaches the server', () => {
  /**
   * `accept` FILTERS THE FILE DIALOG AND DOES NOTHING TO A DROP — non-negotiable
   * #7's sentence, literally true of this attribute. The likeliest first failure
   * on this screen is a logo dragged straight in, and it must reach the API's 415,
   * because the API's refusal names SVG and says why it is refused. A silent local
   * reject would read as a drop target that randomly ignores files.
   */
  it('names the three types it takes and never offers SVG', () => {
    const { container } = render(<ImageSlot state="empty" label="x" onPick={() => {}} />);
    const accept = container.querySelector<HTMLInputElement>('.avo-slot__input')?.accept ?? '';
    expect(accept).toBe('image/png,image/jpeg,image/webp');
    // The Brand kit caption says "Drop a square SVG or PNG"; this API refuses SVG
    // outright. The conflict is flagged in ImageSlot.tsx, not papered over here.
    expect(accept).not.toContain('svg');
  });

  it('hands a dropped SVG straight to the caller rather than swallowing it', () => {
    const onPick = vi.fn();
    const { container } = render(<ImageSlot state="empty" label="x" onPick={onPick} />);
    const svg = new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' });

    fireEvent.drop(container.querySelector('.avo-slot')!, {
      dataTransfer: { files: [svg] },
    });

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0].name).toBe('logo.svg');
  });

  it('re-fires for the same file picked twice, so a fixed file is not ignored', () => {
    /*
     * A merchant who is told her file is wrong, fixes it in place, and picks it
     * again by the same name gets NO change event unless the input is cleared —
     * and a slot that does nothing reads as broken.
     */
    const onPick = vi.fn();
    const { container } = render(<ImageSlot state="empty" label="x" onPick={onPick} />);
    const input = container.querySelector<HTMLInputElement>('.avo-slot__input')!;
    const file = new File(['x'], 'oil.jpg', { type: 'image/jpeg' });

    fireEvent.change(input, { target: { files: [file] } });
    expect(input.value).toBe('');
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});

describe('the row makes room for the square', () => {
  it('places the injected picture cell at the head of the row', () => {
    const { container } = renderRow({ image: <i data-testid="cell" /> });
    const row = container.querySelector('.shop__row')!;
    expect(row.firstElementChild?.tagName.toLowerCase()).toBe('i');
  });

  it('renders nothing at all when no cell is injected, so the bare row still works', () => {
    const { container } = renderRow();
    expect(container.querySelector('.shop__row')?.firstElementChild?.tagName.toLowerCase()).toBe(
      'input',
    );
  });
});
