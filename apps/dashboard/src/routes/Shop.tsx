import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fils, type Fils, type Product } from '@avo/types';
import { Button, Card, ImageSlot, InfoBanner, Money, Segmented, Skeleton } from '@avo/ui';
import {
  priceInputValue,
  readPriceInput,
  useCreateProduct,
  useProducts,
  useRetireProduct,
  useUpdateProduct,
  type ProductPatch,
} from '../api/products.js';
import {
  imageRejection,
  useProductImage,
  useRemoveProductImage,
  useUploadProductImage,
} from '../api/productImage.js';
import { useSalon } from '../api/salon.js';
import { SectionError, WriteError } from './sectionState.js';
import { ShopOrders } from './ShopOrders.js';

/**
 * Merchant → Shop. `AVO Merchant Dashboard.dc.html:296` § SHOP.
 *
 * `perms.shop` on every route this screen touches — the read included — so there
 * is NO courtesy permission gate here and that is a decision rather than an
 * omission: the 403 arrives on `GET /salons/{id}/products` and `SectionError`
 * renders the server's own sentence. Ledger row in `sectionState.tsx`.
 *
 * ---------------------------------------------------------------------------
 * THE TWO REFUSALS THIS SCREEN HAS TO TELL APART, AND THEY ARE NOT THE SAME SHAPE
 *
 * `modules.shop` defaults OFF (design:1044 — "Flat catalog, pay from wallet,
 * pickup at salon. Default off."), so "the shop is off" and "you may not see the
 * shop" are both reachable and mean opposite things about what the merchant
 * should do next. Rendering one message for both would tell a manager she lacks
 * a permission she holds, or tell her to ask a manager about a switch she owns.
 *
 * WHAT THE SERVER ACTUALLY DISTINGUISHES, read off `services/moduleAccess.ts`
 * rather than guessed from the flag's existence:
 *
 *   perms.shop missing   403, `requireDashboardPerm(req, 'shop')`. A refusal.
 *                        Nothing loads. Explained, never retried.
 *   modules.shop off     NOT A REFUSAL ON THIS SURFACE. `assertShopReadable`
 *                        returns early for any principal whose `kind` is not
 *                        `member`, so a staff read answers 200 with the full
 *                        catalog whether the module is on or off. The three
 *                        writes have no module check at all.
 *
 * That asymmetry is deliberate and it is the reason this screen renders the
 * module state as a NOTICE over a working editor rather than as a wall. Lane A's
 * words for it: "the gate is on the SHOPFRONT, not on the workshop" — a salon
 * builds its catalog before it opens the shop, which is why the column defaults
 * off, and gating her own read would be "an editor that forgets what it just
 * saved". So: she can add, rename, reprice and retire products with the module
 * off; what she cannot do is sell them, and only the notice says so.
 *
 * The customer's half of the same fact is a 409 `shop_not_enabled` with the
 * wallet's own copy ("The shop is closed"), which is a different surface, a
 * different principal and a different sentence. Nothing here shares copy with it.
 *
 * ---------------------------------------------------------------------------
 * THE ✕ SAYS "REMOVE", NOT "DELETE", AND THE DESIGN SAYS "DELETE"
 *
 * `AVO Merchant Dashboard.dc.html:310` gives the ✕ `title="Delete product"`, and
 * the prototype's handler does delete — locally, from an array. The endpoint does
 * not: `DELETE /salons/{id}/products/{pid}` sets `active = false`, because
 * `shop_order_line.product_id` is `ON DELETE restrict` and a real delete would
 * either fail with a foreign key error (reaching the merchant as a 500 for
 * pressing a drawn button) or leave a sold order line naming a product that no
 * longer exists.
 *
 * A UI that says "Delete" over a server that retires diverges the first time
 * somebody asks why a two-year-old receipt still names the product — so the word
 * is corrected here and the confirmation states both halves: it stops being for
 * sale, and past orders keep their line. Reported to trunk as a design/API copy
 * conflict rather than papered over in either direction.
 *
 * AND IT IS ONE-WAY, WHICH IS THE PART A MERCHANT CANNOT GUESS. `GET` lists only
 * `active = true` rows and `PATCH` carries `active = true` in its WHERE, and
 * there is no un-retire endpoint anywhere — so a retired product cannot be
 * brought back from this screen at all. The confirmation says so instead of
 * implying an undo.
 *
 * ---------------------------------------------------------------------------
 * ONE DEPARTURE ON CREATION, AND WHY "SAVES AS YOU TYPE" STILL READS TRUE
 *
 * The prototype's "+ Add product" appends a blank row and nothing is ever sent
 * anywhere. `POST /salons/{id}/products` requires a name AND a price, and
 * `product_price_positive` refuses zero — so a blank row is not a product and
 * cannot be one. Committing a draft on a debounce would create a product at
 * whatever half-typed number the pause landed on (`1` on the way to `12.000`),
 * with an audit line saying that was the price.
 *
 * So a NEW row is a draft with an explicit Add, and every row that exists saves
 * as you type. The design's footer sentence is kept verbatim because it is still
 * true of the catalog it describes: a draft is not yet one of its rows.
 *
 * ---------------------------------------------------------------------------
 * TWO TABS NOW, AND THE SECOND ONE IS NOT IN THE DESIGN BUNDLE
 *
 * The shop became delivery-based (item 7, `PRIOR-ART.md` § "The shop is
 * delivery-based"), which gave the merchant a second thing to do here: prepare,
 * hand over and close the orders that arrive. `routes/ShopOrders.tsx` is that
 * board, and this file is now its host.
 *
 * WHY A TAB AND NOT AN ELEVENTH NAV ITEM. Three reasons, in the order they
 * decided it:
 *
 *   `perms.shop` GATES BOTH. `GET /v1/salons/{id}/orders` and `PATCH …/orders/…`
 *   are `requireDashboardPerm(req, 'shop')` — the same gate as this catalogue —
 *   and `api/src/routes/orders.ts` says so in those words: "this is the Shop
 *   section's own screen". A section boundary that does not follow a permission
 *   boundary is how a sidebar ends up implying two different authorities over one.
 *
 *   THE SIDEBAR IS THE DESIGN'S. `shell/navItems.tsx` transcribes ten items from
 *   `AVO Merchant Dashboard.dc.html`; an eleventh would be this lane inventing a
 *   section, which is the one thing `CLAUDE.md` § "Do not add features" is about.
 *
 *   THE IDIOM EXISTS. `Marketing.tsx` is one gate, one section, three
 *   `Segmented` tabs. Borrowing that is cheaper than a second visual language,
 *   and it is what the states census already understands.
 *
 * WHAT MOVED, AND WHAT DELIBERATELY DID NOT. The module notice moved UP here,
 * because `modules.shop` is a fact about the SECTION and not about either tab —
 * a catalogue you can build but not sell from, and a board that can still
 * receive nothing new. The catalogue's own body is untouched below as
 * `ShopCatalogue`; its four states, its debounce and its ✕ confirmation are the
 * same code they were.
 *
 * THE TWO TABS OWN THEIR OWN READS AND THEIR OWN FOUR STATES. This is NOT
 * Marketing's shape, where a host owns one fetch and hands `loading` down: the
 * catalogue reads `GET /salons/{id}/products` and the board reads `GET
 * /v1/salons/{id}/orders`, and either can fail while the other answers. So each
 * renders its own `SectionError` rather than a drifting copy of a shared one, and
 * `stateCensus.test.ts` lists them separately.
 */

