import { useState } from 'react';
import type { Branch, DeviceEnrolment, PromotionSet, Salon } from '@avo/types';
import {
  Button,
  Card,
  ErrorState,
  InfoBanner,
  Pill,
  Select,
  Skeleton,
  TextField,
} from '@avo/ui';
import { NEUTRAL_BOOST, summariseBoost, usePromotions } from '../api/promotions.js';
import { useDevices, useEnrolDevice, useRevokeDevice } from '../api/devices.js';
import { useSession } from '../auth/AuthProvider.js';
import { SectionError, WriteError } from './sectionState.js';

/**
 * Merchant → Settings → Tills. Which till stands at which branch.
 *
 * =========================================================================
 * THIS SCREEN IS MONEY CONFIGURATION WEARING THE CLOTHES OF DEVICE MANAGEMENT
 * =========================================================================
 * DECISION 82, and the framing to keep is that decision's own: **adding a second
 * branch was not a configuration task, it was a regression.** Until the device
 * enrolment table landed, `services/branch.ts` returned `established` only when a
 * salon had exactly one open branch — so at a two-branch salon every charge
 * resolved its branch by `ORDER BY id LIMIT 1`, marked the row
 * `branch_assumed = true`, and matched **no boost and no branch-scoped happy
 * hour**. The merchant was still shown her per-branch earning rates on
 * Marketing → Boosts, could still edit them, and they applied to nothing.
 *
 * A till's branch is what makes a charge `established`. So the branch chosen on
 * this panel decides which multiplier a customer is paid at that counter, and
 * that is why every row here carries the branch's earning summary rather than
 * only its name — `api/devices.ts` has the argument. A screen that read as
 * "label your iPads" would be lying about what the control does.
 *
 * =========================================================================
 * WHY IT IS A PANEL IN MERCHANT SETTINGS AND NOT THE OWNER CONSOLE
 * =========================================================================
 * ARGUED, and the console is ruled out by the API rather than by taste. All three
 * endpoints are `requirePerm(req, 'either', 'dashboard')` followed by
 * `requireSameSalon(p, id)`. `requirePerm` goes through `requireStaff`, which
 * throws `forbidden('This endpoint is for salon staff.')` for any principal whose
 * `kind` is not `staff` — and `PlatformAdminPrincipal` is, in `principal.ts`' own
 * words, "THE ONE PRINCIPAL WITH NO SALON". `requireSameSalon` does not even
 * accept one: it takes `MemberPrincipal | StaffPrincipal` so that "an
 * owner-console route calling this would either always throw or, with a nullable
 * field, silently pass."
 *
 * Driven, not inferred — a console session against `GET /salons/{id}/devices`
 * answers 403. So a tills editor in `console/SalonEditor.tsx` could render a
 * picker and never save. It belongs on the surface whose credential the endpoint
 * accepts.
 *
 * AND NOT A NEW NAV SECTION. `shell/navItems.tsx` is the design's ten items, and
 * `NAV_ITEMS`' own comment says the unbuilt ones are in the nav "because the shell
 * design has them" — the list is transcribed from
 * `AVO Merchant Dashboard.dc.html`, not composed here. An eleventh item is a
 * design change, and CLAUDE.md is explicit that the designs are final. Settings
 * is where branches are already opened and closed, and a till's branch is a
 * branch question.
 *
 * =========================================================================
 * IT OWNS ITS OWN READ, ON A DIFFERENT PERMISSION FROM ITS HOST'S
 * =========================================================================
 * This is why it is its own file and its own census entry rather than a function
 * inside `Settings.tsx`. Its host reads `GET /salons/{id}` behind
 * `requirePrincipal` and NO permission; this reads `GET /salons/{id}/devices`
 * behind `perms.dashboard`. Two independent guards means two independent
 * failures, so a `SectionError` here is its own answer and not a drifting copy of
 * its host's — exactly the distinction `stateCensus.test.ts` draws for
 * `console/SupportPanel.tsx` and `console/SalonLoyalty.tsx`.
 *
 * =========================================================================
 * THE STATES, AND WHY TWO OF THEM ARE NOT COSMETIC
 * =========================================================================
 * NO TILLS ENROLLED is the broken state decision 82 describes, not an empty list.
 * A salon with two open branches and no enrolled till has every charge resolving
 * `branch_assumed = true` and earning no boost — so the empty state NAMES that
 * consequence and does not say "no devices yet".
 *
 * A TILL ON A CLOSED BRANCH IS A DEAD COUNTER, and this is the finding that most
 * changed the panel. `routes/devices.ts` refuses to ENROL into a closed branch,
 * reasoning that it "would create a till whose every charge is refused at the
 * branch lookup — a working configuration screen producing a broken counter."
 * That guard covers one entrance. The branch-CLOSURE path does not revoke or
 * re-point enrolments, so the identical state arrives through the other door, and
 * `resolveBranch` throws on it:
 *
 *   enrol DEV-SCANNER-01 → BR-HAW, close BR-HAW, then charge from that till
 *     → 404 unknown_branch, "No such branch."
 *
 * Driven against a lane-C API on the seeded salon. `enrolledBranchId` is read
 * live per request with no `closed_at` check and flows into `resolveBranch` as
 * `supplied`, whose lookup requires `closed_at IS NULL` and otherwise throws. So
 * that till cannot take a payment at all — it is not a rendering quirk, and the
 * panel says so in the strongest terms it has. Reported to lane A: the fix is on
 * the closure path or in `resolveBranch`'s fallback, and neither is this column.
 *
 * `branchName` IS NOT THE DETECTOR FOR IT, which is worth writing down because the
 * schema invites the mistake. `DeviceEnrolmentSchema.branchName` is `.nullable()`
 * because the list is a LEFT JOIN — but that join filters on `branch.id` alone,
 * with no `closed_at` clause, so a till on a closed branch comes back with its
 * name intact ("Salmiya"), verified on the wire. Branches are only ever
 * soft-closed — there is no `.delete(branch)` anywhere in `api/src` — so a null
 * `branchName` is unreachable through the product's own paths. The real detector
 * is absence from `salon.branches`, which `serialiseSalon` builds from open
 * branches only. The null case is still handled, defensively and last.
 *
 * A SINGLE-BRANCH SALON IS A REAL QUESTION AND THE ANSWER IS "YES, BUT SAY SO".
 * With one open branch `resolveBranch` is already `established` — "ONE BRANCH IS
 * NOT A GUESS" — so enrolment changes no earning today. The panel still renders,
 * because the till list is the thing a merchant checks before opening a second
 * branch and because hiding it would make the regression reappear silently the
 * day she does. It says plainly that nothing changes yet.
 */

