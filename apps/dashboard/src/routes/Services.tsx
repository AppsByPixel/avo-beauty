import { useState, type ReactNode } from 'react';
import { fils, type Fils, type Service } from '@avo/types';
import { Button, Card, Chip, InfoBanner, Money, Pill, Skeleton } from '@avo/ui';
import { useArtists, type DashboardArtist } from '../api/artists.js';
import { priceInputValue, readPriceInput } from '../api/products.js';
import {
  useAssignServiceArtists,
  useCreateService,
  useRetireService,
  useSalonServices,
  useUpdateService,
  type ServicePatch,
} from '../api/services.js';
import { useSession } from '../auth/AuthProvider.js';
import { SectionError, WriteError } from './sectionState.js';

/**
 * Merchant → Services. The client's M7: "a Services tab where they can add the
 * services, price it, then assign them."
 *
 * NOT IN THE DESIGN BUNDLE. `AVO Merchant Dashboard.dc.html` has no services
 * screen — until lane A's `api/src/routes/services.ts` the API only LISTED
 * services, and a merchant could not add, price or staff one at all. So this is
 * built in the dashboard's own idiom, and the idiom is Shop's catalogue: a card
 * of hairline rows, a KD price cell with the unit beside it, a draft row with an
 * explicit Add, and a ✕ that retires with a confirmation. Nothing is restyled;
 * the classes are Shop's, plus the few this screen's second line needs.
 *
 * ---------------------------------------------------------------------------
 * TWO PERMISSIONS ON ONE SCREEN, AND EACH CONTROL ANSWERS TO ITS OWN
 *
 *   perms.loyalty   add, rename, reprice, retire — price is salon configuration,
 *                   the same class of authority as the booking deposit, and
 *                   `loyalty` is the de facto Settings permission.
 *   perms.team      who does it — roster administration, like an artist's
 *                   branch and hours.
 *
 * So a reader with `team` and not `loyalty` sees the menu as TEXT, with the
 * Assign control live; a reader with `loyalty` and not `team` edits every price
 * and sees no Assign control and no names (the roster is `perms.team`, so she
 * gets a count). Neither is told the screen is closed to her, because it isn't.
 *
 * THE HIDING IS A COURTESY; THE SERVER IS THE CONTROL (#7). Each write is
 * refused independently by `requireDashboardPerm` on its own route, and a
 * permission revoked while this screen is open reaches her as the server's 403
 * sentence in the write's own banner — `servicesRender.test.tsx` calls each hook
 * with the permission off and renders what comes back.
 *
 * THE READ IS UNGATED (`requireSalonScoped`), so there is no forbidden wall on
 * the list — `SectionError` still gets a `forbiddenTitle`, for a salon whose
 * booking module refuses the read to a principal kind it does not expect.
 *
 * ---------------------------------------------------------------------------
 * PRICE IS MONEY (#1), AND IT BECOMES FILS IN ONE PLACE
 *
 * The merchant types KD; the wire is integer fils. `readPriceInput`
 * (`api/products.ts`) is the one wrapper over `parseKwdInput` from `@avo/types`
 * — digit strings split at the point and assembled as integers, never
 * `parseFloat`, never `× 1000`. `8.5` is 8500, `8.500` is 8500, and `8.5005` is
 * REFUSED before any request rather than rounded, because a fourth decimal is
 * not a fils this currency has. Display goes back through `formatFils` /
 * `<Money>`. Shared with Shop rather than copied, so the two price cells cannot
 * disagree about what a price is.
 *
 * ---------------------------------------------------------------------------
 * EDITS SAVE ON A BUTTON, NOT AS YOU TYPE — THE DEPARTURE FROM SHOP, AND WHY
 *
 * Shop's rows debounce-save. A service price is read by `POST /charges` at the
 * moment a sale is posted, so a repricing takes effect on the next basket the
 * counter charges — including one already on the scanner's screen. That is the
 * sentence lane A asked to be put in front of her BEFORE she saves, and a
 * 700 ms debounce would show it for 700 ms after the fact. So a changed row
 * grows the sentence and a Save button, and nothing is sent until she presses
 * it.
 */

