import { useEffect, useState } from 'react';
import { Button, Card, Segmented, Select, Skeleton, TextField } from '@avo/ui';
import {
  createBookingBody,
  isSlotTaken,
  useCreateBooking,
  type CreateBookingInput,
} from '../api/bookings.js';
import { useBookableArtists } from '../api/artists.js';
import { useCustomerBook } from '../api/customers.js';
import { useSalonServices } from '../api/services.js';
import { instantFromSalonLocal } from './appointmentsWeekRules.js';
import { SectionError, WriteError } from './sectionState.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MERCHANT → APPOINTMENTS → "Add appointment". NEW WORK; THERE IS NO DRAWN
 * SCREEN FOR IT.
 * ═══════════════════════════════════════════════════════════════════════════
 * SAID PLAINLY SO NOBODY GOES LOOKING FOR AN ARTBOARD, on
 * `appointmentsWeekRules.ts`'s precedent. `design/AVO Merchant Dashboard.dc.html`
 * draws Appointments as a READ-ONLY board with exactly one write on it ("Mark
 * no-show", `:184`), and `design/README.md` § Known gaps records no decision
 * about creating one by hand. This is the client extending his own design —
 * "Admin can create appointments manually, for existing or non-existing
 * customers" — which is the case CLAUDE.md § "Do not add features" defers to.
 *
 * SO IT IS BUILT IN THE ESTABLISHED IDIOM RATHER THAN IN A NEW ONE. The shape is
 * `Accounts.tsx § NewAccountForm` — a bordered `Card` above the table, revealed
 * by a `+` button, a two-column field grid that collapses at narrow, actions in
 * a row with a quiet Cancel, and a muted note underneath. Same components, same
 * class grammar, same pending discipline. No colour, type or spacing is new.
 *
 * NOT A MODAL. `console/Salons.tsx § OnboardWizard` is the only modal in this
 * codebase and it is one because onboarding a salon is four steps with a review.
 * This is one step. A hand-built focus trap for a six-field form would be more
 * machinery than the form.
 *
 * NOT A `<form>` ELEMENT EITHER, which is the one place this diverges from the
 * platform and does so to match the codebase: apart from the two sign-in screens
 * nothing in this dashboard submits through `onSubmit`, and a lone `<form>` here
 * would give this card an Enter-to-submit behaviour no other card has.
 */

/* ============================================ the sentence that carries it == */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MOST LOAD-BEARING SENTENCE ON THIS SCREEN
 * ═══════════════════════════════════════════════════════════════════════════
 * A merchant who believes she has taken a deposit will act on that belief at the
 * counter — she will apply it to the bill, or she will tell a customer who did
 * not turn up that her money is gone. Neither is recoverable by the customer,
 * and neither is visible to anyone until it has already happened.
 *
 * SO THE FORM SAYS IT, RATHER THAN LEAVING IT TO BE INFERRED FROM THE ABSENCE OF
 * A DEPOSIT FIELD. An absent field is not a statement; it reads as an omission,
 * and the board this form writes to has a DEPOSIT COLUMN in it, so the merchant
 * has every reason to expect one.
 *
 * IT IS ALSO THE SERVER'S RULE AND NOT THIS SCREEN'S PREFERENCE.
 * `packages/types § BookingSchema.source` argues it as authority rather than
 * limitation: a merchant-created booking for an existing member COULD debit her
 * wallet and must not, because non-negotiable #2 gives the server the balance
 * and "a merchant who can move a customer's money by filling in a form is a
 * merchant who can move it without her". `POST /salons/{id}/bookings` refuses a
 * `depositFils` in the body BY NAME for the same reason.
 *
 * ONE QUIET LINE, IN THE MUTED-LABEL IDIOM — `.new-account__note`'s register,
 * 12px `--avo-text-muted-soft`. Not a banner and not a warning colour: it is a
 * true statement about how this works, not an alarm, and dressing it as an alarm
 * is how merchants learn to stop reading it.
 */
export const NO_DEPOSIT_NOTE =
  'No deposit is taken on an appointment you write down here — the slot is held, ' +
  'not the money. Deposits are taken only when a customer books in the app.';

/* ================================================ the key and what it names == */

export interface HeldKey {
  key: string;
  /** The body this key was minted for, serialised. */
  forBody: string;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE KEY PER SUBMISSION, HELD ACROSS ITS RETRIES, RE-MINTED WHEN THE BODY
 * CHANGES — AND THE THIRD CLAUSE IS THE ONE THAT IS USUALLY MISSING
 * ═══════════════════════════════════════════════════════════════════════════
 * Non-negotiable #4. `api/bookings.ts § the five writes` records why the create
 * takes a key at all: it does not move money, it stops a double submit becoming
 * two hours of one artist's day, and it buys a correct ANSWER rather than a
 * correct effect — the exclusion constraint already refuses the second booking
 * and answers `slot_taken`, "a confusing and slightly alarming thing to show
 * someone who pressed the button once".
 *
 * THE TWO WAYS TO GET THIS WRONG, and this codebase has now met both:
 *
 *   MINTING PER ATTEMPT defeats the header entirely. A failed submit that
 *   retries with a fresh key is a second, unrelated claim — so a request that
 *   actually committed before the connection died is applied twice. That is the
 *   defect `useMarkNoShow`'s header refuses by taking the key as a mutation
 *   VARIABLE rather than minting one inside `useMutation`.
 *
 *   HOLDING ONE KEY TOO LONG is the opposite failure and it is the one lane B
 *   found on the scanner's void sheet: one key minted per SHEET while the reason
 *   could still change, so a changed mind after a failure reused a burnt key and
 *   earned 422 `idempotency_key_reused`. The server hashes the BODY into the
 *   claim — here `{ salonId, artistId, serviceId, startsAt, memberId, guestName,
 *   guestPhone }` — so a key is a claim about one request and not about one
 *   form.
 *
 * `console/Salons.tsx` solves this with a REVIEW STEP: minted on entering step 4,
 * dropped on leaving it, so editing and coming back mints a fresh one. There is
 * no review step here, so the body itself is the boundary: the key is re-minted
 * exactly when the body it would be sent with differs from the body the held key
 * was minted for. Retrying an unchanged form is a retry; changing the artist and
 * pressing again is a different submission, and gets a different key.
 *
 * SERIALISED WITH `JSON.stringify` AND THAT IS SAFE HERE FOR A STATED REASON:
 * `createBookingBody` writes its keys in one fixed order on both branches, so
 * two identical requests cannot produce two different strings. It is the same
 * function whose output is actually sent, so the comparison cannot drift from
 * the request — comparing the FIELDS instead would be a second model of the body
 * and would miss exactly the member/guest omission the server hashes.
 *
 * A PURE FUNCTION WITH THE MINT INJECTED, so the rule is assertable without a
 * component, a clock or a crypto global.
 */
export function submissionKey(
  held: HeldKey | null,
  body: Record<string, unknown>,
  mint: () => string,
): HeldKey {
  const forBody = JSON.stringify(body);
  if (held !== null && held.forBody === forBody) return held;
  return { key: mint(), forBody };
}

/* ====================================================================== ui == */

export interface AppointmentFormProps {
  /** The salon's IANA zone. A wall clock is meaningless without it. */
  timezone: string;
  /**
   * `perms.team`. NOT A STYLING FLAG — see `api/customers.ts § enabled`: a
   * refused read of the customer book writes a `risk` audit row against the
   * person who asked, so a form that searched it without the permission would
   * fill a salon's security log with its own receptionist.
   */
  canSearchDirectory: boolean;
  onClose: () => void;
  onCreated: () => void;
}

type Mode = 'member' | 'guest';

export function AppointmentForm({
  timezone,
  canSearchDirectory,
  onClose,
  onCreated,
}: AppointmentFormProps) {
  /*
   * WALK-IN IS THE DEFAULT FOR A READER WHO CANNOT SEARCH, rather than an
   * "Existing customer" tab that opens onto an explanation of why it does not
   * work. The front desk's own permissions decide which door is in front of her.
   */
  const [mode, setMode] = useState<Mode>(canSearchDirectory ? 'member' : 'guest');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [memberId, setMemberId] = useState<string | null>(null);
  const [guestName, setGuestName] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [artistId, setArtistId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  /**
   * THE KEY LIVES IN THE FORM AND SURVIVES A FAILED SUBMIT. Cleared on success
   * only, alongside everything else — `Appointments.tsx § the armed row`'s rule
   * ("a failure keeps the row armed AND keeps its key, so the retry is a retry")
   * applied to a form instead of a row.
   */
  const [held, setHeld] = useState<HeldKey | null>(null);

  /** `Customers.tsx`'s 300ms, so the two search boxes in this app behave alike. */
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  /*
   * THE BOOKABLE ROSTER, NOT THE TEAM ROSTER. `GET /salons/{id}/artists` is
   * `perms.team` and this form's own gate is `perms.appointments`; the two are
   * different authorities and the seeded front desk holds only the second.
   * `api/artists.ts § useBookableArtists` carries the argument and the second
   * reason: it serves ACTIVE artists, and the create endpoint refuses an
   * inactive one by name.
   */
  const artists = useBookableArtists();
  const services = useSalonServices();
  /*
   * THE DIRECTORY IS ASKED FOR ONLY IN THE MEMBER BRANCH, AND ONLY BY SOMEONE
   * ALLOWED TO ASK — AND THE SECOND HALF IS NOT A PERFORMANCE CONCERN.
   *
   * A walk-in has no member row by definition, so searching one while the
   * Walk-in tab is open is a request whose answer cannot be used. The permission
   * half is sharper: `api/src/routes/customers.ts § requireCustomerDirectory`
   * gates the book on `perms.team` and, on a refusal, writes an audit row with
   * `kind: 'risk'` reading "Attempted to open the customer book without team
   * authority" against the account that asked. ST-002 Hessa is frontdesk —
   * `appointments: true`, `team: false` — so a form that searched anyway would
   * stamp one every 300ms while a receptionist did the job this feature exists
   * for. `api/customers.ts § enabled` carries the full argument.
   */
  const book = useCustomerBook(query, canSearchDirectory && mode === 'member');
  const create = useCreateBooking();

  const chosen =
    memberId === null
      ? null
      : (book.data?.pages.flatMap((p) => p.items).find((c) => c.id === memberId) ?? null);

  /*
   * ============================================================ the states ==
   * LOADING — the two lists this form cannot be filled without. Skeletons in
   * the field grid rather than a spinner over the card: interaction-spec.md §4,
   * and it keeps the card the size it will be so nothing reflows under a cursor.
   *
   * ERROR AND OFFLINE — `SectionError` inside the card. It is the section's
   * component and this is a section of one: it tells a 403 from a dead network
   * from a served 503, renders the server's own sentence for the first, and
   * offers a retry only where there is something to retry. A form that cannot
   * name an artist is not a form with an empty dropdown.
   *
   * EMPTY — a salon with no artists or no services has nothing to book, and the
   * dropdown says so rather than sitting empty. Named separately from the
   * directory's own empty below, which is a different sentence.
   */
  const reads = artists.isError ? artists : services.isError ? services : null;
  const loading = artists.isPending || services.isPending;

  const artistRows = artists.data?.items ?? [];
  const serviceRows = services.data?.items ?? [];

  function submit() {
    setLocalError(null);
    create.reset();

    /*
     * CHECKED IN THE ORDER THE FIELDS ARE READ, `Accounts.tsx § submit`'s shape:
     * one sentence at a time, so a merchant fixes one thing rather than meeting
     * a list. Every one of these is ALSO refused by the server — `identity_required`,
     * `unknown_artist`, `unknown_service`, `invalid_starts_at` — so none of this
     * is the control (#7); it is the half that stops a round trip to learn
     * something the form already knew.
     */
    if (mode === 'member' && memberId === null) {
      setLocalError('Search for the customer and pick her from the list, or switch to Walk-in.');
      return;
    }
    if (mode === 'guest' && guestName.trim() === '') {
      setLocalError("Give the walk-in a name — it is what the board and the artist will show.");
      return;
    }
    if (artistId === '') {
      setLocalError('Pick the artist who will do the appointment.');
      return;
    }
    if (serviceId === '') {
      setLocalError('Pick the service.');
      return;
    }
    if (date === '' || time === '') {
      setLocalError('Pick a date and a time.');
      return;
    }

    /*
     * THE WALL CLOCK BECOMES AN INSTANT IN THE SALON'S ZONE, NOT THE BROWSER'S.
     * `appointmentsWeekRules.ts § instantFromSalonLocal` carries the argument: a
     * manager in London typing 16:45 at a Kuwait salon would otherwise book
     * 19:45 Kuwait time, correctly, silently, three hours from the hour she
     * typed. `null` means the zone is unusable or the date is not a real
     * calendar day, and both are said rather than sent.
     */
    const startsAt = instantFromSalonLocal(date, time, timezone);
    if (startsAt === null) {
      setLocalError(
        `That is not a time we can read in ${timezone}. Check the date, and check the salon's time zone in Settings.`,
      );
      return;
    }

    const input: Omit<CreateBookingInput, 'idempotencyKey'> = {
      artistId,
      serviceId,
      startsAt,
      memberId: mode === 'member' ? memberId : null,
      guestName: mode === 'guest' ? guestName.trim() : null,
      guestPhone: mode === 'guest' ? guestPhone.trim() : null,
    };

    const next = submissionKey(
      held,
      createBookingBody({ ...input, idempotencyKey: '' }),
      () => crypto.randomUUID(),
    );
    setHeld(next);

    create.mutate(
      { ...input, idempotencyKey: next.key },
      {
        onSuccess: () => {
          setHeld(null);
          onCreated();
        },
      },
    );
  }

  const busy = create.isPending;

  return (
    <Card className="new-appt">
      <h3 className="new-appt__title avo-display">New appointment</h3>

      {reads ? (
        <SectionError
          error={reads.error}
          forbiddenTitle="You don't have access to the team and service lists"
          failedTitle="Couldn't load the team and service lists"
          onRetry={() => {
            void artists.refetch();
            void services.refetch();
          }}
          retrying={artists.isFetching || services.isFetching}
        />
      ) : (
        <>
          <div className="new-appt__who">
            <Segmented
              label="Who the appointment is for"
              value={mode}
              onChange={(next) => {
                setMode(next);
                setLocalError(null);
              }}
              options={[
                /*
                  THE TAB IS DISABLED RATHER THAN REMOVED. A missing tab reads
                  as a feature that does not exist; a disabled one with the
                  sentence below it reads as a permission she does not hold,
                  which is the true thing and the one a manager can act on.
                */
                { value: 'member', label: 'Existing customer', disabled: !canSearchDirectory },
                { value: 'guest', label: 'Walk-in' },
              ]}
            />
            {/*
              THE REASON SITS UNDER THE DISABLED TAB, NOT BEHIND IT.

              A disabled control with no explanation is a dead end that reads as
              a bug. It is drawn here rather than inside the member branch
              because that branch is exactly what a reader without `perms.team`
              never reaches — an explanation she has to open the tab to see is
              an explanation she cannot see.

              IT NAMES THE PERMISSION AND WHO GRANTS IT, which is the shape the
              server's own 403 sentences take, so the two read alike whichever
              one she meets first.
            */}
            {!canSearchDirectory ? (
              <p className="new-appt__hint">
                Finding an existing customer needs the <b>Team</b> permission, which this account
                doesn&rsquo;t have. Write the appointment down as a <b>Walk-in</b>, or ask a
                manager to grant it in Accounts.
              </p>
            ) : null}
          </div>

          {mode === 'member' ? (
            <div className="new-appt__search">
              <TextField
                label="Find the customer"
                placeholder="Name, phone or member id"
                value={search}
                disabled={busy}
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setMemberId(null);
                }}
              />
              {/*
                THE SEARCH IS THE SERVER'S — `api/customers.ts § useCustomerBook`
                matches name, phone digits and exact member id across the whole
                salon. Nothing here filters the rows in hand, which would search
                25 customers and then confidently report "no match" about a book
                it has never seen.
              */}
              {chosen ? (
                <div className="new-appt__chosen">
                  <span className="new-appt__chosen-name">{chosen.name}</span>
                  <button
                    type="button"
                    className="new-appt__clear"
                    disabled={busy}
                    onClick={() => setMemberId(null)}
                  >
                    Change
                  </button>
                </div>
              ) : book.isError ? (
                <SectionError
                  error={book.error}
                  forbiddenTitle="You don't have access to the customer directory"
                  failedTitle="Couldn't search the directory"
                  onRetry={() => void book.refetch()}
                  retrying={book.isFetching}
                />
              ) : query === '' ? (
                <p className="new-appt__hint">
                  Type a name or a number to find an existing customer. If she has no account,
                  switch to <b>Walk-in</b>.
                </p>
              ) : book.isPending ? (
                <div className="new-appt__results">
                  {[0, 1, 2].map((n) => (
                    <Skeleton key={n} width={`${70 - n * 12}%`} height={13} />
                  ))}
                </div>
              ) : (book.data?.pages[0]?.items.length ?? 0) === 0 ? (
                <p className="new-appt__hint">
                  No customer matches “{query}”. She may not have an account — switch to{' '}
                  <b>Walk-in</b> and write her name down.
                </p>
              ) : (
                <ul className="new-appt__results" role="listbox" aria-label="Matching customers">
                  {book.data?.pages
                    .flatMap((p) => p.items)
                    .slice(0, 6)
                    .map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={memberId === c.id}
                          className="new-appt__result"
                          disabled={busy}
                          onClick={() => {
                            setMemberId(c.id);
                            setLocalError(null);
                          }}
                        >
                          <span className="new-appt__result-name">{c.name}</span>
                          {/*
                            THE NUMBER IS `null` ON AN ERASED MEMBER AND THE ROW
                            SAYS SO RATHER THAN DRAWING A BLANK — DECISIONS.md
                            #100. The orders board learned this by shipping a
                            `tel:` link to a `+990` tombstone.
                          */}
                          <span className="new-appt__result-sub">
                            {c.memberErased ? 'Account deleted' : (c.memberPhone ?? 'No number')}
                          </span>
                        </button>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="new-appt__grid">
              <TextField
                label="Name"
                placeholder="Walk-in's name"
                value={guestName}
                disabled={busy}
                onChange={(e) => setGuestName(e.target.value)}
              />
              <TextField
                label="Phone (optional)"
                placeholder="+965…"
                value={guestPhone}
                disabled={busy}
                inputMode="tel"
                autoComplete="off"
                onChange={(e) => setGuestPhone(e.target.value)}
              />
            </div>
          )}

          <div className="new-appt__grid">
            {loading ? (
              [0, 1, 2, 3].map((n) => <Skeleton key={n} width="100%" height={44} />)
            ) : (
              <>
                <Select
                  label="Artist"
                  value={artistId}
                  disabled={busy || artistRows.length === 0}
                  options={[
                    {
                      value: '',
                      label: artistRows.length === 0 ? 'No artists yet — add one in Team' : 'Pick an artist',
                    },
                    ...artistRows.map((a) => ({ value: a.id, label: a.name })),
                  ]}
                  onChange={(e) => setArtistId(e.target.value)}
                />
                <Select
                  label="Service"
                  value={serviceId}
                  disabled={busy || serviceRows.length === 0}
                  options={[
                    {
                      value: '',
                      label:
                        serviceRows.length === 0
                          ? 'No services yet — add one in Shop'
                          : 'Pick a service',
                    },
                    ...serviceRows.map((s) => ({ value: s.id, label: s.name })),
                  ]}
                  onChange={(e) => setServiceId(e.target.value)}
                />
                <TextField
                  label="Date"
                  type="date"
                  value={date}
                  disabled={busy}
                  onChange={(e) => setDate(e.target.value)}
                />
                {/*
                  THE ZONE IS NAMED ON THE FIELD. The instant is built in the
                  SALON's zone and the merchant may not be in it — saying which
                  clock she is typing on is the difference between a correct
                  conversion and a correct-looking one.
                */}
                <TextField
                  label={`Time (${timezone})`}
                  type="time"
                  value={time}
                  disabled={busy}
                  onChange={(e) => setTime(e.target.value)}
                />
              </>
            )}
          </div>

          {/*
            THE LOCAL REFUSAL AND THE SERVER'S ARE MUTUALLY EXCLUSIVE, which is
            `Accounts.tsx § NewAccountForm`'s arrangement: two error blocks under
            one button is a merchant reading a stale sentence beside a live one.

            `slot_taken` IS NOT A GENERIC FAILURE AND IS NOT DRAWN AS ONE. The
            exclusion constraint spans hand-written and app bookings on purpose,
            so this is the ordinary answer when a customer took that hour from her
            phone while the front desk was typing — RECOVERABLE, and the way out
            is a different time or a different artist. The server's sentence
            ("That artist already has an appointment then.") states the fact and
            names no remedy; `WriteError` renders it verbatim, and the extra line
            is this screen's, because the remedy differs by control.
          */}
          {localError ? (
            <div className="new-appt__error" role="alert">
              {localError}
            </div>
          ) : isSlotTaken(create.error) ? (
            <div className="new-appt__slot" role="alert">
              <b>That artist already has an appointment then.</b> Pick another time, or another
              artist, and submit again — nothing was written down.
            </div>
          ) : create.isError ? (
            <WriteError error={create.error} reassurance="No appointment was created." />
          ) : null}

          <div className="new-appt__actions">
            <Button disabled={busy} onClick={submit}>
              {busy ? 'Adding…' : 'Add appointment'}
            </Button>
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() => {
                create.reset();
                onClose();
              }}
            >
              Cancel
            </Button>
          </div>

          <p className="new-appt__note">{NO_DEPOSIT_NOTE}</p>
        </>
      )}
    </Card>
  );
}