/** The branch a till stands at, resolved against the salon's OPEN branches. */
type Placement =
  | { kind: 'open'; branch: Branch }
  /** Enrolled, and the branch has since been closed. The counter is dead. */
  | { kind: 'closed'; name: string }
  /**
   * The join found no branch row at all. Unreachable through the product —
   * branches are soft-closed, never deleted — so this is defensive, and it must
   * not claim to know which branch was meant.
   */
  | { kind: 'missing' };

function placementOf(device: DeviceEnrolment, branches: Branch[]): Placement {
  const open = branches.find((b) => b.id === device.branchId);
  if (open) return { kind: 'open', branch: open };
  if (device.branchName !== null) return { kind: 'closed', name: device.branchName };
  return { kind: 'missing' };
}

export interface TillsProps {
  salon: Salon | undefined;
}

export function Tills({ salon }: TillsProps) {
  const session = useSession('merchant');

  /*
   * THE COURTESY GATE IS THIS PANEL'S OWN, AND IT IS A DIFFERENT PERMISSION FROM
   * THE REST OF THE SCREEN.
   *
   * Settings' five other panels write through `PATCH /salons/{id}` and the three
   * branch routes, all `perms.loyalty`. These three endpoints are
   * `perms.dashboard`. The two are orthogonal, so one gate cannot serve both:
   * inheriting `loyalty` would hide the tills from a manager the API would let
   * enrol one, and offering this editor to a `loyalty`-only account would 403 her
   * on the read. `Settings.tsx § THE GATE MOVED FROM THE SCREEN TO THE PANELS`
   * is the change that made that possible.
   *
   * The copy is the API's own sentence for `dashboard`, verbatim from
   * `PERMISSION_COPY`, so a merchant who reaches the refusal by another route
   * reads the same words. Non-negotiable #7 unchanged: the server refuses all
   * three with this check deleted.
   */
  if (!session.perms.dashboard) {
    return (
      <Card className="settings__card">
        <h2 className="settings__title avo-display">Tills</h2>
        <ErrorState
          title="You don't have access to tills"
          body="You don't have permission to see the dashboard. A manager can grant it."
        />
      </Card>
    );
  }

  return <TillsPanel salon={salon} />;
}