const NOT_FOUND = {
  unknown_service: 'That service is no longer on the menu — someone may have just retired it.',
  unknown_artist: 'One of those staff members is no longer on this salon’s team.',
} as const;

export function Services() {
  const session = useSession('merchant');
  const canPrice = session.perms.loyalty;
  const canAssign = session.perms.team;

  const services = useSalonServices();
  const roster = useArtists(canAssign);
  const create = useCreateService();
  const [drafting, setDrafting] = useState(false);

  if (services.isError) {
    return (
      <SectionError
        error={services.error}
        forbiddenTitle="You don't have access to services"
        failedTitle="Couldn't load the services"
        onRetry={() => void services.refetch()}
        retrying={services.isFetching}
      />
    );
  }

  const items = services.data?.items;

  return (
    <div className="shop services">
      <div className="shop__head">
        <span className="shop__hint">
          Add a service, price it, then assign the staff who do it. Customers can book a service
          once someone is assigned; the counter can charge it straight away.
        </span>
        {canPrice && !services.isPending && !drafting ? (
          <Button onClick={() => setDrafting(true)}>+ Add service</Button>
        ) : null}
      </div>

      {canPrice && canAssign ? null : <PermissionNote canPrice={canPrice} canAssign={canAssign} />}

      <Card className="shop__card">
        {services.isPending ? (
          [0, 1, 2, 3, 4].map((n) => (
            <div className="shop__row" key={n}>
              <Skeleton width="100%" height={40} radius={10} />
              <Skeleton width={130} height={40} radius={10} />
              <Skeleton width={32} height={32} radius={8} />
            </div>
          ))
        ) : (
          <>
            {(items ?? []).map((service) => (
              <ServiceRow
                key={service.id}
                service={service}
                canPrice={canPrice}
                canAssign={canAssign}
                roster={roster.data?.items}
                rosterState={
                  !canAssign ? 'hidden' : roster.isError ? 'error' : roster.isPending ? 'loading' : 'ready'
                }
                rosterError={roster.error}
                onRetryRoster={() => void roster.refetch()}
              />
            ))}

            {drafting ? (
              <DraftServiceRow
                busy={create.isPending}
                onCancel={() => {
                  create.reset();
                  setDrafting(false);
                }}
                onCreate={(input) => create.mutate(input, { onSuccess: () => setDrafting(false) })}
              />
            ) : null}

            {(items ?? []).length === 0 && !drafting ? (
              <p className="shop__empty">
                {canPrice
                  ? 'No services yet — add your first.'
                  : 'No services yet — a manager with the Loyalty permission can add the first.'}
              </p>
            ) : null}
          </>
        )}
      </Card>

      <div className="shop__foot">
        {/* Withheld while pending: "0 services" over skeletons is a claim nobody checked. */}
        <span className="shop__count">
          {services.isPending ? '' : serviceCountLabel(items?.length ?? 0)}
        </span>
      </div>

      {create.isError ? (
        <WriteError error={create.error} reassurance="No service was added." />
      ) : null}
    </div>
  );
}

export function serviceCountLabel(count: number): string {
  return `${count} service${count === 1 ? '' : 's'} on the menu`;
}

/**
 * WHAT THIS READER CAN AND CANNOT DO HERE, said once at the top rather than as a
 * row of disabled controls. The permission names are the Accounts → Team chips'
 * (`api/staff.ts § PERMISSIONS`), so she can ask for the right one.
 */
function PermissionNote({ canPrice, canAssign }: { canPrice: boolean; canAssign: boolean }) {
  const text = canAssign
    ? 'You can assign staff to services. Adding, pricing and retiring them needs the Loyalty permission — a manager can grant it.'
    : canPrice
      ? 'You can add, price and retire services. Assigning staff to them needs the Team & accounts permission — a manager can grant it.'
      : 'You can see the menu. Adding and pricing services needs the Loyalty permission, and assigning staff needs Team & accounts — a manager can grant them.';
  return (
    <div className="services__note">
      <InfoBanner>{text}</InfoBanner>
    </div>
  );
}

