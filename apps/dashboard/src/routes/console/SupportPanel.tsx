import { useEffect, useState } from 'react';
import { Button, Card, Segmented, Skeleton, TextField } from '@avo/ui';
import {
  useAddTopic,
  useRetireTopic,
  useSupportConfig,
  useUpdateChannels,
  useUpdateTopic,
  type SupportTopic,
} from '../../api/support.js';
import { SectionError, WriteError } from '../sectionState.js';
import { SupportQueue } from './SupportQueue.js';

/**
 * Policies → Support & contact.
 *
 * NON-NEGOTIABLE #11's configuration surface, and the console's alone:
 *
 *   "Support ticket routing is resolved server-side from `topicId`. A
 *    client-supplied route can land a wallet dispute in a salon's inbox."
 *
 * `supportTopic.route` is the table that resolution reads, so the Salon/AVO
 * control below is not a display preference — it is the routing table for every
 * wallet dispute. AVO owns it and a merchant never sees it, because
 * `design/README.md` is explicit that "a salon cannot redirect customers to an
 * unmonitored number", and the same logic covers routing: a salon that could edit
 * this would route "a charge I do not recognise" to itself and answer the disputes
 * it is the subject of.
 *
 * ---------------------------------------------------------------------------
 * THE EDITORS ARE LIVE NOW. The read-only version of this panel existed because
 * five of the writes had no endpoint; all six exist, verified by grepping the
 * registrations in `api/src/routes/support.ts` rather than reading
 * api-contract.md, which is the habit this family's four miscounts earned.
 *
 * SAVE ON COMMIT, AND NO PUBLISH BUTTON. api-contract.md: support config saves
 * immediately, "unlike legal documents there is no draft/publish step, because
 * nothing here is a legal representation." The policy panel directly above has
 * draft / publish / version-stamping precisely because it IS one, and #10 turns on
 * the version a member accepted. The asymmetry is deliberate; a Publish here for
 * visual symmetry would be a false claim about legal status.
 *
 * TEXT COMMITS ON BLUR, NOT PER KEYSTROKE, and the design's own implementation
 * note says why: writing on every keystroke pushes a new value back in from
 * outside the React event and throws the caret to the end of the field mid-word.
 * `EditableText` below holds the draft locally and commits the difference.
 *
 * BOTH LANGUAGES AT ONCE. The prototype shows one at a time behind a toggle
 * because each of its inputs holds one value; there are six channel fields and two
 * per topic, and the endpoint returns them together. #12 makes Arabic a
 * first-class layout rather than a second pass, and an untranslated topic is a
 * customer seeing nothing for it — a fact that belongs on screen, not behind a
 * language switch.
 */