/**
 * Long enough that a price is typed rather than transcribed digit by digit,
 * short enough that a merchant who looks away has already saved. Every
 * keystroke restarts it, so a settled field costs one PATCH.
 */
const SAVE_DELAY_MS = 700;

type Tab = 'catalogue' | 'orders';

/**
 * "Catalog" carries the design's spelling — `AVO Merchant Dashboard.dc.html:299`
 * writes "Catalog only", American, and the hint below still says it. "Orders" is
 * new copy for a screen the bundle does not contain.
 */
const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'catalogue', label: 'Catalog' },
  { value: 'orders', label: 'Orders' },
];

/**
 * The section frame: the tab picker, the module notice, and whichever tab is up.
 *
 * `useSalon()` LIVES HERE AND NOT IN EITHER TAB, so the module state is read once
 * for the section that owns it. Its failure is deliberately NOT a section error:
 * `GET /salons/{id}` is `requirePrincipal` with no permission, and a screen that
 * refused to draw a working catalogue because a notice could not be resolved
 * would be worse than a missing notice. `shopOn` stays `undefined`, both tabs
 * carry on, and the notice does not render — which is the same treatment
 * `undefined` gets while the read is in flight.
 */
export function Shop() {
  const [tab, setTab] = useState<Tab>('catalogue');
  const salon = useSalon();
  /*
   * Only ever from a LOADED salon. `undefined` is "not known yet" and must not
   * render as "off" — a notice saying the shop is closed, shown for a beat on
   * every load of a salon that is open, is the premature-zero class in words.
   */
  const shopOn = salon.data?.modules.shop;

  return (
    <div className="shop-section">
      <div className="shop-section__tabs">
        <Segmented options={TABS} value={tab} onChange={setTab} label="Shop section" />
      </div>

      {/*
        ABOVE THE TABS' CONTENT AND BELOW THE PICKER, because it is true of both:
        the catalogue can be built but not sold from, and the board can receive
        nothing new. It used to sit inside the catalogue, which is where it was
        written and where it no longer belongs.
      */}
      {shopOn === false ? <ShopModuleOffNotice /> : null}

      {tab === 'catalogue' ? <ShopCatalogue /> : <ShopOrders shopOn={shopOn} />}
    </div>
  );
}