function TillsPanel({ salon }: { salon: Salon | undefined }) {
  const devices = useDevices();
  /*
   * The boosts, so a till's row can say what a charge through it EARNS.
   *
   * `GET /v1/salons/{id}/promotions` is `requirePrincipal` with no permission
   * (`sectionState.tsx`'s ledger), so anyone who can read this panel can read
   * these — no second gate, and no `enabled` on a permission. A failure here is
   * NOT this panel's error state: the till list is still completely renderable
   * without it, and the earning line degrades to silence rather than taking the
   * screen down. `BranchesPanel` reasons the same way about the roster it may not
   * be allowed to read.
   */
  const promotions = usePromotions();

  const enrol = useEnrolDevice();
  const revoke = useRevokeDevice();

  const [confirming, setConfirming] = useState<DeviceEnrolment | null>(null);
  const [revoking, setRevoking] = useState<DeviceEnrolment | null>(null);

  const branches = salon?.branches ?? [];
  const multiBranch = branches.length > 1;

  if (devices.isError) {
    return (
      <Card className="settings__card">
        <h2 className="settings__title avo-display">Tills</h2>
        <SectionError
          error={devices.error}
          forbiddenTitle="You don't have access to tills"
          failedTitle="Couldn't load your tills"
          onRetry={() => void devices.refetch()}
          retrying={devices.isFetching}
        />
      </Card>
    );
  }

  const items = devices.data;

  return (
    <Card className="settings__card">
      <h2 className="settings__title avo-display">Tills</h2>
      <p className="settings__sub">
        Which branch each till stands at. This decides what a customer earns when she pays
        there.
      </p>

      {/*
        THE STANDING EXPLANATION, and it differs by salon shape because the truth
        does. At a multi-branch salon an unenrolled till earns nothing extra; at a
        single-branch salon enrolment changes no earning at all, because
        `resolveBranch` is already established. Saying the second thing on a
        two-branch salon would be false, and saying the first on a one-branch salon
        would be alarming and false.
      */}
      {salon === undefined ? null : multiBranch ? (
        <InfoBanner>
          A charge only earns a branch&rsquo;s boost when the server knows which branch it
          happened at. It knows from the till. A till that isn&rsquo;t set up here earns the
          base rate wherever it stands.
        </InfoBanner>
      ) : (
        <InfoBanner>
          {branches.length === 1 ? (
            <>
              With one open branch, every charge is already attributed to{' '}
              <b>{branches[0]!.name}</b> and earns its rate — setting a till up here
              changes nothing today. It starts to matter the moment you open a second
              branch.
            </>
          ) : (
            <>This salon has no open branch, so there is nothing to point a till at.</>
          )}
        </InfoBanner>
      )}

      {items === undefined ? (
        /* Pending. Two rows' worth, where the rows will be. */
        <ul className="tills__list">
          {[0, 1].map((i) => (
            <li key={i} className="tills__row">
              <div className="tills__rowmain">
                <Skeleton width="45%" height={15} />
                <Skeleton width="70%" height={13} />
              </div>
              <Skeleton width={72} height={24} radius={999} />
            </li>
          ))}
        </ul>
      ) : items.length === 0 ? (
        /*
          THE BROKEN STATE, NAMED. Not "no devices yet" — decision 82's whole
          point is that this configuration gap is a money defect, and at a
          multi-branch salon it is live right now. An EmptyState with a cheerful
          "add your first till" would be the screen telling her nothing is wrong.
        */
        <div className="tills__empty" role="status">
          <div className="tills__emptytitle">No till is set up</div>
          {multiBranch ? (
            <p className="tills__emptybody">
              <b>
                Every charge at this salon is being attributed to a branch the server had to
                guess, and none of them earns a branch boost.
              </b>{' '}
              You have {branches.length} open branches, so the server cannot tell where a
              payment happened until you say which till stands where. Set one up below —
              the device ID is on the scanner&rsquo;s sign-in screen.
            </p>
          ) : (
            <p className="tills__emptybody">
              Nothing is wrong today: with one open branch every charge is already
              attributed correctly. Set your tills up here before you open a second branch,
              or charges there will stop earning their branch&rsquo;s rate.
            </p>
          )}
        </div>
      ) : (
        <ul className="tills__list">
          {items.map((device) => {
            const placement = placementOf(device, branches);
            const boost =
              placement.kind === 'open' && promotions.data
                ? { ...NEUTRAL_BOOST, ...(promotions.data.boosts[device.branchId] ?? {}) }
                : null;
            const boosted =
              boost !== null &&
              (boost.visit > NEUTRAL_BOOST.visit ||
                boost.topup > NEUTRAL_BOOST.topup ||
                boost.stamp > NEUTRAL_BOOST.stamp);

            return (
              <li
                key={device.deviceId}
                className={`tills__row${placement.kind === 'open' ? '' : ' tills__row--broken'}`}
              >
                <div className="tills__rowmain">
                  <div className="tills__rowhead">
                    <span className="tills__label">{device.label}</span>
                    <span className="tills__id">{device.deviceId}</span>
                    {placement.kind === 'open' ? (
                      <Pill tone={boosted ? 'brand' : 'quiet'}>
                        {boosted ? 'Boosted' : 'Base rate'}
                      </Pill>
                    ) : (
                      <Pill tone="warn">Cannot charge</Pill>
                    )}
                  </div>

                  {placement.kind === 'open' ? (
                    <>
                      <div className="tills__branch">
                        Stands at <b>{placement.branch.name}</b>{' '}
                        <span className="tills__branchid">{placement.branch.id}</span>
                      </div>
                      {/*
                        THE EARNING CONSEQUENCE, in the sentence the merchant
                        already read on Marketing → Boosts when she set the rate.
                        Shared from `api/promotions.ts` rather than restated — see
                        `summariseBoost`.

                        Withheld while the boosts are still in flight rather than
                        defaulted to neutral: "earns the salon's base rate" is a
                        claim about money, and rendering it from an absent fetch
                        is the premature-zero class this build keeps catching.
                      */}
                      {boost !== null ? (
                        <p className="tills__earning">
                          {summariseBoost('this till', boost)}
                        </p>
                      ) : promotions.isError ? (
                        <p className="tills__earning tills__earning--unknown">
                          Couldn&rsquo;t load this branch&rsquo;s earning rates, so what a
                          charge here earns isn&rsquo;t shown. The rates themselves are
                          unaffected.
                        </p>
                      ) : (
                        <Skeleton width="60%" height={13} />
                      )}
                    </>
                  ) : placement.kind === 'closed' ? (
                    /*
                      A DEAD COUNTER, and the copy does not soften it. Proven on a
                      lane-C API: `resolveBranch` refuses a closed branch supplied
                      by an enrolment, so every charge from this till answers 404
                      `unknown_branch`. The remedy is in this panel — re-point it —
                      so the sentence names it.
                    */
                    <>
                      <div className="tills__branch">
                        Stands at <b>{placement.name}</b>, which is closed.
                      </div>
                      <p className="tills__earning tills__earning--broken">
                        <b>This till cannot take a payment.</b> Every charge through it is
                        refused because the branch it points at is closed. Point it at an
                        open branch to bring it back.
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="tills__branch">
                        Stands at branch{' '}
                        <span className="tills__branchid">{device.branchId}</span>, which
                        this salon no longer lists.
                      </div>
                      <p className="tills__earning tills__earning--broken">
                        <b>This till cannot take a payment.</b> Point it at an open branch
                        to bring it back.
                      </p>
                    </>
                  )}
                </div>

                <div className="tills__rowactions">
                  <Button
                    variant="quiet"
                    disabled={enrol.isPending || revoke.isPending}
                    onClick={() => {
                      setRevoking(null);
                      setConfirming(device);
                    }}
                  >
                    Move
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={enrol.isPending || revoke.isPending}
                    onClick={() => {
                      setConfirming(null);
                      setRevoking(device);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {confirming !== null ? (
        <MovePanel
          device={confirming}
          branches={branches}
          promotions={promotions.data}
          busy={enrol.isPending}
          onCancel={() => setConfirming(null)}
          onConfirm={(branchId) =>
            enrol.mutate(
              { deviceId: confirming.deviceId, branchId, label: confirming.label },
              { onSuccess: () => setConfirming(null) },
            )
          }
        />
      ) : null}

      {revoking !== null ? (
        <RemovePanel
          device={revoking}
          multiBranch={multiBranch}
          busy={revoke.isPending}
          onCancel={() => setRevoking(null)}
          onConfirm={() =>
            revoke.mutate(
              { deviceId: revoking.deviceId },
              { onSuccess: () => setRevoking(null) },
            )
          }
        />
      ) : null}

      {/*
        Adding a till is only offered where it can succeed. `POST` refuses a
        closed branch with a 404, and the picker only ever offers open ones — the
        ✕ pattern from Accounts, one card over: "a control that cannot succeed
        says why BEFORE it is pressed."
      */}
      {salon !== undefined && branches.length > 0 ? (
        <AddTill branches={branches} promotions={promotions.data} enrol={enrol} />
      ) : null}

      {/*
        A FAILED WRITE LEAVES THE PREVIOUS ASSIGNMENT INTACT, AND SAYS SO. That is
        only a true sentence because nothing here writes optimistically and
        nothing calls `setQueryData` — see `api/devices.ts`. The till on screen is
        the till the server holds.
      */}
      {enrol.isError ? (
        <WriteError error={enrol.error} reassurance="That till is still where it was." />
      ) : null}
      {revoke.isError ? (
        <WriteError error={revoke.error} reassurance="That till is unchanged." />
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------- move -- */

/**
 * Re-point a till, with the earning change stated before it is made.
 *
 * WHY THIS CONFIRMS AT ALL — the call was open, and it is a yes.
 *
 * The API makes a re-point cheap and reversible: it is one transaction, it moves
 * no money, and re-pointing back restores the old branch exactly. So a
 * confirmation cannot be justified as protection against an irreversible act,
 * which is what the branch-closure confirmation next door is for.
 *
 * It is justified by the merchant not being able to SEE the consequence
 * otherwise. Moving a till from Salmiya to Kuwait City changes what every
 * customer at that counter earns from her next visit onward, and the two branches
 * may differ by `2×` visits and `+10%` on top-ups. A picker that applied on
 * change would make a money change at the speed of a mis-click and show its
 * effect only afterwards, in a row she would have to re-read to notice. The
 * confirmation exists to render the before and the after side by side, which is
 * the one thing the list cannot do.
 *
 * It deliberately does NOT warn about a no-op. Re-posting the same branch returns
 * 200 and writes nothing, so selecting the branch the till already stands at is
 * harmless — and manufacturing a "no change" state for it would be this UI
 * inventing a state the salon is not in (`api/devices.ts § SO THIS HOOK DOES NOT
 * REPORT "CHANGED"`). The Move button is simply disabled on the current branch.
 */
function MovePanel({
  device,
  branches,
  promotions,
  busy,
  onCancel,
  onConfirm,
}: {
  device: DeviceEnrolment;
  branches: Branch[];
  promotions: PromotionSet | undefined;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (branchId: string) => void;
}) {
  /*
   * DOES THE TILL STAND AT A BRANCH THAT IS STILL OPEN? Everything below turns on
   * it, and getting it wrong made this panel refuse to perform the one repair it
   * exists for.
   *
   * THE DEFECT, KEPT BECAUSE THE MECHANISM WILL RECUR. `target` initialised to
   * `device.branchId` unconditionally, and `branches` holds OPEN branches only —
   * so for a till on a closed branch the initial state named an id that was not
   * among the options. The DOM `<select>` has nowhere to put such a value and
   * coerces its own display to the first option, while React state kept the
   * closed id. `unchanged` then compared the state to `device.branchId`, found
   * them equal, and DISABLED the Move button under a select that was visibly
   * showing a different branch.
   *
   * The result was the worst version of this bug: the row said "This till cannot
   * take a payment… Point it at an open branch to bring it back", and the control
   * for doing that was greyed out with "That is where it stands now." Found by
   * driving the closed-branch state in a browser, not by typechecking — the types
   * are identical either way, which is this build's oldest lesson wearing a
   * `useState` costume.
   *
   * So the question is asked once, here, and both the initial value and
   * `unchanged` are derived from it. Moving a till OFF a closed branch is always a
   * real change, so `unchanged` cannot be true in that case whatever is selected.
   */
  const standsOpen = branches.some((b) => b.id === device.branchId);

  const [target, setTarget] = useState<string>(
    standsOpen ? device.branchId : (branches[0]?.id ?? ''),
  );
  const chosen = branches.find((b) => b.id === target);
  const unchanged = standsOpen && target === device.branchId;

  const boostFor = (branchId: string) =>
    promotions ? { ...NEUTRAL_BOOST, ...(promotions.boosts[branchId] ?? {}) } : null;

  const from = boostFor(device.branchId);
  const to = chosen ? boostFor(chosen.id) : null;
  /*
   * Compared on the VALUES, not on the branch id. Two branches may carry
   * identical boost rows, and "moving it changes nothing about earning" is then
   * the true thing to say — a warning keyed on the id alone would cry wolf.
   *
   * ONLY MEANINGFUL WHILE THE TILL'S CURRENT BRANCH IS OPEN. A closed branch's
   * boost row may still exist and describes nothing: every charge on that till is
   * refused, so it earns neither that rate nor the base rate. Comparing the two
   * would put a number against a state that takes no money.
   */
  const earningChanges =
    standsOpen &&
    from !== null &&
    to !== null &&
    (from.visit !== to.visit || from.topup !== to.topup || from.stamp !== to.stamp);

  return (
    <div className="settings__confirm" role="group" aria-label={`Move ${device.label}`}>
      <p className="settings__confirm-text">
        Move <b>{device.label}</b> to another branch. Charges taken on it from then on are
        attributed there and earn that branch&rsquo;s rate.
      </p>

      <Select
        label="Branch"
        value={target}
        onChange={(event) => setTarget(event.target.value)}
        disabled={busy}
        options={branches.map((b) => ({
          value: b.id,
          label: b.id === device.branchId ? `${b.name} — where it stands now` : b.name,
        }))}
      />

      {/*
        THE BEFORE AND THE AFTER. The whole reason this confirmation exists; a
        merchant should not have to hold two boost rows in her head to see what
        she is about to change about her own margin.
      */}
      {promotions === undefined ? (
        <Skeleton width="80%" height={13} />
      ) : (
        <ul className="settings__consequences">
          {unchanged ? (
            <li>
              That is where it stands now. Pick a different branch, or keep it where it is.
            </li>
          ) : (
            <>
              <li>
                <b>Now:</b>{' '}
                {standsOpen ? (
                  summariseBoost(device.branchName ?? device.branchId, from ?? NEUTRAL_BOOST)
                ) : (
                  /*
                    A closed branch earns nothing, because it takes nothing. Quoting
                    its boost row here would be a number about a till that refuses
                    every charge.
                  */
                  <>
                    Every charge on this till is refused, because{' '}
                    {device.branchName ?? device.branchId} is closed.
                  </>
                )}
              </li>
              <li>
                <b>After the move:</b>{' '}
                {chosen ? summariseBoost(chosen.name, to ?? NEUTRAL_BOOST) : ''}
              </li>
              {!standsOpen ? (
                <li className="settings__consequence--warn">
                  <b>This brings the till back into service.</b> It can take payments again
                  from the next charge.
                </li>
              ) : earningChanges ? (
                <li className="settings__consequence--warn">
                  <b>This changes what your customers earn at that till.</b> It applies to
                  the next charge, never to charges already taken.
                </li>
              ) : (
                <li>
                  Both branches earn at the same rate, so this changes attribution and not
                  earning.
                </li>
              )}
            </>
          )}
        </ul>
      )}

      <div className="settings__confirm-actions">
        <Button
          variant="secondary"
          disabled={busy || unchanged || chosen === undefined}
          onClick={() => onConfirm(target)}
        >
          {busy ? 'Moving…' : chosen ? `Move to ${chosen.name}` : 'Move'}
        </Button>
        <Button variant="quiet" disabled={busy} onClick={onCancel}>
          Keep it where it is
        </Button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- remove -- */

/**
 * Revoke an enrolment, with what it costs stated first.
 *
 * The important half is that this does NOT break the counter — `routes/devices.ts`
 * says so deliberately: "the charge still succeeds… Revoking degrades attribution;
 * it never refuses money at the counter." What it costs is the boost, and only at
 * a multi-branch salon. Both halves are said, because "this till stops earning
 * its branch rate" is alarming and true at two branches and simply false at one.
 */
function RemovePanel({
  device,
  multiBranch,
  busy,
  onCancel,
  onConfirm,
}: {
  device: DeviceEnrolment;
  multiBranch: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="settings__confirm" role="group" aria-label={`Remove ${device.label}`}>
      <p className="settings__confirm-text">
        Remove <b>{device.label}</b>? It keeps working and keeps taking payments — it just
        stops telling the server which branch it stands at.
      </p>
      <ul className="settings__consequences">
        {multiBranch ? (
          <li className="settings__consequence--warn">
            <b>Charges on it stop earning any branch boost</b> and are attributed to a
            branch the server has to guess. Past charges keep the branch they were taken
            at.
          </li>
        ) : (
          <li>
            With one open branch, charges on it are still attributed correctly and still
            earn that branch&rsquo;s rate — so this changes nothing until you open a second
            branch.
          </li>
        )}
      </ul>
      <div className="settings__confirm-actions">
        <Button variant="secondary" disabled={busy} onClick={onConfirm}>
          {busy ? 'Removing…' : 'Remove it'}
        </Button>
        <Button variant="quiet" disabled={busy} onClick={onCancel}>
          Keep it
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- add -- */

/**
 * Set a till up.
 *
 * THE DEVICE ID IS TYPED, NOT DISCOVERED, and that is the API's shape rather than
 * a shortcut. `POST` "takes a `deviceId` and a `branchId` together — from a
 * caller holding `perms.dashboard`, once, as an act of configuration" — there is
 * no endpoint listing devices the salon has seen, and `pin_attempt` is not one.
 * So the merchant reads the id off the scanner and types it, which is also why
 * the scanner has its own "Set up this device" flow (lane B's, on the same
 * endpoints) where the id needs no typing at all.
 *
 * RE-POSTING AN EXISTING DEVICE ID IS A RE-POINT, not an error, and the form does
 * not pretend to be able to tell: the server holds the live row and answers 200
 * or 201 accordingly. What the form must not do is claim a till was ADDED when it
 * was moved, so the button says "Set up till" and the list is the confirmation.
 */
function AddTill({
  branches,
  promotions,
  enrol,
}: {
  branches: Branch[];
  promotions: PromotionSet | undefined;
  enrol: ReturnType<typeof useEnrolDevice>;
}) {
  const [deviceId, setDeviceId] = useState('');
  const [label, setLabel] = useState('');
  const [branchId, setBranchId] = useState(branches[0]?.id ?? '');

  const chosen = branches.find((b) => b.id === branchId);
  const boost = promotions
    ? { ...NEUTRAL_BOOST, ...(promotions.boosts[branchId] ?? {}) }
    : null;

  /*
   * Trimmed here as well as server-side. `blank_field` is a real 400 for a
   * whitespace-only value, and a control that cannot succeed should not be
   * pressable — the same reason the branch ✕ is disabled on the last open branch.
   */
  const ready = deviceId.trim() !== '' && label.trim() !== '' && chosen !== undefined;

  return (
    <div className="tills__add">
      <div className="tills__addtitle">Set up a till</div>
      <div className="tills__addgrid">
        <TextField
          label="Device ID"
          placeholder="DEV-SCANNER-01"
          value={deviceId}
          disabled={enrol.isPending}
          onChange={(event) => setDeviceId(event.target.value)}
        />
        <TextField
          label="What to call it"
          placeholder="Front desk iPad"
          value={label}
          disabled={enrol.isPending}
          onChange={(event) => setLabel(event.target.value)}
        />
        <Select
          label="Branch"
          value={branchId}
          disabled={enrol.isPending}
          onChange={(event) => setBranchId(event.target.value)}
          options={branches.map((b) => ({ value: b.id, label: b.name }))}
        />
      </div>

      {/*
        What a charge on it will earn, before it is set up. Same sentence, same
        source — the point of this panel is that the branch is an earning choice,
        and that has to be visible at the moment the choice is made.
      */}
      {chosen && boost !== null ? (
        <p className="tills__earning">{summariseBoost(chosen.name, boost)}</p>
      ) : null}

      <div className="tills__addactions">
        <Button
          disabled={!ready || enrol.isPending}
          onClick={() =>
            enrol.mutate(
              { deviceId: deviceId.trim(), branchId, label: label.trim() },
              {
                onSuccess: () => {
                  setDeviceId('');
                  setLabel('');
                },
              },
            )
          }
        >
          {enrol.isPending ? 'Setting up…' : 'Set up till'}
        </Button>
        <span className="tills__addnote">
          The device ID is on the scanner&rsquo;s sign-in screen.
        </span>
      </div>
    </div>
  );
}