/* ------------------------------------------------------------------ one row */

type RosterState = 'hidden' | 'loading' | 'error' | 'ready';

interface ServiceRowProps {
  service: Service;
  canPrice: boolean;
  canAssign: boolean;
  roster: DashboardArtist[] | undefined;
  rosterState: RosterState;
  rosterError: unknown;
  onRetryRoster: () => void;
}

/**
 * EXPORTED for `servicesRender.test.tsx`. Owns its three writes (edit, retire,
 * assign) so each banner sits under the row it is about, with the reassurance
 * for THAT write — a failed reprice must say the old price still stands, and a
 * failed retire that the service is still on the menu.
 */
export function ServiceRow({
  service,
  canPrice,
  canAssign,
  roster,
  rosterState,
  rosterError,
  onRetryRoster,
}: ServiceRowProps) {
  const update = useUpdateService();
  const retire = useRetireService();
  const assign = useAssignServiceArtists();

  const [nameText, setNameText] = useState<string | null>(null);
  const [nameArText, setNameArText] = useState<string | null>(null);
  const [priceText, setPriceText] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [assigning, setAssigning] = useState(false);

  const savedPrice = fils(service.priceFils);
  const savedNameAr = service.nameAr ?? '';

  const nameValue = nameText ?? service.name;
  const nameArValue = nameArText ?? savedNameAr;
  const priceValue = priceText ?? priceInputValue(savedPrice);

  const price = readPriceInput(priceValue);
  const trimmedName = nameValue.trim();
  const trimmedNameAr = nameArValue.trim();

  const patch: ServicePatch = {};
  if (trimmedName !== '' && trimmedName !== service.name) patch.name = trimmedName;
  if (trimmedNameAr !== savedNameAr) patch.nameAr = trimmedNameAr === '' ? null : trimmedNameAr;
  if (price.kind === 'ok' && price.priceFils !== savedPrice) patch.priceFils = price.priceFils;
  /*
   * "DIRTY" IS "WHAT SHE TYPED DIFFERS FROM WHAT IS STORED", or cannot be saved as
   * typed — an emptied name or price, or a price that is not money. Typing a
   * value back to what it was is not a change and grows no Save button.
   */
  const dirty =
    Object.keys(patch).length > 0 || price.kind !== 'ok' || trimmedName === '';
  const savable = Object.keys(patch).length > 0 && price.kind === 'ok' && trimmedName !== '';

  function discard() {
    setNameText(null);
    setNameArText(null);
    setPriceText(null);
    update.reset();
  }

  const busy = update.isPending || retire.isPending || assign.isPending;

  return (
    <div className="services__item">
      <div className="shop__row services__row" data-unsaved={dirty || undefined}>
        {canPrice ? (
          <>
            <input
              className="avo-input shop__name"
              aria-label={`Service name — ${service.name}`}
              placeholder="Service name"
              value={nameValue}
              disabled={busy}
              onChange={(event) => setNameText(event.target.value)}
            />
            {/*
              CONTENT, NOT CHROME. The dashboard is English-only; this field is
              what the Arabic wallet shows a customer. Blank falls back to the
              English name, server-side (`nameAr ?? name`), and blank is sent as
              `null` — the column refuses an empty string for that reason.
            */}
            <input
              className="avo-input shop__name services__name-ar"
              aria-label={`Arabic name — ${service.name}`}
              placeholder="Arabic name (optional)"
              lang="ar"
              dir="rtl"
              value={nameArValue}
              disabled={busy}
              onChange={(event) => setNameArText(event.target.value)}
            />
            <div className="shop__price" data-invalid={price.kind === 'invalid' || undefined}>
              <input
                className="shop__price-input"
                aria-label={`Price in KD — ${service.name}`}
                placeholder="0.000"
                inputMode="decimal"
                value={priceValue}
                disabled={busy}
                onChange={(event) => setPriceText(event.target.value)}
              />
              <span className="shop__price-unit" aria-hidden="true">
                KD
              </span>
            </div>
            <button
              type="button"
              className="shop__remove"
              aria-label={`Retire ${service.name}`}
              title={`Retire ${service.name}`}
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              <span aria-hidden="true">✕</span>
            </button>
          </>
        ) : (
          <>
            <span className="services__name-text">
              {service.name}
              {service.nameAr ? (
                <span className="services__name-ar-text" lang="ar" dir="rtl">
                  {service.nameAr}
                </span>
              ) : null}
            </span>
            <span className="services__price-text">
              <Money amount={savedPrice} withUnit />
            </span>
          </>
        )}
      </div>

      <StaffLine service={service} roster={roster} rosterState={rosterState}>
        {canAssign ? (
          <Button
            variant="quiet"
            aria-expanded={assigning}
            disabled={busy || rosterState !== 'ready'}
            onClick={() => {
              assign.reset();
              setAssigning(!assigning);
            }}
          >
            Assign staff
          </Button>
        ) : null}
      </StaffLine>

      {rosterState === 'error' ? (
        <div className="services__panel">
          <SectionError
            error={rosterError}
            forbiddenTitle="You can't see the team"
            failedTitle="Couldn't load the team"
            onRetry={onRetryRoster}
            retrying={false}
          />
        </div>
      ) : null}

      {price.kind === 'invalid' ? (
        <p className="shop__row-note" role="alert">
          {price.message}
        </p>
      ) : null}

      {canPrice && dirty ? (
        <div className="services__panel" role="group" aria-label={`Save changes to ${service.name}`}>
          {patch.priceFils !== undefined ? (
            <PriceChangeNote from={savedPrice} to={patch.priceFils} />
          ) : null}
          <div className="shop__confirm-actions">
            <Button
              disabled={busy || !savable}
              onClick={() =>
                update.mutate(
                  { serviceId: service.id, patch },
                  {
                    // Drop the overrides only on success, so the row settles on
                    // what the server STORED. A failure keeps what she typed.
                    onSuccess: () => {
                      setNameText(null);
                      setNameArText(null);
                      setPriceText(null);
                    },
                  },
                )
              }
            >
              {update.isPending ? 'Saving…' : 'Save changes'}
            </Button>
            <Button variant="quiet" disabled={update.isPending} onClick={discard}>
              Discard
            </Button>
          </div>
        </div>
      ) : null}

      {confirming ? (
        <div className="shop__confirm" role="group" aria-label={`Retire ${service.name}?`}>
          <p className="shop__confirm-text">
            Retire{' '}
            <b>
              {service.name} · <Money amount={savedPrice} withUnit />
            </b>
            ? It disappears from new bookings and from the counter basket straight away. Appointments
            already booked for it stay booked and still complete at the counter — ring the visit up
            as another service or a custom amount. Past receipts keep its name, and it cannot be
            brought back here.
          </p>
          <div className="shop__confirm-actions">
            <Button
              variant="secondary"
              disabled={retire.isPending}
              onClick={() =>
                retire.mutate({ serviceId: service.id }, { onSuccess: () => setConfirming(false) })
              }
            >
              {retire.isPending ? 'Retiring…' : 'Retire service'}
            </Button>
            <Button variant="quiet" disabled={retire.isPending} onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </div>
        </div>
      ) : null}

      {assigning && roster ? (
        <AssignPanel
          service={service}
          roster={roster}
          busy={assign.isPending}
          onCancel={() => setAssigning(false)}
          onSave={(artistIds) =>
            assign.mutate(
              { serviceId: service.id, artistIds },
              { onSuccess: () => setAssigning(false) },
            )
          }
        />
      ) : null}

      {update.isError ? (
        <WriteError
          error={update.error}
          notFound={NOT_FOUND}
          reassurance={`${service.name} is unchanged — the counter still charges ${priceInputValue(savedPrice)} KD.`}
        />
      ) : null}
      {retire.isError ? (
        <WriteError
          error={retire.error}
          notFound={NOT_FOUND}
          reassurance="Nothing was retired — that service is still on the menu."
        />
      ) : null}
      {assign.isError ? (
        <WriteError
          error={assign.error}
          notFound={NOT_FOUND}
          reassurance="Nobody’s assignment changed."
        />
      ) : null}
    </div>
  );
}