export function ShopCatalogue() {
  const products = useProducts();
  const create = useCreateProduct();
  const update = useUpdateProduct();
  const retire = useRetireProduct();
  const [drafting, setDrafting] = useState(false);

  if (products.isError) {
    return (
      <SectionError
        error={products.error}
        forbiddenTitle="You don't have access to the shop"
        failedTitle="Couldn't load the product catalog"
        onRetry={() => void products.refetch()}
        retrying={products.isFetching}
      />
    );
  }

  const items = products.data?.items;

  return (
    <div className="shop">
      <div className="shop__head">
        {/*
          =====================================================================
          THE DESIGN'S SENTENCE, WITH HALF OF IT CORRECTED, AND THE HALF IS NAMED
          =====================================================================
          `AVO Merchant Dashboard.dc.html:299` reads, verbatim:

            "Catalog only — no stock counts, no delivery (phase 2). Buyers pick
             up at the salon."

          "no delivery (phase 2)" IS NOW FALSE. Delivery shipped — `POST /orders`
          takes `fulfilment: 'delivery'` with an address from her book, and the
          Orders tab beside this one is the board that fulfils them. "Buyers pick
          up at the salon" is no longer the whole story either; pickup is one fork
          of two (`PRIOR-ART.md`: "Pickup is not replaced. It is a fork.").

          So the false clause is replaced and the true one is kept word for word.
          This is the treatment the ✕ already gets in this file — the design says
          "Delete", the server retires, and the word is corrected on this surface
          because the server does something else. A screen that tells a merchant
          her shop cannot deliver, on the same screen as the board where her
          delivery orders are waiting, is worse than a diverged caption.

          `.shop__hint-aside` — the greyed "(phase 2)" — has no text left to
          carry. Its rule stays in `app.css`, unused for now rather than deleted,
          because the design still draws that treatment and something else will
          want it. Reported to trunk as a design/product copy conflict rather than
          resolved in either direction on my own.
        */}
        <span className="shop__hint">
          Catalog only — no stock counts. Buyers pay from their wallet and choose pickup or
          delivery.
          {/*
            COPY THE DESIGN DOES NOT CONTAIN, and the constraint is stated ONCE
            here rather than under every square. Brand kit can afford a caption
            beside its single slot (design:973, "Drop a square SVG or PNG, at
            least 1024px"); a catalog cannot repeat one forty times. The size
            limit is deliberately NOT a number in this sentence — the API owns it
            (`IMAGE_MAX_BYTES`) and puts it in the 413 body, and a hard-coded
            "2 MB" here would be a second copy of a rule that is one env var away
            from being wrong.
          */}
          <span className="shop__hint-photo">
            Drop a photo on a product&rsquo;s square, or click it to browse — PNG, JPEG or WebP.
          </span>
        </span>
        {products.isPending || drafting ? null : (
          <Button onClick={() => setDrafting(true)}>+ Add product</Button>
        )}
      </div>

      <Card className="shop__card">
        {products.isPending ? (
          /* Five rows because the loaded card is a list of rows this shape —
             interaction-spec.md §4 wants the pending layout to be the loaded
             one, not a spinner in the middle of a card. */
          [0, 1, 2, 3, 4].map((n) => (
            <div className="shop__row" key={n}>
              {/* The square is part of the loaded row's shape, so it is part of
                  the pending one — interaction-spec.md §4 wants the pending
                  layout to BE the loaded layout, and a list that grows 52px
                  taller the moment it resolves is the thing that rule forbids. */}
              <Skeleton width={52} height={52} radius={14} />
              <Skeleton width="100%" height={40} radius={10} />
              <Skeleton width={130} height={40} radius={10} />
              <Skeleton width={32} height={32} radius={8} />
            </div>
          ))
        ) : (
          <>
            {(items ?? []).map((product) => (
              <ProductRow
                key={product.id}
                product={product}
                image={<ProductImageCell product={product} />}
                saving={update.isPending && update.variables?.productId === product.id}
                retiring={retire.isPending && retire.variables?.productId === product.id}
                onSave={(patch) =>
                  update.mutateAsync({ productId: product.id, patch }).then(
                    () => true,
                    () => false,
                  )
                }
                onRetire={() => retire.mutate({ productId: product.id })}
              />
            ))}

            {drafting ? (
              <DraftRow
                busy={create.isPending}
                onCancel={() => {
                  create.reset();
                  setDrafting(false);
                }}
                onCreate={(input) => {
                  create.mutate(input, { onSuccess: () => setDrafting(false) });
                }}
              />
            ) : null}

            {(items ?? []).length === 0 && !drafting ? (
              /*
                The design's own empty line, inside the card where it draws it —
                and the action that fills it is the "+ Add product" button
                directly above, which is why this is the design's sentence rather
                than an `EmptyState` block that would repeat the button.
              */
              <p className="shop__empty">No products yet — add your first one.</p>
            ) : null}
          </>
        )}
      </Card>

      <div className="shop__foot">
        {/*
          The count is withheld while pending rather than rendered as a zero: "0
          products" announced over a card of skeletons is a claim about an empty
          catalog that nobody has looked at yet.
        */}
        <span className="shop__count">
          {products.isPending
            ? 'changes save as you type.'
            : `${countLabel(items?.length ?? 0)} · changes save as you type.`}
        </span>
        {update.isPending || create.isPending || retire.isPending ? (
          <span className="shop__saving" role="status">
            Saving…
          </span>
        ) : null}
      </div>

      {/*
        One banner per write, each with its own reassurance — the wrong one is
        worse than none. A merchant whose retire failed needs to know the product
        is still for sale; one whose edit failed needs to know the salon is still
        charging the old price for it.
      */}
      {update.isError ? (
        <WriteError error={update.error} reassurance="That product is unchanged." />
      ) : null}
      {create.isError ? (
        <WriteError error={create.error} reassurance="No product was added." />
      ) : null}
      {retire.isError ? (
        <WriteError
          error={retire.error}
          reassurance="Nothing was removed — that product is still for sale."
        />
      ) : null}
    </div>
  );
}