export function SupportPanel() {
  const support = useSupportConfig();
  const updateChannels = useUpdateChannels();
  const addTopic = useAddTopic();
  const updateTopic = useUpdateTopic();
  const retireTopic = useRetireTopic();

  const [newTopic, setNewTopic] = useState('');

  return (
    <Card className="support">
      <div className="support__head">
        <h2 className="support__h2 avo-display">Support &amp; contact</h2>
        <span className="support__note">
          What the wallet&apos;s Contact us form offers. Saves as you type — no publish step.
        </span>
      </div>

      {support.isError ? (
        /*
         * `support_not_configured` is a REAL ANSWER, not a failure to hide: the
         * deployment has no `support_config` row, so the wallet's Contact us screen
         * has no number, no address and no hours. The server says exactly that and
         * `namedStateAnswer` in sectionState.tsx is what stops the sentence being
         * replaced — it used to arrive as a 503, which is in
         * `ApiError.isConnectivity`, so this panel told an admin her network was
         * down about a server that had just answered. Lane A has since swept every
         * configuration state to 409; keying the client on shape rather than on a
         * status list is why that sweep needed no change here.
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
        <>
          <div className="support__grid">
            <div className="support__channels">
              {support.isPending ? (
                /*
                 * Six blocks because six channel fields arrive together from one
                 * row, in the loaded layout's place. No labels: a label with
                 * nothing under it announces a field the panel is not painting.
                 */
                <>
                  <Skeleton width="70%" height={13} />
                  <Skeleton width="55%" height={13} />
                  <Skeleton width="80%" height={13} />
                  <Skeleton width="65%" height={13} />
                  <Skeleton width="75%" height={13} />
                  <Skeleton width="60%" height={13} />
                </>
              ) : (
                <>
                  {/*
                    E.164, and `dir="ltr"` deliberately. `supportConfig.whatsapp`
                    carries the schema note "shown LTR in both languages" — a
                    leading `+` inside an RTL run is reordered to the wrong end by
                    the bidi algorithm, so an Arabic console would print
                    "965 9008 4408+".
                  */}
                  <EditableText
                    label="WhatsApp number"
                    value={support.data.channels.whatsapp}
                    dir="ltr"
                    onCommit={(whatsapp) => updateChannels.mutate({ whatsapp })}
                  />
                  <EditableText
                    label="Support email"
                    value={support.data.channels.email}
                    dir="ltr"
                    onCommit={(email) => updateChannels.mutate({ email })}
                  />
                  <EditableText
                    label="Hours shown in the wallet"
                    value={support.data.channels.hoursEn}
                    onCommit={(hoursEn) => updateChannels.mutate({ hoursEn })}
                  />
                  <EditableText
                    label="Hours shown in the wallet · العربية"
                    value={support.data.channels.hoursAr}
                    lang="ar"
                    dir="rtl"
                    onCommit={(hoursAr) => updateChannels.mutate({ hoursAr })}
                  />
                  <EditableText
                    label="Reply-time promise"
                    value={support.data.channels.replyEn}
                    onCommit={(replyEn) => updateChannels.mutate({ replyEn })}
                  />
                  <EditableText
                    label="Reply-time promise · العربية"
                    value={support.data.channels.replyAr}
                    lang="ar"
                    dir="rtl"
                    onCommit={(replyAr) => updateChannels.mutate({ replyAr })}
                  />
                  {updateChannels.isError ? (
                    <WriteError
                      error={updateChannels.error}
                      reassurance="The wallet still shows what it had before."
                    />
                  ) : null}
                </>
              )}
            </div>

            <div className="support__topics">
              <div className="support__topichead">
                {/*
                  THE COUNT IS WITHHELD WHILE PENDING. `topics.length` on an
                  undefined list needs a `?? 0`, and "Topics · 0" beside a column
                  of skeletons announces an empty configuration the panel is not
                  painting — the sr-only-caption defect from both audit screens,
                  arriving here through a visible heading instead.
                */}
                <span className="avo-label">
                  {support.isPending ? 'Topics' : `Topics · ${support.data.topics.length}`}
                </span>
                <span className="support__note">
                  Routing decides whose queue a message lands in. Changing it moves the next
                  message, not the ones already sent.
                </span>
              </div>

              {support.isPending ? (
                <div className="support__topiclist">
                  <Skeleton height={62} />
                  <Skeleton height={62} />
                  <Skeleton height={62} />
                </div>
              ) : support.data.topics.length === 0 ? (
                /*
                 * Not reachable through this console any more — `DELETE` refuses
                 * the last active topic by name — but still reachable, because the
                 * read filters `active = true` and a table of retired rows arrives
                 * as an empty list rather than as an error. Kept, and it names what
                 * it costs: `POST /v1/support/tickets` needs a known active topic,
                 * so with none the wallet's form cannot be submitted at all.
                 */
                <p className="support__empty">
                  No active topics. The wallet&apos;s Contact us form has nothing to choose from,
                  and every message sent to it is refused.
                </p>
              ) : (
                <ul className="support__topiclist">
                  {support.data.topics.map((topic, index) => (
                    <TopicRow
                      key={topic.id}
                      topic={topic}
                      index={index}
                      count={support.data.topics.length}
                      onPatch={(patch) => updateTopic.mutate({ id: topic.id, ...patch })}
                      onRetire={() => retireTopic.mutate({ id: topic.id })}
                      busy={updateTopic.isPending || retireTopic.isPending}
                    />
                  ))}
                </ul>
              )}

              {/*
                ONE ERROR REGION FOR THE WHOLE LIST, not one per row. Every row
                shares the two mutations, so a per-row banner would be six copies
                of one answer — and the server's sentence already names the topic it
                refused ("This is the only topic left…").
              */}
              {updateTopic.isError ? (
                <WriteError error={updateTopic.error} reassurance="The topic is unchanged." />
              ) : null}
              {retireTopic.isError ? (
                <WriteError
                  error={retireTopic.error}
                  reassurance="It is still offered on the Contact us form."
                />
              ) : null}
              {addTopic.isError ? (
                <WriteError error={addTopic.error} reassurance="No topic was added." />
              ) : null}

              {support.isPending ? null : (
                <form
                  className="support__add"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const en = newTopic.trim();
                    if (en === '') return;
                    /*
                     * Cleared optimistically and only on a SUCCESSFUL add. A field
                     * emptied before the request lands loses the admin's wording on
                     * a refusal, which is the failure `WriteError`'s whole contract
                     * is about — "the screen is still showing what she typed".
                     */
                    addTopic.mutate({ en }, { onSuccess: () => setNewTopic('') });
                  }}
                >
                  <TextField
                    label="New topic (English)"
                    labelHidden
                    placeholder="New topic (English)"
                    value={newTopic}
                    onChange={(e) => setNewTopic(e.target.value)}
                  />
                  {/*
                    `en` ONLY — the API mints the id and appends to the end of the
                    active list, and the Arabic and the route are set afterwards
                    through the row above. That is the design's flow too: its
                    "+ Add topic" field takes English and nothing else. A new topic
                    therefore arrives AVO-routed and untranslated, and the row it
                    lands in says both.
                  */}
                  <Button type="submit" disabled={newTopic.trim() === '' || addTopic.isPending}>
                    {addTopic.isPending ? 'Adding…' : '+ Add topic'}
                  </Button>
                </form>
              )}
            </div>
          </div>

          <SupportQueue />
        </>
      )}
    </Card>
  );
}