/**
 * LANE A'S SENTENCE, IN PLAIN WORDS, BEFORE SHE SAVES.
 *
 *   - past charges and a booking's deposit do not move: a charge stores its own
 *     amount, and the deposit is the salon's deposit, not the service price;
 *   - an unpaid basket at the counter DOES take the new price, because the
 *     scanner's basket is a list of service ids and `POST /charges` prices it
 *     from these rows at the moment it is charged.
 *
 * EXPORTED for the spec that pins it renders before the save, not after.
 */
export function PriceChangeNote({ from, to }: { from: Fils; to: Fils }) {
  return (
    <p className="services__price-note">
      <b>
        From <Money amount={from} withUnit /> to <Money amount={to} withUnit />.
      </b>{' '}
      Past charges and booking deposits don&rsquo;t change — they keep the amounts they were made
      at. A basket that hasn&rsquo;t been paid at the counter yet will be charged the new price,
      because the counter prices a sale when it is charged.
    </p>
  );
}

/**
 * WHO DOES IT, AND WHETHER ANYONE CAN BOOK IT.
 *
 * `artistIds: []` is what every NEW service starts as — chargeable at the
 * counter, bookable by nobody, and the wallet hides it. Without this line she
 * would create a service and wonder why customers can't book it.
 *
 * With the roster (perms.team) the line names people, and it can tell a second
 * unbookable case apart: assigned only to RETIRED artists, whose ids the server
 * still serves so a save round-trips them. Without the roster it can only count
 * — which is still enough for the case that matters, the empty list.
 */
