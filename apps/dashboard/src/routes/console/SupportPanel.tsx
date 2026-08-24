import type { ReactNode } from 'react';
import type { SupportTopic } from '@avo/types';
import { Card, Pill, Skeleton } from '@avo/ui';
import { useSupportConfig } from '../../api/platform.js';
import { SectionError } from '../sectionState.js';

/**
 * Policies → Support & contact.
 *
 * NON-NEGOTIABLE #11's configuration surface, and the console's alone:
 *
 *   "Support ticket routing is resolved server-side from `topicId`. A
 *    client-supplied route can land a wallet dispute in a salon's inbox."
 *
 * AVO owns this and a merchant never sees it — `design/README.md`: "a salon
 * cannot redirect customers to an unmonitored number." The same logic covers the
 * routing column: a salon that could edit `supportTopic.route` would be able to
 * route "a charge I do not recognise" to itself, and answer the disputes it is
 * the subject of. So this panel lives in the owner console and nowhere else, and
 * the merchant dashboard has no equivalent to build later.
 *
 * ---------------------------------------------------------------------------
 * THE READ HALF ONLY, AND THE MISSING HALF IS NOT DRAWN.
 *
 * The design draws this as a live editor: four text inputs, an inline Salon/AVO
 * segmented control per topic, up/down reorder arrows, a delete cross, an "+ Add
 * topic" field, and a message inbox beneath. Every one of those needs an endpoint
 * that does not exist. api-contract.md §§ 555-559 and 582-586 declare EIGHT
 * support endpoints. Two are registered. The missing SIX:
 *
 *   PATCH  /v1/platform/support/channels          the four channel fields
 *   POST   /v1/platform/support/topics            + Add topic
 *   PATCH  /v1/platform/support/topics/{id}       the label, the route, AND
 *                                                 `order` — so the reorder
 *                                                 arrows ride on this one too
 *   DELETE /v1/platform/support/topics/{id}       the delete cross
 *   GET    /v1/support/tickets?route=&status=     the inbox
 *   PATCH  /v1/support/tickets/{id}               mark answered
 *
 * SIX, AND IT WAS WRITTEN HERE AS FIVE. The `DELETE` is missing from every prose
 * list of this gap — including the one that corrected the original brief — for a
 * mechanical reason: the contract writes it `DELETE/v1/…` with no space after the
 * verb, so it does not match how a reader scans the block, and four successive
 * readings skipped it.
 *
 * COMPUTED, NOT READ. Both lists were extracted and differenced rather than
 * eyeballed — the contract's declarations against the `app.<verb>('/v1/…support…'`
 * registrations in api/src. The only two registered anywhere are
 * `GET /v1/platform/support` (platform.ts:670) and `POST /v1/support/tickets`
 * (platform.ts:726), and the second is the wallet's form. api-contract.md is a
 * specification, not an inventory: it says what should exist and the routes say
 * what does.
 *
 * So no editors, no reorder arrows, no add or delete, and no ticket queue. The
 * precedent is the Manage button deliberately left off the Salons list: a control
 * that can only 403 — or here, only 404 — is worse than an absent one, because it
 * teaches the admin the console is broken rather than unfinished.
 *
 * THE ROUTING COLUMN IS STILL WORTH RENDERING, and that is not a consolation
 * prize. `supportTopic.route` is the table #11's server-side resolution reads.
 * "Which of these questions reach AVO and which reach the salon" is a real
 * question an admin has about a live deployment, and it is answerable today. It
 * is shown as a `Pill` — a static status pill, not focusable, not a button —
 * rather than as a disabled `Chip`, because a greyed-out segmented control reads
 * as a permission problem or a bug. This reads as state, which is what it is.
 *
 * NO PUBLISH BUTTON, AND THAT ASYMMETRY WITH THE PANEL ABOVE IS THE POINT.
 * Policies has draft / publish / version-stamping because a legal set IS a legal
 * representation and #10 turns on the version a member accepted. Support config is
 * not one — api-contract.md: "unlike legal documents there is no draft/publish
 * step, because nothing here is a legal representation" — so when the editors
 * land they save immediately. Giving this panel a Publish for visual symmetry
 * would be a claim about legal status that is false.
 *
 * ---------------------------------------------------------------------------
 * COPY. The design's heading and field labels are verbatim. Its subtitle is not,
 * and the divergence is deliberate rather than sloppy:
 *
 *   drawn:  "What the wallet's Contact us form offers. Saves as you type — no
 *            publish step."
 *
 * Nothing here saves as you type, because nothing here is a field. Rendering that
 * sentence would describe a behaviour the panel does not have. The first sentence
 * is kept exactly; the second is replaced by what is true now, and it keeps the
 * "no publish step" fact — which is load-bearing next to the policy panel — as a
 * promise about the editors rather than a description of this screen.
 *
 * The design's topic note is cut for the same reason. Drawn:
 *
 *   "Routing decides whose queue a message lands in. Switch to العربية above to
 *    write the Arabic labels."
 *
 * The first sentence is the one that explains the column and is kept verbatim.
 * The second points at a language toggle this screen does not have, for the
 * purpose of writing labels that cannot be written. It is dropped rather than
 * paraphrased.
 *
 * BOTH LANGUAGES AT ONCE, WHICH THE DESIGN COULD NOT DO. The prototype shows one
 * language at a time because its fields are editable and an input holds one
 * value. A read-only panel has no such constraint, and `GET /v1/platform/support`
 * returns `hoursEn`/`hoursAr`, `replyEn`/`replyAr` and `en`/`ar` per topic in one
 * response. Non-negotiable #12 makes Arabic a first-class layout rather than a
 * second pass, and a missing Arabic label is a customer seeing nothing for that
 * topic — a fact worth putting in front of an admin, not behind a toggle.
 */