/** The design's `productCount`: "5 products", "1 product". */
export function countLabel(count: number): string {
  return `${count} product${count === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------------ the module state
 *
 * COPY THE DESIGN DOES NOT CONTAIN, written rather than omitted, and named as
 * such. `AVO Merchant Dashboard.dc.html` draws no module-off state on the Shop
 * section — the prototype has no modules at all beyond two switches in Settings.
 * Omitting it was the other option and it is worse: a merchant would build a
 * catalog nobody can see and get no hint of why, on the one screen where the
 * flag matters.
 *
 * It reuses the design's own words for the module ("Flat catalog, pay from
 * wallet, pickup at salon") and names the switch by its drawn location, so the
 * sentence points at a control that exists rather than at a support call.
 */
export function ShopModuleOffNotice() {
  return (
    <InfoBanner
      icon={
        <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
          <path
            d="M5 6.5h10l-.8 10.5H5.8z"
            stroke="currentColor"
            strokeWidth="1.6"
            fill="none"
            strokeLinejoin="round"
          />
          <path
            d="M7.5 7V5a2.5 2.5 0 0 1 5 0v2"
            stroke="currentColor"
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
      }
    >
      <b>The Shop module is off, so customers can&rsquo;t buy any of this yet.</b> Build the catalog
      here, then turn Shop on in Settings → Optional modules — flat catalog, pay from wallet, pickup
      at salon.
    </InfoBanner>
  );
}

/* ------------------------------------------------------------------- one row */

interface ProductRowProps {
  product: Product;
  /**
   * The picture cell, INJECTED RATHER THAN MOUNTED HERE, and the reason is the
   * one `Shop` already follows for its three mutations: this component is a pure
   * function of its props and is rendered bare in `shopRender.test.tsx` with no
   * QueryClient and no session behind it. `ProductImageCell` reads both. Passing
   * it in keeps the row's price/copy guarantees testable without standing up
   * half the app to assert that 8500 fils reads as 8.500.
   *
   * It is a FRAGMENT of two grid-less flex children — the square and, when there
   * is something to say, the sentence under the row. See `.shop__image-note`,
   * which uses `order` to fall to its own line rather than sit in the middle of
   * the row.
   */
  image?: ReactNode;
  saving: boolean;
  retiring: boolean;
  /** Resolves true when the server stored it, false when it refused. */
  onSave: (patch: ProductPatch) => Promise<boolean>;
  onRetire: () => void;
}

export function ProductRow({
  product,
  image = null,
  saving,
  retiring,
  onSave,
  onRetire,
}: ProductRowProps) {
  /*
   * `null` means "follow the server". A string means the merchant is editing,
   * and her text wins until it is stored — including across a failed save, so a
   * refused PATCH never silently throws away what she typed. `WriteError` at the
   * foot of the screen says what happened; this keeps the thing it happened to.
   */
  const [nameText, setNameText] = useState<string | null>(null);
  const [priceText, setPriceText] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const savedName = product.name;
  /*
   * `fils()` AT THE ROW, and it is not ceremony. `ProductSchema.priceFils` is
   * `FilsSchema.positive()` and `FilsSchema` is `z.number().int()` — the wire type
   * is a plain `number`, so the brand has to be re-applied where the value enters
   * the display boundary or `Money` and `priceInputValue` would both accept any
   * number at all. Same call the Overview, Reports and Analytics make for the
   * same reason.
   */
  const priceFils = fils(product.priceFils);
  const savedPrice = priceInputValue(priceFils);
  const nameValue = nameText ?? savedName;
  const priceValue = priceText ?? savedPrice;

  const price = readPriceInput(priceValue);
  const trimmedName = nameValue.trim();

  /*
   * What differs from the stored row AND is legal to send. A blank name is not a
   * patch — `product_name_not_blank` refuses it and `requireString` 400s — so
   * clearing the field to retype is not an error and not a request either.
   */
  const nextName = trimmedName !== '' && trimmedName !== savedName ? trimmedName : undefined;
  const nextPrice =
    price.kind === 'ok' && price.priceFils !== priceFils ? price.priceFils : undefined;
  const unsaved = nextName !== undefined || nextPrice !== undefined;

  /*
   * THE DEBOUNCE, AND WHY IT IS KEYED ON THE VALUES RATHER THAN ON A TIMESTAMP.
   * Every render with a different pending value restarts the timer through the
   * cleanup, so a settled field costs exactly one PATCH and a field still being
   * typed costs none. `onSave` is not in the dependency list on purpose: it is a
   * fresh closure every render and would restart the timer forever.
   */
  const save = useRef(onSave);
  save.current = onSave;
  useEffect(() => {
    if (!unsaved) return;
    const timer = setTimeout(() => {
      const patch: ProductPatch = {};
      if (nextName !== undefined) patch.name = nextName;
      if (nextPrice !== undefined) patch.priceFils = nextPrice;
      void save.current(patch).then((stored) => {
        // Only on success, and only for what was actually sent: dropping the
        // override is what lets the cell settle on the SERVER's value.
        if (!stored) return;
        if (patch.name !== undefined) setNameText(null);
        if (patch.priceFils !== undefined) setPriceText(null);
      });
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [unsaved, nextName, nextPrice]);

  return (
    <>
      <div className="shop__row" data-unsaved={unsaved || undefined}>
        {image}
        <input
          className="avo-input shop__name"
          aria-label={`Product name — ${savedName}`}
          placeholder="Product name"
          value={nameValue}
          disabled={retiring}
          onChange={(event) => setNameText(event.target.value)}
          /* On blur the cell goes back to following the server, so a stored
             name shows as stored (trimmed) rather than as typed. A name still
             on its way to the server keeps the override. */
          onBlur={() => {
            if (trimmedName === savedName) setNameText(null);
          }}
        />

        <div className="shop__price" data-invalid={price.kind === 'invalid' || undefined}>
          <input
            className="shop__price-input"
            aria-label={`Price in KD — ${savedName}`}
            placeholder="0.000"
            inputMode="decimal"
            value={priceValue}
            disabled={retiring}
            onChange={(event) => setPriceText(event.target.value)}
            /* Snaps to the canonical three decimals when nobody is typing in
               it: `8.5` and `8.500` are the same number and different amounts
               of money, and the second one is what the salon charges. */
            onBlur={() => {
              if (price.kind === 'ok' && price.priceFils === priceFils) setPriceText(null);
            }}
          />
          <span className="shop__price-unit" aria-hidden="true">
            KD
          </span>
        </div>

        {/*
          "Remove", not "Delete" — see the header. `title` and `aria-label` both,
          because the design's affordance is a bare ✕ and the glyph is hidden
          from assistive tech.
        */}
        <button
          type="button"
          className="shop__remove"
          aria-label={`Remove ${savedName} from the catalog`}
          title={`Remove ${savedName} from the catalog`}
          disabled={retiring || saving}
          onClick={() => setConfirming(true)}
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>

      {price.kind === 'invalid' ? (
        <p className="shop__row-note" role="alert">
          {price.message}
        </p>
      ) : null}

      {confirming ? (
        <div className="shop__confirm" role="group" aria-label={`Remove ${savedName}?`}>
          <p className="shop__confirm-text">
            Remove{' '}
            <b>
              {savedName} · <Money amount={priceFils} withUnit />
            </b>{' '}
            from the catalog? It stops being for sale straight away and leaves this list. Past orders
            keep their line, so old receipts still name it — and it cannot be brought back here.
          </p>
          <div className="shop__confirm-actions">
            <Button
              variant="secondary"
              disabled={retiring}
              onClick={() => {
                setConfirming(false);
                onRetire();
              }}
            >
              {retiring ? 'Removing…' : 'Remove from catalog'}
            </Button>
            <Button variant="quiet" onClick={() => setConfirming(false)}>
              Keep selling it
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ----------------------------------------------------------------- the draft */

interface DraftRowProps {
  busy: boolean;
  onCancel: () => void;
  onCreate: (input: { name: string; priceFils: Fils }) => void;
}

export function DraftRow({ busy, onCancel, onCreate }: DraftRowProps) {
  const [name, setName] = useState('');
  const [priceRaw, setPriceRaw] = useState('');
  const price = readPriceInput(priceRaw);
  const trimmed = name.trim();

  /*
   * Both halves, before the request rather than instead of it. The server
   * refuses each of these by name — `requireString`, `parseAmountFils`,
   * `product_price_positive` — and the round trip adds nothing a merchant can
   * act on that this does not.
   */
  const ready = trimmed !== '' && price.kind === 'ok';

  return (
    <>
      <div className="shop__row shop__row--draft">
        <input
          className="avo-input shop__name"
          aria-label="New product name"
          placeholder="Product name"
          value={name}
          disabled={busy}
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
        <div className="shop__price" data-invalid={price.kind === 'invalid' || undefined}>
          <input
            className="shop__price-input"
            aria-label="New product price in KD"
            placeholder="0.000"
            inputMode="decimal"
            value={priceRaw}
            disabled={busy}
            onChange={(event) => setPriceRaw(event.target.value)}
          />
          <span className="shop__price-unit" aria-hidden="true">
            KD
          </span>
        </div>
        <Button
          disabled={busy || !ready}
          onClick={() => {
            if (price.kind !== 'ok' || trimmed === '') return;
            onCreate({ name: trimmed, priceFils: price.priceFils });
          }}
        >
          {busy ? 'Adding…' : 'Add'}
        </Button>
        <button
          type="button"
          className="shop__remove"
          aria-label="Discard this new product"
          title="Discard this new product"
          disabled={busy}
          onClick={onCancel}
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>

      {price.kind === 'invalid' ? (
        <p className="shop__row-note" role="alert">
          {price.message}
        </p>
      ) : (
        /*
          Why there is an Add button here and nowhere else on the screen. Said
          once, next to the control, rather than left as a difference from the
          drawn behaviour that nobody can account for.
        */
        <p className="shop__row-note shop__row-note--quiet">
          A product needs a name and a price above zero before it can be saved. Existing rows save
          as you type.
        </p>
      )}
    </>
  );
}

/* --------------------------------------------------------------- the picture */

/**
 * One product's photo: the square, and the sentence under the row when there is
 * something to say about it.
 *
 * A FRAGMENT, ON PURPOSE. Both nodes are direct children of `.shop__row`'s flex
 * box — a React fragment creates no box — so the square sits at the head of the
 * row and the note falls to its own line beneath it through `order` and a
 * full-width basis. A wrapper around the pair would put the sentence inside the
 * row's 52px column.
 *
 * ============================================================================
 * TWO OBJECT URLS, AND THE COMPONENT OWNS BOTH
 * ============================================================================
 * `useProductImage` holds the one for the SERVER's bytes and revokes it in its
 * own cleanup. This component holds the second: a local preview of the file the
 * merchant just picked, created from the `File` itself so she watches HER photo
 * go up rather than a spinner.
 *
 * THE PREVIEW OUTLIVES THE UPLOAD ON PURPOSE. Clearing it the instant the 201
 * lands would drop the row back to `loading` while the authenticated read fetches
 * the identical bytes it just sent — a picture that appears, vanishes and
 * reappears, which reads as a failed save. So it is held until the server's own
 * copy reports `ready`, and revoked then. Same bytes either side of the swap, so
 * nothing flickers.
 */
export function ProductImageCell({ product }: { product: Product }) {
  const upload = useUploadProductImage();
  const remove = useRemoveProductImage();
  const load = useProductImage(product.image);

  /** The file going up, or just gone up and not yet readable from the server. */
  const [picked, setPicked] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  /**
   * A src that arrived and would not paint. Keyed on the src itself so a
   * REPLACEMENT is not tarred with the broken one's verdict — `brokenSrc === src`
   * is the test, never a bare boolean.
   */
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  /** 201 or 200, in words. Cleared the moment she does anything else. */
  const [outcome, setOutcome] = useState<'added' | 'changed' | 'removed' | null>(null);

  useEffect(() => {
    if (!picked) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(picked);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [picked]);

  /*
   * The handover. `upload.isSuccess` alone would fire on the PREVIOUS upload's
   * result the moment a second file is picked, so `onPick` resets the mutation
   * before it starts the next one and this stays a statement about the file
   * currently in `picked`.
   */
  useEffect(() => {
    if (picked && upload.isSuccess && load.status === 'ready') setPicked(null);
  }, [picked, upload.isSuccess, load.status]);

  const paintedSrc = previewUrl ?? load.objectUrl;
  const broken = paintedSrc !== null && brokenSrc === paintedSrc;

  const state = broken
    ? 'error'
    : upload.isPending
      ? 'uploading'
      : paintedSrc !== null
        ? 'ready'
        : load.status === 'loading'
          ? 'loading'
          : load.status === 'error'
            ? 'error'
            : 'empty';

  const rejection = upload.isError ? imageRejection(upload.error) : null;
  const removeFailed = remove.isError ? imageRejection(remove.error) : null;

  return (
    <>
      <div className="shop__image">
        <ImageSlot
          state={state}
          src={paintedSrc}
          /*
           * The product's name, because that is what the picture is OF. `alt` on
           * a catalog thumbnail beside a field already carrying the same name is
           * a repetition for a screen reader, but the alternative — `alt=""` — is
           * worse the moment the row is read out of context.
           */
          alt={`${product.name}`}
          label={
            state === 'empty'
              ? `Add a photo to ${product.name}`
              : `Replace the photo on ${product.name}`
          }
          placeholder="Photo"
          size={52}
          radius={14}
          disabled={remove.isPending}
          removeLabel={`Remove the photo from ${product.name}`}
          onRemove={
            /* No ✕ until there is something to take off — and never over a
               preview that has not landed yet, which would offer to delete an
               image the server does not have. */
            product.image && !upload.isPending
              ? () => {
                  setOutcome(null);
                  upload.reset();
                  remove.mutate(
                    { productId: product.id },
                    { onSuccess: () => setOutcome('removed') },
                  );
                }
              : undefined
          }
          onImageError={() => setBrokenSrc(paintedSrc)}
          onPick={(file) => {
            setOutcome(null);
            setBrokenSrc(null);
            remove.reset();
            upload.reset();
            setPicked(file);
            upload.mutate(
              { productId: product.id, file },
              {
                onSuccess: ({ created }) => setOutcome(created ? 'added' : 'changed'),
                // The preview goes with the failure. Leaving her rejected file on
                // screen would say the catalog now shows it, and it does not.
                onError: () => setPicked(null),
              },
            );
          }}
        />
      </div>

      {/*
        ONE LINE PER ROW, AND THE PRIORITY IS DELIBERATE: a refusal outranks a
        confirmation, and both outrank a read that failed. A merchant whose upload
        was just refused must not be reading "Photo added" from the attempt before
        it.
      */}
      {rejection ? (
        <p className="shop__image-note shop__image-note--bad" role="alert">
          {rejection.message}
          {rejection.aside ? <span className="shop__image-aside">{rejection.aside}</span> : null}
        </p>
      ) : removeFailed ? (
        <p className="shop__image-note shop__image-note--bad" role="alert">
          {removeFailed.message}
          <span className="shop__image-aside">That photo is still on the product.</span>
        </p>
      ) : upload.isPending ? (
        <p className="shop__image-note" role="status">
          Uploading {picked?.name ?? 'photo'}…
        </p>
      ) : remove.isPending ? (
        <p className="shop__image-note" role="status">
          Removing the photo…
        </p>
      ) : outcome ? (
        <p className="shop__image-note" role="status">
          {OUTCOME_COPY[outcome]}
        </p>
      ) : load.status === 'error' ? (
        <p className="shop__image-note shop__image-note--bad" role="alert">
          {load.message}
        </p>
      ) : broken ? (
        <p className="shop__image-note shop__image-note--bad" role="alert">
          That photo will not open. Drop a new one on the square to replace it.
        </p>
      ) : null}
    </>
  );
}

/**
 * "Added" and "changed" are the 201 and the 200, and they are different things to
 * say. A replacement is the case where the new picture may look much like the old
 * one, so the confirmation is the only evidence the write took at all.
 */
const OUTCOME_COPY: Record<'added' | 'changed' | 'removed', string> = {
  added: 'Photo added.',
  changed: 'Photo changed.',
  removed: 'Photo removed.',
};