function StaffLine({
  service,
  roster,
  rosterState,
  children,
}: {
  service: Service;
  roster: DashboardArtist[] | undefined;
  rosterState: RosterState;
  children: ReactNode;
}) {
  const ids = service.artistIds;
  let body: ReactNode;

  if (ids.length === 0) {
    body = (
      <Pill tone="warn" dot>
        Not bookable yet — assign staff
      </Pill>
    );
  } else if (rosterState === 'ready' && roster) {
    const assigned = roster.filter((a) => ids.includes(a.id));
    const active = assigned.filter((a) => a.active);
    body =
      active.length === 0 ? (
        <Pill tone="warn" dot>
          Not bookable — only retired staff are assigned
        </Pill>
      ) : (
        <span className="services__staff">Done by {active.map((a) => a.name).join(', ')}</span>
      );
  } else if (rosterState === 'loading') {
    body = <Skeleton width={160} height={14} />;
  } else {
    body = (
      <span className="services__staff">
        {ids.length} staff member{ids.length === 1 ? '' : 's'} assigned
      </span>
    );
  }

  return (
    <div className="services__staff-line">
      {body}
      {children}
    </div>
  );
}

/**
 * The per-service checklist, saved as a whole — `PUT …/artists` REPLACES the set.
 *
 * EVERY ARTIST THE ROSTER HAS IS DRAWN, retired ones included and labelled, so
 * an assignment the server serves is never silently dropped by a save: an id
 * she did not untick goes back as it came. An id the roster does not know at
 * all (it cannot happen today — the roster is every artist of the salon — but a
 * cast-free client does not assume) is carried through untouched for the same
 * reason.
 */