export function SupportPanel() {
  const support = useSupportConfig();

  return (
    <Card className="support">
      <div className="support__head">
        <h2 className="support__h2 avo-display">Support &amp; contact</h2>
        <span className="support__note">
          What the wallet&apos;s Contact us form offers. Read-only for now — the editors have no
          endpoint yet. When they land they will save as you type, with no publish step.
        </span>
      </div>

      {support.isError ? (
        /*
         * `support_not_configured` is a REAL ANSWER, not a failure to hide: the
         * deployment has no `support_config` row, so the wallet's Contact us
         * screen has no number, no address and no hours. The server says exactly
         * that ("Support channels have not been configured yet.") and
         * `namedStateAnswer` in sectionState.tsx is what stops the sentence being
         * replaced — the API serves it as a 503, `ApiError.isConnectivity` counts
         * 503 as offline, and without that check this panel told an admin her
         * network was down about a server that had just answered her.
         */
        <SectionError
          error={support.error}
          forbiddenTitle="You don't have access to support settings"
          failedTitle="Couldn't load the support settings"
          stateTitle="Support isn't configured"
          onRetry={() => void support.refetch()}
          retrying={support.isFetching}
        />
      ) : (
        <div className="support__grid">
          <div className="support__channels">
            {support.isPending ? (
              /*
               * Four blocks because four channels arrive together from one row —
               * a skeleton per label, in the loaded layout's place. No values and
               * no labels: a label with nothing under it announces a field the
               * panel is not painting.
               */
              <>
                <Skeleton width="70%" height={13} />
                <Skeleton width="55%" height={13} />
                <Skeleton width="80%" height={13} />
                <Skeleton width="65%" height={13} />
              </>
            ) : (
              <>
                {/*
                  E.164, and `dir="ltr"` deliberately. `supportConfig.whatsapp`
                  carries the schema note "shown LTR in both languages" — a
                  leading `+` in an RTL run gets reordered to the wrong end by the
                  bidi algorithm, so an Arabic console would print "965 9008 4408+".
                */}
                <Channel label="WhatsApp number">
                  <span dir="ltr">{support.data.channels.whatsapp}</span>
                </Channel>
                <Channel label="Support email">
                  <span dir="ltr">{support.data.channels.email}</span>
                </Channel>
                <Channel label="Hours shown in the wallet">
                  <Bilingual en={support.data.channels.hoursEn} ar={support.data.channels.hoursAr} />
                </Channel>
                <Channel label="Reply-time promise">
                  <Bilingual en={support.data.channels.replyEn} ar={support.data.channels.replyAr} />
                </Channel>
              </>
            )}
          </div>

          <div className="support__topics">
            <div className="support__topichead">
              {/*
                THE COUNT IS WITHHELD WHILE PENDING. `topics.length` on an
                undefined list needs a `?? 0`, and "Topics · 0" beside a column of
                skeletons announces an empty configuration the panel is not
                painting — the sr-only-caption defect from both audit screens,
                arriving here through a visible heading instead. The word alone
                until the number is real.
              */}
              <span className="avo-label">
                {support.isPending ? 'Topics' : `Topics · ${support.data.topics.length}`}
              </span>
              <span className="support__note">Routing decides whose queue a message lands in.</span>
            </div>

            {support.isPending ? (
              <div className="support__topiclist">
                <Skeleton height={38} />
                <Skeleton height={38} />
                <Skeleton height={38} />
              </div>
            ) : support.data.topics.length === 0 ? (
              /*
               * NAMES WHAT IS MISSING AND WHAT IT COSTS, per interaction-spec §4 —
               * an empty state that says "no topics" tells an admin nothing about
               * why it matters. A deployment with no active topic has a Contact us
               * form with nothing to pick, and `POST /v1/support/tickets` refuses
               * every message with `unknown_topic`, so the customer cannot write
               * in at all.
               *
               * Reachable in exactly this shape, and not only in theory: the
               * endpoint filters `active = true`, so a table full of deactivated
               * topics arrives here as an empty list rather than as an error.
               */
              <p className="support__empty">
                No active topics. The wallet&apos;s Contact us form has nothing to choose from, and
                every message sent to it is refused.
              </p>
            ) : (
              <ul className="support__topiclist">
                {support.data.topics.map((topic) => (
                  <TopicRow key={topic.id} topic={topic} />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function Channel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="support__channel">
      <span className="avo-label">{label}</span>
      <span className="support__value">{children}</span>
    </div>
  );
}

/**
 * One value in both languages, with the Arabic gap named rather than left blank.
 *
 * An empty Arabic string is not a rendering edge case here — it is what a
 * customer with the wallet in Arabic sees, which is nothing. The Policies panel
 * above already calls out a document with no Arabic rather than listing it, and
 * this is the same judgement applied to a channel.
 */
function Bilingual({ en, ar }: { en: string; ar: string }) {
  return (
    <>
      <span className="support__lang">{en}</span>
      {ar.length === 0 ? (
        <span className="support__missing">No Arabic — the wallet shows nothing here</span>
      ) : (
        <span className="support__lang" lang="ar" dir="rtl">
          {ar}
        </span>
      )}
    </>
  );
}

/**
 * A topic, its two labels, and the queue it resolves to.
 *
 * `Pill` and not `Chip`. `Chip` is the interactive one — `<button role="switch">`
 * with `aria-checked` — and rendering the route as a disabled Chip would put a
 * dead switch in the accessibility tree announcing a control nobody can operate.
 * `Pill` is a `<span>`: not focusable, not announced as actionable, and its tone
 * is decoration over a label that already carries the meaning as text
 * (interaction-spec.md §2).
 *
 * `brand` for AVO and `neutral` for the salon, and the tone choice is checked
 * against non-negotiable #9 rather than eyeballed: `Pill`'s `brand` tone is
 * `--avo-brand-tint` behind `--avo-brand-deep` text. Not `--avo-brand`, which is
 * a surface colour and cannot carry text.
 */
function TopicRow({ topic }: { topic: SupportTopic }) {
  return (
    <li className="support__topic">
      <span className="support__topiclabels">
        <span className="support__topicen">{topic.en}</span>
        {topic.ar.length === 0 ? (
          <span className="support__missing">No Arabic label</span>
        ) : (
          <span className="support__topicar" lang="ar" dir="rtl">
            {topic.ar}
          </span>
        )}
      </span>
      {/*
        The label is the design's own — "Salon" and "AVO", the two segments it
        draws — so the pill reads as the same vocabulary the editor will use.
      */}
      <Pill tone={topic.route === 'avo' ? 'brand' : 'neutral'}>
        {topic.route === 'avo' ? 'AVO' : 'Salon'}
      </Pill>
    </li>
  );
}