/**
 * A field that holds its own draft and commits the difference on blur.
 *
 * WHY A DRAFT AT ALL. The value comes from the query cache, so a controlled input
 * bound straight to it cannot be typed into — every keystroke re-renders with the
 * server's string. The design hit the mirror image of this and wrote it down:
 * committing per keystroke "would push a new value back in from outside the React
 * event and throw the caret to the end of the field mid-word."
 *
 * THE DRAFT SURVIVES A FAILED WRITE. `dirty` is cleared when the server's value
 * catches up to the draft — not on blur — so a refused save leaves her text on
 * screen beside the `WriteError` that says it did not land. Clearing on blur would
 * silently restore the old value and make the banner a lie about what she is
 * looking at.
 *
 * AND IT YIELDS TO THE SERVER WHEN CLEAN. While `dirty` is false, an incoming
 * value replaces the draft, so a change made in another tab or a corrected value
 * from the API appears rather than being masked by a stale local copy.
 *
 * AN UNCOMMITTED EDIT SAYS SO, and that is the panel's one honest answer to a
 * problem the design solved differently. Its prototype calls `flushBuf()` at the
 * top of every other action — "belt-and-braces: a buffered edit is never lost when
 * the doc, language or publish button is clicked before blur lands." The obvious
 * port is a commit on unmount, and it is the wrong one HERE: this component also
 * unmounts when its topic is RETIRED, so a half-typed label would fire a PATCH at
 * a row that is on its way out and answer 409 `topic_retired` — a spurious refusal
 * caused by tidying up. Clicking any control in the panel already blurs the field
 * first, so the only real gap is navigating away mid-word, and for that a visible
 * "not saved yet" is worth more than a write the admin did not ask for. It also
 * keeps the panel's own promise ("saves as you type") from being quietly false for
 * one field.
 *
 * NO CLIENT-SIDE VALIDATION OF `en`. The API's `requireString` refuses an empty
 * one by name and `WriteError` renders that sentence; a second rule here would be
 * a copy of the server's that can drift from it. `ar` is blankable on purpose —
 * clearing a wrong translation has to be possible.
 */