export function AssignPanel({
  service,
  roster,
  busy,
  onCancel,
  onSave,
}: {
  service: Service;
  roster: DashboardArtist[];
  busy: boolean;
  onCancel: () => void;
  onSave: (artistIds: string[]) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(service.artistIds));
  const shown = new Set(roster.map((a) => a.id));
  const unseen = service.artistIds.filter((id) => !shown.has(id));
  const next = [...unseen, ...roster.filter((a) => picked.has(a.id)).map((a) => a.id)];
  const changed =
    next.length !== service.artistIds.length || next.some((id) => !service.artistIds.includes(id));

  return (
    <div className="services__panel" role="group" aria-label={`Staff for ${service.name}`}>
      {roster.length === 0 ? (
        <p className="services__panel-text">
          There is nobody on the team yet. Add artists under Team, then assign them here.
        </p>
      ) : (
        <>
          <p className="services__panel-text">
            Who does <b>{service.name}</b>? Customers can book it with anyone ticked here. Bookings
            already made are not moved.
          </p>
          <div className="services__chips">
            {roster.map((artist) => (
              <Chip
                key={artist.id}
                dot
                on={picked.has(artist.id)}
                disabled={busy}
                label={artist.active ? artist.name : `${artist.name} (retired)`}
                onClick={() =>
                  setPicked((current) => {
                    const copy = new Set(current);
                    if (copy.has(artist.id)) copy.delete(artist.id);
                    else copy.add(artist.id);
                    return copy;
                  })
                }
              />
            ))}
          </div>
          {next.length === 0 ? (
            <p className="services__panel-text services__panel-text--warn">
              With nobody ticked, customers can&rsquo;t book {service.name}. The counter can still
              charge it.
            </p>
          ) : null}
        </>
      )}
      <div className="shop__confirm-actions">
        <Button disabled={busy || !changed} onClick={() => onSave(next)}>
          {busy ? 'Saving…' : 'Save staff'}
        </Button>
        <Button variant="quiet" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- the draft */

/**
 * A new service is a draft with an explicit Add — Shop's reason: `POST` needs a
 * name AND a positive price, and a debounce would create one at whatever
 * half-typed number the pause landed on.
 */
export function DraftServiceRow({
  busy,
  onCancel,
  onCreate,
}: {
  busy: boolean;
  onCancel: () => void;
  onCreate: (input: { name: string; nameAr?: string; priceFils: Fils }) => void;
}) {
  const [name, setName] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [priceRaw, setPriceRaw] = useState('');
  const price = readPriceInput(priceRaw);
  const trimmed = name.trim();
  const trimmedAr = nameAr.trim();
  const ready = trimmed !== '' && price.kind === 'ok';

  return (
    <div className="services__item">
      <div className="shop__row shop__row--draft services__row">
        <input
          className="avo-input shop__name"
          aria-label="New service name"
          placeholder="Service name"
          value={name}
          disabled={busy}
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
        <input
          className="avo-input shop__name services__name-ar"
          aria-label="New service Arabic name"
          placeholder="Arabic name (optional)"
          lang="ar"
          dir="rtl"
          value={nameAr}
          disabled={busy}
          onChange={(event) => setNameAr(event.target.value)}
        />
        <div className="shop__price" data-invalid={price.kind === 'invalid' || undefined}>
          <input
            className="shop__price-input"
            aria-label="New service price in KD"
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
            onCreate({
              name: trimmed,
              ...(trimmedAr === '' ? {} : { nameAr: trimmedAr }),
              priceFils: price.priceFils,
            });
          }}
        >
          {busy ? 'Adding…' : 'Add'}
        </Button>
        <button
          type="button"
          className="shop__remove"
          aria-label="Discard this new service"
          title="Discard this new service"
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
        <p className="shop__row-note shop__row-note--quiet">
          A service needs a name and a price above zero. It starts with nobody assigned, so
          customers can book it once you assign staff. A blank Arabic name shows the English one in
          the Arabic app.
        </p>
      )}
    </div>
  );
}