function EditableText({
  label,
  value,
  onCommit,
  dir,
  lang,
}: {
  label: string;
  value: string;
  onCommit: (next: string) => void;
  dir?: 'ltr' | 'rtl';
  lang?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setDraft(value);
    else if (value === draft) setDirty(false);
  }, [value, draft, dirty]);

  const unsaved = dirty && draft !== value;

  return (
    <div className="support__channel">
      <TextField
        label={label}
        value={draft}
        {...(dir ? { dir } : {})}
        {...(lang ? { lang } : {})}
        /*
         * The marker rides on the label row, which is what `action` is for — the
         * design's own Show/Hide control sits there. Text and not a dot: #2 of the
         * interaction spec, and a colour alone cannot say "not saved yet".
         */
        {...(unsaved ? { action: <span className="support__unsaved">Not saved yet</span> } : {})}
        onChange={(e) => {
          setDraft(e.target.value);
          setDirty(true);
        }}
        onBlur={() => {
          if (draft !== value) onCommit(draft);
        }}
      />
    </div>
  );
}

/**
 * One topic: its two labels, the queue it resolves to, and where it sits.
 *
 * THE ROUTE IS A `Segmented` AND NOT A ROW OF BUTTONS. interaction-spec.md §2
 * gives segmented controls radiogroup semantics — "arrow keys move, Space/Enter
 * selects" — and @avo/ui's implementation is a real `role="radiogroup"` with a
 * roving tabindex. Six topics as pairs of plain buttons would be twelve tab stops
 * announcing nothing about which queue is current.
 *
 * THE ARROWS ARE DISABLED AT THE ENDS, and that is a boundary rather than a dead
 * control: the reason the first topic cannot move up is visible on screen. It is a
 * different thing from a button whose endpoint does not exist, which is what this
 * panel refused to draw while the writes were missing.
 *
 * RETIRE STAYS LIVE ON THE LAST TOPIC. `DELETE` answers 409 `last_topic` with a
 * sentence naming the fix — "add its replacement first" — and `WriteError` renders
 * it verbatim. Disabling the button instead would mean restating that rule here in
 * copy that can drift from the server's, and the server is the only place it is
 * enforced.
 */
function TopicRow({
  topic,
  index,
  count,
  onPatch,
  onRetire,
  busy,
}: {
  topic: SupportTopic;
  index: number;
  count: number;
  onPatch: (patch: { en?: string; ar?: string; route?: 'salon' | 'avo'; order?: number }) => void;
  onRetire: () => void;
  busy: boolean;
}) {
  return (
    <li className="support__topic">
      <div className="support__topiclabels">
        <EditableText label="Topic" value={topic.en} onCommit={(en) => onPatch({ en })} />
        {/*
          The Arabic label, and its placeholder is the design's own word for the
          gap. An empty value is legitimate — the wallet falls back to English for
          a document — but for a TOPIC it is not a fallback: the Contact us list
          renders the Arabic label, so an empty one is a blank row in the form.
        */}
        <EditableText
          label="Topic · العربية"
          value={topic.ar}
          lang="ar"
          dir="rtl"
          onCommit={(ar) => onPatch({ ar })}
        />
      </div>

      <div className="support__topicctl">
        <Segmented
          label={`Queue for "${topic.en}"`}
          value={topic.route}
          options={[
            { value: 'salon', label: 'Salon' },
            { value: 'avo', label: 'AVO' },
          ]}
          onChange={(route) => onPatch({ route })}
        />
        <div className="support__topicmove">
          {/*
            `index - 1` and `index + 1` into a DENSE list — positions come back
            `0…n-1` with no gaps, and the API clamps, so neither arrow can send an
            index the server has to reject.
          */}
          <IconButton
            label={`Move "${topic.en}" up`}
            glyph="↑"
            disabled={index === 0 || busy}
            onClick={() => onPatch({ order: index - 1 })}
          />
          <IconButton
            label={`Move "${topic.en}" down`}
            glyph="↓"
            disabled={index === count - 1 || busy}
            onClick={() => onPatch({ order: index + 1 })}
          />
          <IconButton
            label={`Retire "${topic.en}"`}
            glyph="✕"
            tone="danger"
            disabled={busy}
            onClick={onRetire}
          />
        </div>
      </div>
    </li>
  );
}

/**
 * The design's 28px square controls. A real `<button>` with an accessible name —
 * the glyph is `aria-hidden`, because "↑" announced on its own is not "move
 * Wallet, top-ups or refunds up".
 */
function IconButton({
  label,
  glyph,
  onClick,
  disabled,
  tone,
}: {
  label: string;
  glyph: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'danger';
}) {
  return (
    <button
      type="button"
      className="support__icon"
      data-tone={tone}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  );
}
